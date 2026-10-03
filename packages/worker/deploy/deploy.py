"""The Workers Build step, after deploy.sh has downloaded the source.

1. Deploy the Modal app when the setup page stored a Modal token (packages/modal_app).
2. Write the release's wrangler config with the user's name (and any routes) merged in from their
   copy of bootstrap/wrangler.jsonc (and its SETUP_MODE, the setup site's answer), VERSION set,
   and the R2 bucket named after the Worker.
3. `npm ci` for the Worker's workspace. Check that R2 is turned on in the account (`wrangler r2
   bucket list`): if it is not, deploy without the bucket, and the Worker's Setup page asks for
   it (a rebuild from there binds it). Then `wrangler deploy` from packages/worker. wrangler
   creates the bucket if it is missing, then this sets its lifecycle rules: images expire after a
   year, unfinished multipart uploads after a day.
4. Report to the Worker's /build-callback when the setup page started this build.
5. End the log with the Worker's address: after a Deploy button, this log is where the user is.

Build variables, set by the setup page: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET (Modal deploy),
COMFY_GEN_CALLBACK and COMFY_GEN_NONCE (the report). For testing only: COMFY_GEN_TEST_NO_STORAGE=1
deploys as if R2 were off.

Runs on the build image's python3: standard library only, and nothing newer than 3.10.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

USER_AGENT = "comfy-gen-build"  # Cloudflare 1010-blocks urllib's default against workers.dev

# Keys the user's copy decides. Everything else (bindings, migrations, assets, compatibility)
# comes from the release, so a release can change them without touching the user's repository.
USER_KEYS = ("name", "account_id", "routes", "route", "workers_dev", "preview_urls")

# The setup site's answer to "where should images be made?", from the template the Deploy button
# copied (bootstrap-cloud/, -pc/, -both/): the Worker's Setup page starts from it.
SETUP_MODES = ("cloud", "pc", "both")


def read_jsonc(text: str) -> dict:
    """Parse JSON with // and /* */ comments and trailing commas, as wrangler accepts."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
        elif c in "}]":
            while out and out[-1].isspace():
                out.pop()
            if out and out[-1] == ",":
                out.pop()
            out.append(c)
            i += 1
        else:
            out.append(c)
            i += 1
    return json.loads("".join(out))


# R2 (design §4): images under img/ expire after a year; LoRAs (lora/) never do. A multipart upload
# left unfinished (a closed browser tab) is dropped after a day.
LIFECYCLE = {"rules": [
    {"id": "expire-images", "enabled": True, "conditions": {"prefix": "img/"},
     "deleteObjectsTransition": {"condition": {"type": "Age", "maxAge": 365 * 86400}}},
    {"id": "abort-multipart", "enabled": True, "conditions": {"prefix": ""},
     "abortMultipartUploadsTransition": {"condition": {"type": "Age", "maxAge": 86400}}},
]}


def bucket_name(worker: str) -> str:
    return f"{worker}-storage"


def merge(release: dict, template: dict, version: str) -> dict:
    cfg = {k: v for k, v in release.items() if k != "$schema"}
    for key in USER_KEYS:
        if key in template:
            cfg[key] = template[key]
    cfg["vars"] = {**(cfg.get("vars") or {}), "VERSION": version}
    mode = (template.get("vars") or {}).get("SETUP_MODE")
    if mode in SETUP_MODES:
        cfg["vars"]["SETUP_MODE"] = mode
    cfg["r2_buckets"] = [{**b, "bucket_name": bucket_name(cfg["name"])} for b in cfg.get("r2_buckets") or []]
    return cfg


def storage_probe(code: int, output: str) -> str:
    """What `wrangler r2 bucket list` says about R2: "on", "off" (never turned on in this account:
    wrangler's error 10042), or "unknown" (any other failure, where the bucket stays bound as
    before: an unknown error must never unbind an install's storage)."""
    if code == 0:
        return "on"
    if "10042" in output or re.search(r"enable R2", output, re.IGNORECASE):
        return "off"
    return "unknown"


def check_storage(worker: Path) -> str:
    if os.environ.get("COMFY_GEN_TEST_NO_STORAGE") == "1":
        return "off"
    result = subprocess.run(["npx", "wrangler", "r2", "bucket", "list"], cwd=worker, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    state = storage_probe(result.returncode, result.stdout or "")
    if state == "unknown":
        tail = (result.stdout or "").strip().splitlines()[-1:] or [""]
        print(f"storage: could not check R2 ({tail[0]}); deploying with the bucket as before", flush=True)
    return state


def set_lifecycle(worker: Path, bucket: str) -> None:
    """Apply LIFECYCLE to the bucket. `set` replaces the rules, so it is safe on every build (`add`
    fails once a rule exists). A failure is only logged: the Worker is deployed and works."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(LIFECYCLE, f)
    try:
        cmd = ["npx", "wrangler", "r2", "bucket", "lifecycle", "set", bucket, "--file", f.name, "--force"]
        result = subprocess.run(cmd, cwd=worker, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        tail = (result.stdout or "").strip().splitlines()[-1:] or [""]
        print(f"storage: {bucket}, " + ("rules set" if result.returncode == 0 else f"setting its rules failed: {tail[0]}"), flush=True)
    finally:
        os.unlink(f.name)


def deploy_modal(src: Path) -> tuple[dict | None, str, str | None]:
    """Run the Modal app's own deploy script (comfy_gen_modal.deploy). It writes the URLs and proxy
    token as JSON, or {"error": Modal's reason} when the deploy failed. Returns (the URLs, a one-word
    result for the log, the reason)."""
    if not (os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")):
        return None, "skipped (no Modal token)", None
    print("== Modal", flush=True)
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "modal.json"
        cmd = [os.environ.get("UV", "uv"), "run", "--package", "comfy-gen-modal", "--no-dev", "python", "-m", "comfy_gen_modal.deploy", "--out", str(out)]
        result = subprocess.run(cmd, cwd=src)
        data = json.loads(out.read_text()) if out.exists() else {}
        if result.returncode != 0 or "server_url" not in data:
            return None, f"failed (exit {result.returncode})", data.get("error")
        return data, "ok", None


def callback(body: dict) -> None:
    url, nonce = os.environ.get("COMFY_GEN_CALLBACK"), os.environ.get("COMFY_GEN_NONCE")
    if not url or not nonce:
        return
    req = urllib.request.Request(
        url, data=json.dumps({"nonce": nonce, **body}).encode(), method="POST",
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    for attempt in (1, 2):
        try:
            # The Worker seeds models and applies keep-warm while answering, so allow it time.
            print("callback:", urllib.request.urlopen(req, timeout=120).read().decode()[:200])
            return
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == 2:
                print(f"callback failed: {e}")
                return
            print(f"callback: HTTP {e.code}, retrying (the new Worker version may still be settling)")
            time.sleep(5)
        except Exception as e:  # the deploy itself worked or failed already; don't mask that
            print(f"callback failed: {e}")
            return


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", type=Path, required=True, help="the user's repository checkout")
    ap.add_argument("--src", type=Path, required=True, help="the downloaded source")
    ap.add_argument("--version", required=True)
    ap.add_argument("--dry-run", action="store_true", help="wrangler --dry-run: build, deploy nothing")
    args = ap.parse_args()

    modal, modal_result, modal_error = deploy_modal(args.src)
    print(f"modal: {modal_result}" + (f": {modal_error}" if modal_error else ""), flush=True)

    worker = args.src / "packages" / "worker"
    template = read_jsonc((args.template / "wrangler.jsonc").read_text())
    release = read_jsonc((worker / "wrangler.jsonc").read_text())
    cfg = merge(release, template, args.version)
    (worker / "wrangler.jsonc").write_text(json.dumps(cfg, indent=2))
    print(f"== Worker {cfg['name']} {args.version}", flush=True)

    installed = subprocess.run(["npm", "ci", "--workspace", "packages/worker"], cwd=args.src).returncode == 0
    storage = bool(cfg.get("r2_buckets"))
    if installed and storage and check_storage(worker) == "off":
        # R2 isn't turned on yet: deploy without the bucket rather than fail. The Worker's Setup page
        # has the step, and its Check again rebuilds, which binds it once R2 is on.
        storage = False
        cfg.pop("r2_buckets")
        (worker / "wrangler.jsonc").write_text(json.dumps(cfg, indent=2))
        print("storage: R2 is not turned on in this Cloudflare account; deploying without it "
              "(your Worker's Setup page has the step)", flush=True)
    cmd = ["npx", "wrangler", "deploy"] + (["--dry-run"] if args.dry_run else [])
    deployed, url = False, None
    if installed:
        result = subprocess.run(cmd, cwd=worker, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        print(result.stdout or "", end="", flush=True)
        deployed = result.returncode == 0
        url = worker_url(result.stdout or "")
    if deployed and not args.dry_run:
        for b in cfg.get("r2_buckets") or []:
            set_lifecycle(worker, b["bucket_name"])
    report = {"stage": "deployed" if deployed else "failed", "version": args.version, "modal_result": modal_result, "storage": storage}
    if modal:
        report["modal"] = modal
    if modal_result.startswith("failed"):
        report["modal_error"] = modal_error or f"the deploy {modal_result}; the log above says why"
    callback(report)
    if deployed and url:
        if "modal_error" in report:
            head = f"The Worker is deployed, but Modal failed: {report['modal_error']}\nFix that, then press Try again on the Worker's page:"
        elif not storage:
            head = "Your Worker is ready. Open it to finish the setup (turning on storage is the next step):"
        else:
            head = "Your Worker is ready. Open it to finish the setup:"
        print(f"\n{'=' * 64}\n{head}\n\n    {url}\n{'=' * 64}", flush=True)
    return 0 if deployed else 1


def worker_url(wrangler_output: str) -> str | None:
    """The workers.dev address wrangler deploy printed, if any."""
    m = re.search(r"https://[\w.-]+\.workers\.dev", wrangler_output)
    return m.group(0) if m else None


if __name__ == "__main__":
    sys.exit(main())
