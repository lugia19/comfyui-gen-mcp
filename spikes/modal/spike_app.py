"""Spike S5: ComfyUI on Modal with input and output folders on the Volume.

Questions this answers (driven by drive.py, see ../README.md):
  a. Do outputs written by ComfyUI survive the container scaling to zero?
  b. Can a later container edit a prior output by name (LoadImage "<name> [output]")?
  c. Do uploaded inputs (/upload/image) survive a scale-to-zero?
  d. Does a warm ComfyUI see a LoRA written to the Volume by another container, with and without a
     periodic volume.reload() in the server container?
  e. Can a function call update_autoscaler on the Server (the "keep warm" setting)?
  f. Does an admin web endpoint behind proxy auth work for seeding and uploads?

No models are needed: the test workflows use EmptyImage / LoadImage / ImageInvert / SaveImage,
which are core ComfyUI nodes. The GPU is kept (L4) so cold-start timings are realistic.

Deploy:   modal deploy spike_app.py
Reload variant for (d):   SPIKE_RELOAD_S=10 modal deploy spike_app.py
Cleanup:  modal app stop comfy-gen-spike && modal volume delete comfy-gen-spike-vol
"""

import os
import subprocess
import threading
import time

import modal

APP_NAME = "comfy-gen-spike"
SERVER_NAME = "comfy"
VOLUME_NAME = "comfy-gen-spike-vol"
PROGRESS_DICT = "comfy-gen-spike-seed"

COMFY_PORT = 8188
VOL = "/vol"
MODELS_DIR = f"{VOL}/models"
INPUT_DIR = f"{VOL}/input"
OUTPUT_DIR = f"{VOL}/output"
IDLE_S = 60

# Read at deploy time and baked into the container env.
RELOAD_S = int(os.environ.get("SPIKE_RELOAD_S", "0"))

EXTRA_PATHS = f"""spike:
  base_path: {MODELS_DIR}
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
  loras: loras
"""

app = modal.App(APP_NAME)
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
progress = modal.Dict.from_name(PROGRESS_DICT, create_if_missing=True)

comfy_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")
    .pip_install("comfy-cli==1.21.0")
    .run_commands("comfy --skip-prompt install --nvidia --version 0.37.0")
    # The one custom node the product supports on Modal. Installed here to prove it builds.
    .run_commands("comfy node install ComfyUI-GGUF")
    .env({"SPIKE_RELOAD_S": str(RELOAD_S)})
)

admin_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]")


@app.server(
    image=comfy_image,
    gpu="L4",
    volumes={VOL: volume},
    port=COMFY_PORT,
    name=SERVER_NAME,
    scaledown_window=IDLE_S,
    max_containers=1,
    startup_timeout=300,
)
class Comfy:
    @modal.enter()
    def start(self):
        for d in (MODELS_DIR + "/loras", INPUT_DIR, OUTPUT_DIR):
            os.makedirs(d, exist_ok=True)
        with open("/root/extra_model_paths.yaml", "w") as fh:
            fh.write(EXTRA_PATHS)
        subprocess.Popen(
            f"comfy launch -- --listen 0.0.0.0 --port {COMFY_PORT} "
            f"--input-directory {INPUT_DIR} --output-directory {OUTPUT_DIR} "
            "--extra-model-paths-config /root/extra_model_paths.yaml",
            shell=True,
        )
        reload_s = int(os.environ.get("SPIKE_RELOAD_S", "0"))
        if reload_s:
            threading.Thread(target=self._reload_loop, args=(reload_s,), daemon=True).start()

    def _reload_loop(self, every: int):
        while True:
            time.sleep(every)
            t = time.monotonic()
            try:
                volume.reload()
                print(f"[spike] volume.reload ok in {time.monotonic() - t:.2f}s", flush=True)
            except Exception as e:  # e.g. refused while files are open
                print(f"[spike] volume.reload failed: {type(e).__name__}: {e}", flush=True)

    @modal.exit()
    def stop(self):
        # Outputs are written by ComfyUI into the Volume; make sure they are committed on the way
        # down. Question (a) is whether this is enough.
        t = time.monotonic()
        volume.commit()
        print(f"[spike] volume.commit on exit took {time.monotonic() - t:.2f}s", flush=True)


@app.function(image=admin_image, volumes={VOL: volume}, timeout=3600, cpu=1.0)
def seed(key: str, url: str, subfolder: str, filename: str) -> None:
    """Download one file into the Volume, reporting progress through a Dict (question f)."""
    import urllib.request

    path = f"{MODELS_DIR}/{subfolder}/{filename}"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    done, last = 0, 0.0
    with urllib.request.urlopen(url, timeout=120) as r, open(path + ".part", "wb") as out:
        total = int(r.headers.get("Content-Length") or 0) or 1
        progress[key] = {"done": 0, "total": total}
        while chunk := r.read(8 << 20):
            out.write(chunk)
            done += len(chunk)
            if time.monotonic() - last > 1:
                progress[key] = {"done": done, "total": total}
                last = time.monotonic()
    os.replace(path + ".part", path)
    volume.commit()
    progress[key] = {"done": done, "total": done}


@app.function(image=admin_image, volumes={VOL: volume}, timeout=600)
@modal.asgi_app(requires_proxy_auth=True)
def admin():
    """Small admin API next to ComfyUI. The Worker would call this for seeding and LoRA uploads."""
    from fastapi import FastAPI, Request

    api = FastAPI()

    @api.post("/seed")
    async def start_seed(key: str, url: str, subfolder: str, filename: str):
        call = await seed.spawn.aio(key, url, subfolder, filename)
        return {"call_id": call.object_id}

    @api.get("/seed/{key}")
    async def seed_status(key: str):
        return (await progress.get.aio(key)) or {}

    @api.put("/lora/{name}")
    async def put_lora(name: str, request: Request):
        if "/" in name or "\\" in name or not name.endswith(".safetensors"):
            return {"error": "bad name"}
        data = await request.body()
        path = f"{MODELS_DIR}/loras/{name}"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
        t = time.monotonic()
        await volume.commit.aio()
        return {"bytes": len(data), "commit_s": round(time.monotonic() - t, 2)}

    @api.get("/loras")
    async def list_loras():
        await volume.reload.aio()
        d = f"{MODELS_DIR}/loras"
        return sorted(os.listdir(d)) if os.path.isdir(d) else []

    @api.get("/outputs")
    async def list_outputs():
        await volume.reload.aio()
        return sorted(os.listdir(OUTPUT_DIR)) if os.path.isdir(OUTPUT_DIR) else []

    @api.post("/idle")
    async def set_idle(seconds: int):
        server = modal.Server.from_name(APP_NAME, SERVER_NAME)
        t = time.monotonic()
        await server.update_autoscaler.aio(scaledown_window=seconds)
        return {"ok": True, "seconds": seconds, "call_s": round(time.monotonic() - t, 2)}

    return api
