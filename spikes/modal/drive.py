"""Drives spike_app.py and prints the numbers for spikes/README.md (S5).

Needs the Modal CLI logged in (`modal token new`) and `pip install modal httpx`.

    python drive.py all      # the whole run, ~5 minutes including one scale-to-zero wait
    python drive.py lora     # only the warm-container LoRA check (run once per deploy variant)
    python drive.py idle     # only update_autoscaler from inside a function
    python drive.py seed     # only the admin-spawned seed download with progress
"""

import random
import sys
import time

import httpx
import modal

APP_NAME = "comfy-gen-spike"
SERVER_NAME = "comfy"
IDLE_S = 60
BOOTING = (502, 503, 504)
# ~335 MB public file, enough to see progress updates.
SEED_URL = "https://huggingface.co/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors"

results: list[str] = []


def note(line: str) -> None:
    print(f"==> {line}", flush=True)
    results.append(line)


def connect() -> tuple[httpx.Client, httpx.Client, str]:
    tok = modal.Workspace.from_context().proxy_tokens.create()
    headers = {"Modal-Key": tok.token_id, "Modal-Secret": tok.token_secret}
    comfy_url = modal.Server.from_name(APP_NAME, SERVER_NAME).get_url()
    admin_url = modal.Function.from_name(APP_NAME, "admin").get_web_url()
    print(f"comfy: {comfy_url}\nadmin: {admin_url}\nproxy token: {tok.token_id}")
    comfy = httpx.Client(base_url=comfy_url, headers=headers, timeout=60)
    admin = httpx.Client(base_url=admin_url, headers=headers, timeout=120)
    return comfy, admin, tok.token_id


def submit(comfy: httpx.Client, workflow: dict, label: str) -> tuple[str, float]:
    """POST /prompt, waiting out a cold start. Returns (prompt_id, seconds until accepted)."""
    t = time.monotonic()
    while True:
        r = comfy.post("/prompt", json={"prompt": workflow})
        if r.status_code == 200:
            waited = time.monotonic() - t
            print(f"{label}: accepted after {waited:.1f}s")
            return r.json()["prompt_id"], waited
        if r.status_code not in BOOTING:
            raise SystemExit(f"{label}: /prompt {r.status_code} {r.text[:500]}")
        if time.monotonic() - t > 600:
            raise SystemExit(f"{label}: server did not come up in 10 min")
        time.sleep(2)


def wait_output(comfy: httpx.Client, prompt_id: str) -> dict:
    while True:
        r = comfy.get(f"/history/{prompt_id}")
        if r.status_code == 200 and (entry := r.json().get(prompt_id)):
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                raise SystemExit(f"workflow error: {status}")
            for node in entry.get("outputs", {}).values():
                if node.get("images"):
                    return node["images"][0]
        time.sleep(0.5)


def gen_workflow() -> dict:
    color = random.randint(0, 0xFFFFFF)  # a new color every run, or ComfyUI serves its cache
    return {
        "1": {"class_type": "EmptyImage", "inputs": {"width": 256, "height": 256, "batch_size": 1, "color": color}},
        "2": {"class_type": "SaveImage", "inputs": {"filename_prefix": "spike", "images": ["1", 0]}},
    }


def edit_workflow(image_value: str) -> dict:
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": image_value}},
        "2": {"class_type": "ImageInvert", "inputs": {"image": ["1", 0]}},
        "3": {"class_type": "SaveImage", "inputs": {"filename_prefix": "spike-edit", "images": ["2", 0]}},
    }


def run_edit(comfy: httpx.Client, image_value: str, label: str) -> None:
    r = comfy.post("/prompt", json={"prompt": edit_workflow(image_value)})
    if r.status_code != 200:
        note(f"{label}: REJECTED {r.status_code} {r.text[:300]}")
        return
    out = wait_output(comfy, r.json()["prompt_id"])
    note(f"{label}: OK -> {out['filename']}")


def wait_for_scale_to_zero(admin: httpx.Client) -> None:
    wait = IDLE_S + 60
    print(f"Waiting {wait}s for the server to scale to zero (check the dashboard: 0 containers)...")
    time.sleep(wait)


def cmd_seed(admin: httpx.Client | None = None) -> None:
    if admin is None:
        _, admin, _ = connect()
    key = f"spike-{random.randint(0, 10**6)}"
    t = time.monotonic()
    r = admin.post("/seed", params={"key": key, "url": SEED_URL, "subfolder": "vae", "filename": "spike-vae.safetensors"})
    note(f"(f) admin /seed spawn: {r.status_code} {r.text[:200]}")
    updates = 0
    while time.monotonic() - t < 900:
        p = admin.get(f"/seed/{key}").json()
        if p:
            updates += 1
            print(f"  seed progress {p['done'] / 2**20:.0f} / {p['total'] / 2**20:.0f} MiB")
            if p["done"] >= p["total"] > 1:
                note(f"(f) seed done in {time.monotonic() - t:.1f}s with {updates} progress reads")
                return
        time.sleep(3)
    note("(f) seed did not finish in 15 min")


def cmd_all() -> None:
    comfy, admin, _ = connect()
    cmd_seed(admin)

    # Cold start + first output.
    pid, cold = submit(comfy, gen_workflow(), "gen #1 (cold)")
    t = time.monotonic()
    out1 = wait_output(comfy, pid)
    note(f"cold start until /prompt accepted: {cold:.1f}s; run {time.monotonic() - t:.1f}s; output {out1['filename']}")

    r = comfy.get("/object_info/UnetLoaderGGUF")
    note(f"(g) UnetLoaderGGUF in /object_info: {r.status_code == 200 and 'UnetLoaderGGUF' in r.json()}")

    pid, warm = submit(comfy, gen_workflow(), "gen #2 (warm)")
    wait_output(comfy, pid)
    note(f"warm /prompt accepted after {warm:.1f}s")

    # Upload an input.
    png = comfy.get("/view", params={"filename": out1["filename"], "subfolder": out1.get("subfolder", ""), "type": "output"}).content
    r = comfy.post("/upload/image", files={"image": ("spike-upload.png", png, "image/png")}, data={"overwrite": "true"})
    note(f"/upload/image: {r.status_code} {r.text[:200]}")
    uploaded = r.json()["name"] if r.status_code == 200 else None

    print("admin /outputs sees:", admin.get("/outputs").json()[-5:])

    wait_for_scale_to_zero(admin)

    # (a) output survives
    t = time.monotonic()
    while True:
        r = comfy.get("/view", params={"filename": out1["filename"], "subfolder": out1.get("subfolder", ""), "type": "output"})
        if r.status_code not in BOOTING:
            break
        time.sleep(2)
    note(f"(a) /view of pre-scaledown output after cold start: HTTP {r.status_code}, {len(r.content)} bytes "
         f"(cold {time.monotonic() - t:.1f}s)")

    # (b) edit a prior output by name
    run_edit(comfy, f"{out1['filename']} [output]", "(b) LoadImage '<name> [output]' after cold start")

    # (c) uploaded input survives
    if uploaded:
        run_edit(comfy, uploaded, "(c) LoadImage of pre-scaledown upload")

    cmd_lora(comfy, admin)
    cmd_idle(admin)


def cmd_lora(comfy: httpx.Client | None = None, admin: httpx.Client | None = None) -> None:
    if comfy is None:
        comfy, admin, _ = connect()
    pid, _ = submit(comfy, gen_workflow(), "warm-up")
    wait_output(comfy, pid)

    name = f"spike-{random.randint(0, 10**6)}.safetensors"
    r = admin.put(f"/lora/{name}", content=b"\0" * 1024)
    note(f"(d) uploaded {name} via admin: {r.status_code} {r.text[:200]}")
    t = time.monotonic()
    while time.monotonic() - t < 90:
        info = comfy.get("/object_info/LoraLoaderModelOnly").json()
        names = info["LoraLoaderModelOnly"]["input"]["required"]["lora_name"][0]
        if name in names:
            note(f"(d) warm ComfyUI sees the new LoRA after {time.monotonic() - t:.1f}s")
            return
        time.sleep(5)
    note("(d) warm ComfyUI did NOT see the new LoRA within 90s")


def cmd_idle(admin: httpx.Client | None = None) -> None:
    if admin is None:
        _, admin, _ = connect()
    r = admin.post("/idle", params={"seconds": IDLE_S + 30})
    note(f"(e) update_autoscaler from a function: {r.status_code} {r.text[:200]}")
    admin.post("/idle", params={"seconds": IDLE_S})


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    {"all": cmd_all, "lora": cmd_lora, "idle": cmd_idle, "seed": cmd_seed}[cmd]()
    print("\n--- results to paste back ---")
    for line in results:
        print(line)
