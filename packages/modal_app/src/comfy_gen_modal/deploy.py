"""Deploy the Modal app and report how to reach it. Runs inside the Workers Build (the Worker's
deploy/deploy.py calls it when the setup page stored a Modal token), where MODAL_TOKEN_ID and
MODAL_TOKEN_SECRET are build secrets:

    uv run --package comfy-gen-modal --no-dev python -m comfy_gen_modal.deploy --out modal.json

The Worker reaches ComfyUI and the admin API with a proxy token. It is minted once and kept in the
app's Dict, so update builds reuse it instead of piling up tokens in the user's workspace.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys


def proxy_token(stored: dict | None, create) -> tuple[dict, bool]:
    """(token, is_new): the stored {id, secret}, else a fresh one from *create*()."""
    if stored and stored.get("id") and stored.get("secret"):
        return stored, False
    t = create()
    return {"id": t.token_id, "secret": t.token_secret}, True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="where to write the JSON for the Worker's build callback")
    args = ap.parse_args()

    subprocess.run([sys.executable, "-m", "modal", "deploy", "-m", "comfy_gen_modal.app"], check=True)

    import modal

    from comfy_gen_modal.app import APP_NAME, SERVER_NAME, STATE_DICT

    state = modal.Dict.from_name(STATE_DICT, create_if_missing=True)
    token, new = proxy_token(state.get("proxy_token"), modal.Workspace.from_context().proxy_tokens.create)
    if new:
        state["proxy_token"] = token
    result = {
        "server_url": modal.Server.from_name(APP_NAME, SERVER_NAME).get_url(),
        "admin_url": modal.Function.from_name(APP_NAME, "admin").get_web_url(),
        "upload_url": modal.Function.from_name(APP_NAME, "upload").get_web_url(),
        "proxy_token_id": token["id"],
        "proxy_token_secret": token["secret"],
    }
    with open(args.out, "w") as fh:
        json.dump(result, fh)
    print(f"Modal: {result['server_url']} (proxy token {'new' if new else 'reused'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
