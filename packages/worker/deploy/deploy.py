"""The Workers Build step, after deploy.sh has downloaded the source.

1. Deploy the Modal app when the setup page stored a Modal token (packages/modal_app).
2. Write the release's wrangler config with the user's name (and any routes) merged in from their
   copy of bootstrap/wrangler.jsonc, and VERSION set.
3. `npm ci` for the Worker's workspace, then `wrangler deploy` from packages/worker.
4. Report to the Worker's /build-callback when the setup page started this build.

Build variables, set by the setup page: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET (Modal deploy),
COMFY_GEN_CALLBACK and COMFY_GEN_NONCE (the report).

Runs on the build image's python3: standard library only, and nothing newer than 3.10.
"""

from __future__ import annotations

import argparse
import json
import os
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


def merge(release: dict, template: dict, version: str) -> dict:
    cfg = {k: v for k, v in release.items() if k != "$schema"}
    for key in USER_KEYS:
        if key in template:
            cfg[key] = template[key]
    cfg["vars"] = {**(cfg.get("vars") or {}), "VERSION": version}
    return cfg


def deploy_modal(src: Path) -> tuple[dict | None, str]:
    """Run the Modal app's own deploy script (comfy_gen_modal.deploy). It writes the URLs and proxy
    token as JSON."""
    if not (os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")):
        return None, "skipped (no Modal token)"
    print("== Modal", flush=True)
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "modal.json"
        cmd = ["uv", "run", "--package", "comfy-gen-modal", "--no-dev", "python", "-m", "comfy_gen_modal.deploy", "--out", str(out)]
        result = subprocess.run(cmd, cwd=src)
        if result.returncode != 0 or not out.exists():
            return None, f"failed (exit {result.returncode})"
        return json.loads(out.read_text()), "ok"


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

    modal, modal_result = deploy_modal(args.src)
    print(f"modal: {modal_result}", flush=True)

    worker = args.src / "packages" / "worker"
    template = read_jsonc((args.template / "wrangler.jsonc").read_text())
    release = read_jsonc((worker / "wrangler.jsonc").read_text())
    cfg = merge(release, template, args.version)
    (worker / "wrangler.jsonc").write_text(json.dumps(cfg, indent=2))
    print(f"== Worker {cfg['name']} {args.version}", flush=True)

    installed = subprocess.run(["npm", "ci", "--workspace", "packages/worker"], cwd=args.src).returncode == 0
    cmd = ["npx", "wrangler", "deploy"] + (["--dry-run"] if args.dry_run else [])
    deployed = installed and subprocess.run(cmd, cwd=worker).returncode == 0
    report = {"stage": "deployed" if deployed else "failed", "version": args.version, "modal_result": modal_result}
    if modal:
        report["modal"] = modal
    callback(report)
    return 0 if deployed else 1


if __name__ == "__main__":
    sys.exit(main())
