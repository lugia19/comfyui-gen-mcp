"""ComfyUI extension installed in the Modal image and in the MCPB's local ComfyUI.

GET /comfy-gen/wait/{prompt_id}?timeout=S:

Holds the request until the prompt finishes or S seconds pass, then answers
{"state": "done", "status": ..., "outputs": ...}, {"state": "running"},
{"state": "pending", "position": n} or {"state": "unknown"}. The Worker waits with one held request
instead of polling /history and /queue: each request it makes costs it CPU, and a finished image is
seen at once instead of at the next poll. Clients fall back to polling on a 404, so a ComfyUI
without this extension still works.

Parent watchdog: with COMFY_GEN_PARENT_PID set (the MCPB sets it), ComfyUI exits when that process
is gone. Claude Desktop may end the extension without a chance to stop its ComfyUI (on Windows a
killed process leaves its children running), which would otherwise hold the GPU until reboot.

ComfyGenRemoveMarks (node): finds the signatures and watermarks some artist styles paint into an
image (a YOLO detector, models/comfy_gen/MARK_DETECTOR) and fills each one with LaMa
(models/comfy_gen/MARK_INPAINTER) at full resolution: a crop around the mark, the mark grown a
little as the hole, pasted back with a soft edge. An image with no mark comes back as it was; a
missing package or model file, or any error, passes the image through with a log line, so a
generation never fails over it. The packs' workflows get it before their SaveImage when the
remove_marks setting is on (core packs.ts).

ComfyGenRedrawRegion and ComfyGenRedrawPaste (nodes): the redraw tool (core workflow.ts
redrawWorkflow). The first picks what to repaint (a caller's box, or the largest face the anime face
detector finds, models/comfy_gen/FACE_DETECTOR, run by onnxruntime), builds its soft mask, and hands
the sampler the whole image (the prompt describes all of it); the second puts the result back
through the mask, so every other pixel stays as it was and the image keeps its size and
transparency.

Loaded by ComfyUI from custom_nodes/, where it can import `server`. The nodes' heavy imports
(torch, ultralytics, spandrel, onnxruntime) are inside them: tests import this module without ComfyUI.
"""

import asyncio
import logging
import os
import sys
import threading
import time

MAX_WAIT_S = 120
CHECK_EVERY_S = 0.25


def job_state(queue, prompt_id: str) -> dict:
    """The prompt's state from ComfyUI's PromptQueue. The queue is read before the history: a job
    leaves the running set and enters the history under one lock, so it is always seen in one."""
    running, pending = queue.get_current_queue_volatile()
    if any(len(item) > 1 and item[1] == prompt_id for item in running):
        return {"state": "running"}
    ordered = sorted(pending, key=lambda item: item[0])
    for position, item in enumerate(ordered, 1):
        if len(item) > 1 and item[1] == prompt_id:
            return {"state": "pending", "position": position}
    entry = queue.get_history(prompt_id=prompt_id).get(prompt_id)
    if entry is None:
        return {"state": "unknown"}
    return {"state": "done", "status": entry.get("status"), "outputs": entry.get("outputs", {})}


async def wait_for(queue, prompt_id: str, timeout: float) -> dict:
    deadline = time.monotonic() + min(max(timeout, 0.0), MAX_WAIT_S)
    while True:
        state = job_state(queue, prompt_id)
        if state["state"] in ("done", "unknown") or time.monotonic() >= deadline:
            return state
        await asyncio.sleep(CHECK_EVERY_S)


def pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)  # POSIX only: on Windows this would terminate the process
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def watch_parent(pid: int, alive=pid_alive, every_s: float = 1.0, exit=os._exit) -> None:
    """Exit the process once *pid* is gone. Blocks; run it in a daemon thread. Every second: the
    check costs next to nothing, and on Linux Claude Desktop ends the extension without a signal it
    can catch, so this is how its ComfyUI stops (it took up to 5 s, checking every 5)."""
    while alive(pid):
        time.sleep(every_s)
    # Straight to the file descriptor: ComfyUI wraps sys.stdout in its log interceptor, whose buffer
    # os._exit would drop (seen live: the line never reached comfyui.log).
    try:
        os.write(sys.__stdout__.fileno() if sys.__stdout__ else 1, f"[comfy-gen] parent process {pid} is gone; exiting\n".encode())
    except OSError:
        pass
    exit(0)


def _start_watchdog() -> None:
    pid = os.environ.get("COMFY_GEN_PARENT_PID", "")
    if pid.isdigit():
        threading.Thread(target=watch_parent, args=(int(pid),), daemon=True, name="comfy-gen-watchdog").start()


def _register() -> None:
    from aiohttp import web
    from server import PromptServer

    server = PromptServer.instance

    @server.routes.get("/comfy-gen/wait/{prompt_id}")
    async def wait(request):
        try:
            timeout = float(request.query.get("timeout", "0"))
        except ValueError:
            return web.json_response({"error": "timeout must be a number"}, status=400)
        return web.json_response(await wait_for(server.prompt_queue, request.match_info["prompt_id"], timeout))


# ── Removing signatures and watermarks ──────────────────────────────────────────────────────────

MARK_DETECTOR = "mimilens_y26l.pt"  # MimiLens YOLO26 (huggingface.co/Minthy/MimiLens-Models)
MARK_INPAINTER = "big-lama.pt"  # LaMa, TorchScript, loaded by spandrel
MARK_FOLDER = "comfy_gen"  # models/comfy_gen, or the extra_model_paths key of that name
MARK_LABELS = ("watermark", "signature")  # not text or speech bubbles: those may belong in the image
# The hole: the box grown by this many pixels, or this share of its longer side, whichever is more
# (strokes run past the box, more so on bigger marks), out to the image's edge when within EDGE of it.
GROW_MIN, GROW_SHARE, EDGE = 8, 0.12, 24
FEATHER = 6  # the pasted fill's soft edge, in pixels
# A box bigger than this share of the image is not a mark: the largest real one seen was about 1%,
# the one false find (at 0.14) about 19%, which would have repainted most of the image's bottom.
MAX_SHARE = 0.1


def mark_sized(box, width, height):
    """Whether box [x0, y0, x1, y1] is small enough to be a signature or watermark."""
    x0, y0, x1, y1 = box
    return (x1 - x0) * (y1 - y0) <= MAX_SHARE * width * height


def merge_boxes(boxes):
    """Boxes [x0, y0, x1, y1] that overlap or touch, joined: one mark found twice is filled once."""
    out = [list(b) for b in boxes]
    merged = True
    while merged:
        merged = False
        for i in range(len(out)):
            for j in range(i + 1, len(out)):
                a, b = out[i], out[j]
                if a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]:
                    out[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                    del out[j]
                    merged = True
                    break
            if merged:
                break
    return out


def hole_box(box, width, height):
    """The area to fill for a mark's box: grown, clipped to the image, and taken to an edge it nearly
    touches (a signature in a corner often runs off it)."""
    x0, y0, x1, y1 = box
    g = max(GROW_MIN, int(GROW_SHARE * max(x1 - x0, y1 - y0)))
    x0, y0, x1, y1 = max(0, x0 - g), max(0, y0 - g), min(width, x1 + g), min(height, y1 + g)
    x0, y0 = (0 if x0 < EDGE else x0), (0 if y0 < EDGE else y0)
    x1, y1 = (width if width - x1 < EDGE else x1), (height if height - y1 < EDGE else y1)
    return [int(x0), int(y0), int(x1), int(y1)]


def crop_box(hole, width, height):
    """The crop LaMa sees around a hole: the hole and as much again around it (at least 48 px), so
    the fill has the surroundings to continue from, clipped to the image."""
    x0, y0, x1, y1 = hole
    m = max(48, (x1 - x0 + y1 - y0) // 2)
    return [max(0, x0 - m), max(0, y0 - m), min(width, x1 + m), min(height, y1 + m)]


_mark_models = {}


def _mark_model(kind):
    """The detector ("detect") or LaMa ("fill"), loaded once."""
    if kind not in _mark_models:
        import folder_paths

        path = folder_paths.get_full_path(MARK_FOLDER, MARK_DETECTOR if kind == "detect" else MARK_INPAINTER)
        if not path:
            raise FileNotFoundError(f"models/{MARK_FOLDER}/{MARK_DETECTOR if kind == 'detect' else MARK_INPAINTER} is missing")
        if kind == "detect":
            from ultralytics import YOLO

            _mark_models[kind] = YOLO(path)
        else:
            import comfy.model_management
            from spandrel import ModelLoader

            model = ModelLoader().load_from_file(path).model.eval()
            _mark_models[kind] = model.to(comfy.model_management.get_torch_device())
    return _mark_models[kind]


def _fill(image, holes):
    """*image* (H, W, C float tensor, 0-1) with each hole filled by LaMa, at full resolution."""
    import comfy.model_management
    import torch
    import torch.nn.functional as F

    lama = _mark_model("fill")
    device = comfy.model_management.get_torch_device()
    out = image.clone()
    height, width = image.shape[:2]
    for hole in holes:
        cx0, cy0, cx1, cy1 = crop_box(hole, width, height)
        crop = out[cy0:cy1, cx0:cx1].permute(2, 0, 1)[None, :3].to(device)
        mask = torch.zeros(1, 1, cy1 - cy0, cx1 - cx0, device=device)
        mask[..., hole[1] - cy0 : hole[3] - cy0, hole[0] - cx0 : hole[2] - cx0] = 1
        # LaMa wants sides in multiples of 8: pad (repeating the border), fill, cut the padding off.
        ph, pw = -crop.shape[2] % 8, -crop.shape[3] % 8
        with torch.no_grad():
            filled = lama(F.pad(crop, (0, pw, 0, ph), mode="replicate"), F.pad(mask, (0, pw, 0, ph)))
        filled = filled[..., : crop.shape[2], : crop.shape[3]].clamp(0, 1)
        r = FEATHER // 2  # a soft edge: the hole grown by r, then blurred over r
        soft = F.max_pool2d(mask, 2 * r + 1, stride=1, padding=r)
        soft = F.avg_pool2d(F.avg_pool2d(soft, 2 * r + 1, stride=1, padding=r, count_include_pad=False), 2 * r + 1, stride=1, padding=r, count_include_pad=False)
        mixed = crop * (1 - soft) + filled * soft
        out[cy0:cy1, cx0:cx1, :3] = mixed[0].permute(1, 2, 0).to(out.device, out.dtype)
    return out


def remove_marks(images, threshold):
    """The batch (B, H, W, C float tensor) with the signatures and watermarks found in each filled."""
    import comfy.model_management
    import numpy as np
    import torch
    from PIL import Image

    detector = _mark_model("detect")
    device = str(comfy.model_management.get_torch_device())
    out = []
    for image in images:
        height, width = image.shape[:2]
        rgb = Image.fromarray((image[..., :3].cpu().numpy() * 255).round().astype(np.uint8))
        found = detector.predict(rgb, conf=threshold, device=device, verbose=False)[0]
        boxes = [[int(v) for v in b] for c, b in zip(found.boxes.cls.tolist(), found.boxes.xyxy.tolist()) if found.names[int(c)] in MARK_LABELS]
        boxes = [b for b in boxes if mark_sized(b, width, height)]
        if not boxes:
            out.append(image)
            continue
        holes = merge_boxes([hole_box(b, width, height) for b in boxes])
        logging.info(f"[comfy-gen] removing {len(holes)} signature/watermark area(s)")
        out.append(_fill(image, holes))
    return torch.stack(out)


class ComfyGenRemoveMarks:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "threshold": ("FLOAT", {"default": 0.2, "min": 0.05, "max": 0.95, "step": 0.05})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "comfy-gen"

    def run(self, images, threshold=0.2):
        try:
            return (remove_marks(images, threshold),)
        except Exception as e:  # never fail a generation over this: the image as it was
            logging.warning(f"[comfy-gen] signature/watermark removal skipped: {type(e).__name__}: {e}")
            return (images,)


# ── Redrawing part of an image ─────────────────────────────────────────────────────────────────

FACE_DETECTOR = "face_detect_v1.4_s.onnx"  # deepghs/anime_face_detection v1.4 s (YOLOv8, MIT), in MARK_FOLDER
FACE_SIZE, FACE_CONF, FACE_IOU = 640, 0.3, 0.5
FACE_GROW = 1.2  # a found face, grown: the redrawn ellipse takes in the chin and the fringe
# A caller's box, grown: an estimated box need not be exact, and the model needs room to draw the
# thing whole (a knight's hand at 1.15 was mostly left out; 1.5 drew it in 6 of 8 tries, 2 redrew
# too much around it).
BOX_GROW = 1.5
DEFAULT_PIXELS = 1024 * 1024
# The mask's soft edge (Gaussian sigma): this share of the grown area's shorter side. DifferentialDiffusion
# already eases the repaint into the edge; 0.08 left the knight's new hand half see-through.
FEATHER_SHARE = 0.04
ROUND_SHARE = 0.2  # a box's corner radius: this share of its shorter side
SIDE_STEP = 16  # sampled sides are multiples of this (the latent's 8, times the model's 2x2 patches)
NO_FACE = "No face found in this image: pass a box around it instead."


def parse_box(text, width, height):
    """A caller's box, "left,top,right,bottom" fractions of the image, in pixels; None for "" (the
    largest face)."""
    text = (text or "").strip()
    if not text:
        return None
    parts = [float(v) for v in text.split(",")]
    if len(parts) != 4:
        raise ValueError(f"box must be 4 numbers, got {text!r}")
    l, t, r, b = (min(1.0, max(0.0, v)) for v in parts)
    if r <= l or b <= t:
        raise ValueError(f"box {text!r} is empty: left < right and top < bottom")
    return [l * width, t * height, r * width, b * height]


def grow(box, factor):
    """*box* scaled by *factor* about its centre."""
    x0, y0, x1, y1 = box
    cx, cy, hw, hh = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) * factor / 2, (y1 - y0) * factor / 2
    return [cx - hw, cy - hh, cx + hw, cy + hh]


def sample_size(width, height, pixels):
    """(w, h) to sample a *width* x *height* image at: its own size, or *pixels* in area when it is
    bigger, the sides rounded to multiples of SIDE_STEP."""
    s = min(1.0, (pixels / (width * height)) ** 0.5)
    return tuple(max(SIDE_STEP, round(side * s / SIDE_STEP) * SIDE_STEP) for side in (width, height))


def shape_mask(height, width, box, ellipse):
    """A (height, width) float mask: 1 inside *box* (an ellipse, else a rounded rectangle), its edge
    blurred by FEATHER_SHARE of the box's shorter side."""
    import torch
    import torch.nn.functional as F

    x0, y0, x1, y1 = box
    cx, cy, hw, hh = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
    ys = torch.arange(height, dtype=torch.float32)[:, None] + 0.5
    xs = torch.arange(width, dtype=torch.float32)[None, :] + 0.5
    if ellipse:
        inside = ((xs - cx) / hw) ** 2 + ((ys - cy) / hh) ** 2 <= 1
    else:
        r = ROUND_SHARE * min(hw, hh) * 2
        dx = ((xs - cx).abs() - (hw - r)).clamp(min=0)
        dy = ((ys - cy).abs() - (hh - r)).clamp(min=0)
        inside = dx**2 + dy**2 <= r**2
    mask = inside.float()
    sigma = FEATHER_SHARE * min(hw, hh) * 2
    if sigma < 0.5:
        return mask
    k = int(3 * sigma)
    g = torch.exp(-(torch.arange(-k, k + 1, dtype=torch.float32) ** 2) / (2 * sigma**2))
    g = (g / g.sum())[None, None]
    m = mask[None, None]
    m = F.conv2d(F.pad(m, (k, k, 0, 0), mode="replicate"), g[..., None, :])
    m = F.conv2d(F.pad(m, (0, 0, k, k), mode="replicate"), g[..., :, None])
    return m[0, 0].clamp(0, 1)


def resize(images, width, height):
    """A (B, H, W, C) batch resized to *width* x *height* (bicubic, antialiased when shrinking)."""
    import torch.nn.functional as F

    out = F.interpolate(images.movedim(-1, 1), size=(height, width), mode="bicubic", antialias=True, align_corners=False)
    return out.movedim(1, -1).clamp(0, 1)


def face_boxes(output, scale, conf=FACE_CONF):
    """Face boxes [x0, y0, x1, y1] in source pixels from the detector's (5, N) output (centre x,
    centre y, width, height at the letterboxed size, score), largest first."""
    import torch
    from torchvision.ops import nms

    out = torch.as_tensor(output, dtype=torch.float32)
    keep = out[4] >= conf
    cx, cy, w, h, score = out[:, keep]
    boxes = torch.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], dim=1) / scale
    boxes = boxes[nms(boxes, score, FACE_IOU)]
    area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    return boxes[area.argsort(descending=True)].tolist()


_face_session = []


def largest_face(image):
    """The largest face in *image* (H, W, C float tensor), [x0, y0, x1, y1] in pixels; raises
    ValueError(NO_FACE) when there is none."""
    import numpy as np

    if not _face_session:
        import folder_paths
        import onnxruntime

        path = folder_paths.get_full_path(MARK_FOLDER, FACE_DETECTOR)
        if not path:
            raise FileNotFoundError(f"models/{MARK_FOLDER}/{FACE_DETECTOR} is missing")
        _face_session.append(onnxruntime.InferenceSession(path, providers=["CPUExecutionProvider"]))
    height, width = image.shape[:2]
    scale = FACE_SIZE / max(width, height)
    small = resize(image[None, ..., :3], max(1, round(width * scale)), max(1, round(height * scale)))[0]
    board = np.full((FACE_SIZE, FACE_SIZE, 3), 114 / 255, dtype=np.float32)  # letterboxed, YOLO's grey
    board[: small.shape[0], : small.shape[1]] = small.cpu().numpy()
    output = _face_session[0].run(None, {"images": board.transpose(2, 0, 1)[None]})[0][0]
    boxes = face_boxes(output, scale)
    if not boxes:
        raise ValueError(NO_FACE)
    return boxes[0]


def redraw_region(image, box_text, max_pixels):
    """(sample, mask, region) for the first image of a batch: the image to sample (all of it, scaled
    down to *max_pixels* if over), its mask, and what ComfyGenRedrawPaste needs to put the result
    back."""
    import torch

    height, width = image.shape[1:3]
    box = parse_box(box_text, width, height)
    face = box is None
    box = grow(largest_face(image[0]) if face else box, FACE_GROW if face else BOX_GROW)
    full = shape_mask(height, width, box, ellipse=face)
    sw, sh = sample_size(width, height, max_pixels)
    sample = resize(image[:1, ..., :3], sw, sh)
    mask = resize(full[None, ..., None], sw, sh)[..., 0]
    return sample, mask, {"mask": full.to(torch.float32)}


def redraw_paste(original, redrawn, region, alpha=None):
    """*original* with *redrawn* blended in through the region's mask: every pixel outside it as it
    was, the output the original's size. A source with transparency (LoadImage's mask, 1 where
    transparent) gets its alpha back."""
    import torch

    out = original[:1, ..., :3].clone()
    part = resize(redrawn[:1, ..., :3].to(out), out.shape[2], out.shape[1])
    m = region["mask"][..., None].to(out)
    out = out * (1 - m) + part * m
    if alpha is not None and tuple(alpha.shape[-2:]) == tuple(out.shape[1:3]) and float(alpha.max()) > 0:
        out = torch.cat([out, (1 - alpha[:1, ..., None]).to(out)], dim=-1)
    return out


class ComfyGenRedrawRegion:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "box": ("STRING", {"default": ""}),
                "max_pixels": ("INT", {"default": DEFAULT_PIXELS, "min": 65536, "max": 16777216}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "CG_REGION")
    RETURN_NAMES = ("sample", "mask", "region")
    FUNCTION = "run"
    CATEGORY = "comfy-gen"

    def run(self, image, box="", max_pixels=DEFAULT_PIXELS):
        return redraw_region(image, box, max_pixels)


class ComfyGenRedrawPaste:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"original": ("IMAGE",), "redrawn": ("IMAGE",), "region": ("CG_REGION",)}, "optional": {"alpha": ("MASK",)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "comfy-gen"

    def run(self, original, redrawn, region, alpha=None):
        return (redraw_paste(original, redrawn, region, alpha),)


NODE_CLASS_MAPPINGS = {
    "ComfyGenRemoveMarks": ComfyGenRemoveMarks,
    "ComfyGenRedrawRegion": ComfyGenRedrawRegion,
    "ComfyGenRedrawPaste": ComfyGenRedrawPaste,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ComfyGenRemoveMarks": "Remove signatures and watermarks (Comfy-Gen)",
    "ComfyGenRedrawRegion": "Redraw: region and mask (Comfy-Gen)",
    "ComfyGenRedrawPaste": "Redraw: paste back (Comfy-Gen)",
}


def _register_mark_folder() -> None:
    """models/comfy_gen as a model folder, besides any path extra_model_paths.yaml gives it."""
    import folder_paths

    folder_paths.add_model_folder_path(MARK_FOLDER, os.path.join(folder_paths.models_dir, MARK_FOLDER))


try:
    import server as _comfy_server  # noqa: F401  (only importable inside ComfyUI)
except ImportError:
    pass
else:
    _register()
    _register_mark_folder()
    _start_watchdog()
