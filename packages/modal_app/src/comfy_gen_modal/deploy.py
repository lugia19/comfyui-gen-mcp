"""Deploy the Modal app and report how to reach it, with MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in
the environment. Two callers:

- the Workers Build (a Worker made from a repository; its deploy/deploy.py reads the file):

    uv run --package comfy-gen-modal --no-dev python -m comfy_gen_modal.deploy --out modal.json

- a Modal Sandbox started by a Worker made by the setup site (design §6), which posts the same
  report to the Worker's /build-callback itself:

    … python -m comfy_gen_modal.deploy --callback https://<worker>/build-callback --nonce <n> --version vX.Y.Z

On failure it writes {"error": <Modal's reason>} instead, for the setup page to show ("Please add a
payment method to use L4 GPU functions." on an account with no card), and exits 1.

The Worker reaches ComfyUI and the admin API with a proxy token. It is minted once and kept in the
app's Dict, so update builds reuse it instead of piling up tokens in the user's workspace.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request


def modal_error(output: str) -> str:
    """Modal's reason for a failed command: the text of its boxed "Error" panel, else the last line."""
    lines = output.splitlines()
    for i, line in enumerate(lines):
        if re.match(r"\s*╭─+ ?Error", line):
            body = []
            for inner in lines[i + 1:]:
                if inner.strip().startswith("╰"):
                    break
                body.append(inner.strip().strip("│").strip())
            text = " ".join(t for t in body if t)
            if text:
                return text
    rest = [line.strip() for line in lines if line.strip()]
    return rest[-1] if rest else "modal deploy failed"


def run_deploy() -> tuple[int, str]:
    """`modal deploy`, its output streamed to the build log as it comes and also kept."""
    proc = subprocess.Popen([sys.executable, "-m", "modal", "deploy", "-m", "comfy_gen_modal.app"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    kept = []
    for line in proc.stdout:
        print(line, end="", flush=True)
        kept.append(line)
    return proc.wait(), "".join(kept)


def proxy_token(stored: dict | None, create) -> tuple[dict, bool]:
    """(token, is_new): the stored {id, secret}, else a fresh one from *create*()."""
    if stored and stored.get("id") and stored.get("secret"):
        return stored, False
    t = create()
    return {"id": t.token_id, "secret": t.token_secret}, True


def report(result: dict, nonce: str, version: str) -> dict:
    """The Worker's build-callback body for *result*: the keys packages/worker/deploy/deploy.py's
    report has (that file stays stdlib-only at its path, so the two aren't shared)."""
    body = {"nonce": nonce, "stage": "modal", "version": version}
    if "error" in result:
        return {**body, "modal_result": "failed", "modal_error": result["error"]}
    return {**body, "modal_result": "deployed", "modal": result}


def post(url: str, body: dict, tries: int = 4) -> None:
    """POST *body* to the Worker, again on a 5xx or a connection error. Its own User-Agent:
    Cloudflare refuses urllib's default before the Worker runs."""
    data = json.dumps(body).encode()
    for attempt in range(tries):
        req = urllib.request.Request(url, data=data, method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": "comfy-gen-modal"})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                print(f"Worker: {resp.status}", flush=True)
                return
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == tries - 1:
                print(f"Worker refused the report: HTTP {e.code}", flush=True)
                return
        except OSError as e:
            if attempt == tries - 1:
                print(f"Worker unreachable: {e}", flush=True)
                return
        time.sleep(2 ** attempt)


def finish(result: dict, args) -> int:
    if args.out:
        with open(args.out, "w") as fh:
            json.dump(result, fh)
    if args.callback:
        post(args.callback, report(result, args.nonce, args.version))
    return 1 if "error" in result else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="where to write the JSON for the build's callback")
    ap.add_argument("--callback", help="the Worker's /build-callback, to post the report to")
    ap.add_argument("--nonce", help="the Worker's one-time nonce for the callback")
    ap.add_argument("--version", help="the release deployed, for the report")
    args = ap.parse_args()
    if not args.out and not args.callback:
        ap.error("--out or --callback")
    if args.callback and not (args.nonce and args.version):
        ap.error("--callback needs --nonce and --version")

    code, output = run_deploy()
    if code != 0:
        return finish({"error": modal_error(output)}, args)

    import modal

    from comfy_gen_modal.app import APP_NAME, SERVER_NAME, STATE_DICT

    state = modal.Dict.from_name(STATE_DICT, create_if_missing=True)
    token, new = proxy_token(state.get("proxy_token"), modal.Workspace.from_context().proxy_tokens.create)
    if new:
        state["proxy_token"] = token
    result = {
        "server_url": modal.Server.from_name(APP_NAME, SERVER_NAME).get_url(),
        "admin_url": modal.Function.from_name(APP_NAME, "admin").get_web_url(),
        "proxy_token_id": token["id"],
        "proxy_token_secret": token["secret"],
    }
    print(f"Modal: {result['server_url']} (proxy token {'new' if new else 'reused'})")
    return finish(result, args)


if __name__ == "__main__":
    sys.exit(main())
