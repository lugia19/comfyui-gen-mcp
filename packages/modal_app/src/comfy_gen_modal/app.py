"""ComfyUI on Modal, in the user's workspace (design §2, S5).

- Comfy: ComfyUI's own HTTP API on an L4, behind proxy auth, plus our /comfy-gen/wait route
  (comfy_node/). The Worker is its only client.
- seed: downloads a pack's model files onto the Volume (a CPU container, not the GPU).
- admin: a small proxy-auth'd API for the Worker: start a seed, read its progress, set keep-warm.

The Volume holds models, input and output, so uploads and earlier outputs survive scale-to-zero
(S5 a–c). A warm ComfyUI only sees files written by other containers after volume.reload(), which
fails while files are open. ComfyUI keeps model files open even after /free (seen live, S5 d), so
when a seed asks and ComfyUI is idle, the server restarts the ComfyUI process around the reload:
about 15 s, instead of a cold start.

Deployed by deploy.py inside a Workers Build: `python -m modal deploy -m comfy_gen_modal.app`.
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import threading
import time
import urllib.request

import modal

from comfy_gen_modal.models import (
    INPUT_DIR, MODELS_DIR, OUTPUT_DIR, SUBFOLDERS, VOL, needed, rel_path, validate_models, validate_pack_name,
)

APP_NAME = "comfy-gen"
SERVER_NAME = "comfy"
VOLUME_NAME = "comfy-gen-data"
STATE_DICT = "comfy-gen-state"  # seed progress, reload requests, the proxy token (deploy.py)

COMFY_PORT = 8188
KEEP_WARM_S = 300  # the default keep_warm_minutes; the Worker applies the user's setting via /idle
RELOAD_POLL_S = 10
USER_AGENT = "comfy-gen-seed"

COMFY_DIR = "/root/comfy/ComfyUI"  # where comfy-cli installs it
COMFY_NODE_SRC = os.path.join(os.path.dirname(__file__), "comfy_node")  # our /comfy-gen/wait route

EXTRA_PATHS = "comfy_gen:\n  base_path: " + MODELS_DIR + "\n" + "".join(f"  {s}: {s}\n" for s in SUBFOLDERS)

app = modal.App(APP_NAME)
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
state = modal.Dict.from_name(STATE_DICT, create_if_missing=True)

comfy_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")
    .pip_install("comfy-cli==1.21.0")
    .run_commands("comfy --skip-prompt install --nvidia --version 0.37.0")
    # The one custom node pack the product supports on Modal. `comfy node install` needs
    # ComfyUI-Manager; registry-install talks to the Comfy Registry directly (the id is mixed-case).
    .run_commands("comfy node registry-install ComfyUI-GGUF")
    .pip_install("gguf>=0.13.0", "sentencepiece", "protobuf")
    .add_local_dir(COMFY_NODE_SRC, f"{COMFY_DIR}/custom_nodes/comfy-gen")
    .add_local_python_source("comfy_gen_modal")
)

admin_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi[standard]")
    .add_local_python_source("comfy_gen_modal")
)


# ── ComfyUI ────────────────────────────────────────────────────────────────────


def _comfy_busy() -> bool:
    with urllib.request.urlopen(f"http://127.0.0.1:{COMFY_PORT}/queue", timeout=30) as r:
        queue = json.load(r)
    return bool(queue.get("queue_running") or queue.get("queue_pending"))


_proc: subprocess.Popen | None = None


def _launch() -> None:
    global _proc
    _proc = subprocess.Popen(
        f"comfy launch -- --listen 0.0.0.0 --port {COMFY_PORT} "
        f"--input-directory {INPUT_DIR} --output-directory {OUTPUT_DIR} "
        "--extra-model-paths-config /root/extra_model_paths.yaml",
        shell=True, start_new_session=True,  # its own process group: comfy launch starts a child
    )


def _stop() -> None:
    os.killpg(_proc.pid, signal.SIGTERM)
    try:
        _proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        os.killpg(_proc.pid, signal.SIGKILL)
        _proc.wait()


def _reload() -> str:
    """Make files other containers committed visible here. Commit first: a reload may drop
    uncommitted changes, and ComfyUI's outputs and uploads are exactly that."""
    try:
        volume.commit()
        volume.reload()
        return "reloaded"
    except RuntimeError:  # "open files preventing the operation": ComfyUI holds model files
        _stop()
        try:
            volume.commit()
            volume.reload()
        finally:
            _launch()
        return "restarted ComfyUI"


def _watch_reloads(started: float) -> None:
    """Reload the Volume when a seed asks and ComfyUI is idle. A request is a timestamp, so nothing
    needs clearing and a request that lands mid-reload is not lost."""
    done_upto = started  # the Volume was mounted fresh at start
    while True:
        time.sleep(RELOAD_POLL_S)
        try:
            requested = state.get("reload_requested_at") or 0
            if requested <= done_upto:
                continue
            if _comfy_busy():
                continue
        except Exception:  # ComfyUI still booting, or a Dict hiccup: look again next poll
            continue
        try:
            t = time.monotonic()
            how = _reload()
            state["reload"] = {"at": time.time(), "ok": True, "how": how, "seconds": round(time.monotonic() - t, 2)}
        except Exception as e:  # the next cold start sees the files anyway
            state["reload"] = {"at": time.time(), "ok": False, "error": f"{type(e).__name__}: {e}"}
        done_upto = requested


@app.server(
    image=comfy_image,
    gpu="L4",
    volumes={VOL: volume},
    port=COMFY_PORT,
    name=SERVER_NAME,
    scaledown_window=KEEP_WARM_S,
    # One container: without target_concurrency a Server does not autoscale. max_containers=1
    # would also stop a redeploy from starting the replacement before the old one goes.
    startup_timeout=300,
)
class Comfy:
    @modal.enter()
    def start(self):
        for d in [f"{MODELS_DIR}/{s}" for s in SUBFOLDERS] + [INPUT_DIR, OUTPUT_DIR]:
            os.makedirs(d, exist_ok=True)
        with open("/root/extra_model_paths.yaml", "w") as fh:
            fh.write(EXTRA_PATHS)
        _launch()
        threading.Thread(target=_watch_reloads, args=(time.time(),), daemon=True).start()

    @modal.exit()
    def stop(self):
        # Modal documents automatic commits for Functions, not Servers: commit outputs and uploads.
        volume.commit()


# ── seeding ────────────────────────────────────────────────────────────────────


def _present(models: list[dict]) -> dict[str, int]:
    sizes = {}
    for m in models:
        path = f"{MODELS_DIR}/{rel_path(m)}"
        if os.path.exists(path):
            sizes[rel_path(m)] = os.path.getsize(path)
    return sizes


def _download(m: dict, part_suffix: str, on_bytes) -> None:
    path = f"{MODELS_DIR}/{rel_path(m)}"
    part = f"{path}.part-{part_suffix}"  # per pack: two packs may fetch a shared file at once
    os.makedirs(os.path.dirname(path), exist_ok=True)
    digest = hashlib.sha256()
    req = urllib.request.Request(m["url"], headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r, open(part, "wb") as out:
        while chunk := r.read(8 << 20):
            out.write(chunk)
            digest.update(chunk)
            on_bytes(len(chunk))
    if m.get("sha256") and digest.hexdigest() != m["sha256"]:
        os.remove(part)
        raise ValueError(f"{m['filename']}: checksum mismatch")
    os.replace(part, path)


# Seeds run in parallel. Two packs may fetch a shared file at once; each writes a complete .part and
# renames it, so whichever commit lands last leaves the same complete file.
@app.function(image=admin_image, volumes={VOL: volume}, timeout=3 * 3600, cpu=2.0)
def seed(pack: str, models: list[dict]) -> None:
    key = f"seed:{pack}"
    volume.reload()
    todo = needed(models, _present(models))
    progress = {"state": "downloading", "done": 0, "total": sum(m.get("size_bytes") or 0 for m in todo)}
    last = 0.0

    def on_bytes(n: int) -> None:
        nonlocal last
        progress["done"] += n
        if time.monotonic() - last > 2:
            state[key] = {**progress, "updated": time.time()}
            last = time.monotonic()

    try:
        state[key] = {**progress, "updated": time.time()}
        for m in todo:
            _download(m, pack, on_bytes)
            volume.commit()
        state[key] = {"state": "done", "done": progress["total"], "total": progress["total"], "updated": time.time()}
        if todo:
            state["reload_requested_at"] = time.time()
    except Exception as e:
        state[key] = {**progress, "state": "failed", "error": f"{type(e).__name__}: {e}", "updated": time.time()}
        raise


# ── admin API (the Worker's) ───────────────────────────────────────────────────

STALE_S = 120  # a "downloading" entry not updated for this long is a dead seed; allow a new one


@app.function(image=admin_image, volumes={VOL: volume}, timeout=120)
@modal.asgi_app(requires_proxy_auth=True)
def admin():
    from fastapi import Body, FastAPI, HTTPException

    api = FastAPI()

    @api.post("/seed")
    async def start_seed(body: dict = Body(...)):
        try:
            pack = validate_pack_name(body.get("pack"))
            models = validate_models(body.get("models"))
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        key = f"seed:{pack}"
        current = await state.get.aio(key) or {}
        busy = current.get("state") in ("queued", "downloading")
        if busy and time.time() - current.get("updated", 0) < STALE_S:
            return {"started": False, **current}
        entry = {"state": "queued", "done": 0, "total": sum(m.get("size_bytes") or 0 for m in models), "updated": time.time()}
        await state.put.aio(key, entry)
        await seed.spawn.aio(pack, models)
        return {"started": True, **entry}

    @api.get("/seed/{pack}")
    async def seed_status(pack: str):
        try:
            validate_pack_name(pack)
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        return await state.get.aio(f"seed:{pack}") or {"state": "missing"}

    @api.get("/status")
    async def status():
        """Diagnostics: the watcher's last Volume reload."""
        return {"reload": await state.get.aio("reload"), "reload_requested_at": await state.get.aio("reload_requested_at")}

    @api.get("/files")
    async def files():
        """Diagnostics: model files on the Volume, with sizes."""
        await volume.reload.aio()
        out = {}
        for sub in SUBFOLDERS:
            d = f"{MODELS_DIR}/{sub}"
            for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
                out[f"{sub}/{name}"] = os.path.getsize(f"{d}/{name}")
        return out

    @api.post("/idle")
    async def set_idle(body: dict = Body(...)):
        seconds = body.get("seconds")
        if not isinstance(seconds, int) or not 60 <= seconds <= 3600:
            raise HTTPException(400, "seconds must be an integer from 60 to 3600")
        server = modal.Server.from_name(APP_NAME, SERVER_NAME)
        await server.update_autoscaler.aio(scaledown_window=seconds)
        return {"seconds": seconds}

    return api
