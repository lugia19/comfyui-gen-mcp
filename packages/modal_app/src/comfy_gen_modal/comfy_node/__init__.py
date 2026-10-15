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

Loaded by ComfyUI from custom_nodes/, where it can import `server`. The node's heavy imports
(torch, ultralytics, spandrel) are inside it: tests import this module without ComfyUI.
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


NODE_CLASS_MAPPINGS = {"ComfyGenRemoveMarks": ComfyGenRemoveMarks}
NODE_DISPLAY_NAME_MAPPINGS = {"ComfyGenRemoveMarks": "Remove signatures and watermarks (Comfy-Gen)"}


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
