"""Cloudflare API calls the Worker makes about itself: token checks, self-discovery, Workers Builds.

A Worker has no runtime API for its own account or name. The name comes from its workers.dev
hostname (<name>.<subdomain>.workers.dev), the account from listing what the user's token can see
(S4). The Builds API accepts only user tokens (section 8 of the design).
"""

from __future__ import annotations

import json
from urllib.parse import quote

from comfy_gen_worker.http import Fetch

API = "https://api.cloudflare.com/client/v4"


class CloudflareError(Exception):
    """A Cloudflare API call failed. The message is meant for the setup page."""


async def call(fetch: Fetch, token: str, method: str, path: str, body=None):
    headers = {"Authorization": f"Bearer {token}"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    resp = await fetch(API + path, method=method, headers=headers, body=data)
    try:
        payload = resp.json()
    except ValueError:
        raise CloudflareError(f"{method} {path}: HTTP {resp.status}") from None
    if not payload.get("success", False):
        errors = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in payload.get("errors") or [])
        raise CloudflareError(f"{method} {path}: {errors or f'HTTP {resp.status}'}")
    return payload.get("result")


async def verify_user_token(fetch: Fetch, token: str) -> None:
    """Raises CloudflareError with advice if the token isn't an active user token."""
    try:
        result = await call(fetch, token, "GET", "/user/tokens/verify")
    except CloudflareError as e:
        raise CloudflareError(
            "That token was not accepted as a user API token. The Builds API needs a token created under "
            "My Profile > API Tokens (not the account's API Tokens page). Use the link on this page. "
            f"({e})"
        ) from e
    if (result or {}).get("status") != "active":
        raise CloudflareError("That token is not active.")


async def discover(fetch: Fetch, token: str, host: str) -> dict:
    """{account_id, script, tag, trigger, branch} for the Worker serving *host*."""
    if not host.endswith(".workers.dev"):
        raise CloudflareError(f"Open this page on the workers.dev address to finish setup (not {host}).")
    script = host.split(".")[0]
    accounts = await call(fetch, token, "GET", "/accounts?per_page=50") or []
    for acct in accounts:
        found = await call(fetch, token, "GET", f"/accounts/{acct['id']}/workers/scripts-search?name={quote(script)}")
        match = next((s for s in found or [] if s.get("script_name") == script), None)
        if not match:
            continue
        tag = match["id"]
        triggers = await call(fetch, token, "GET", f"/accounts/{acct['id']}/builds/workers/{tag}/triggers") or []
        if not triggers:
            raise CloudflareError("This Worker is not connected to a Git repository, so it cannot update itself.")
        trig = triggers[0]
        return {
            "account_id": acct["id"],
            "script": script,
            "tag": tag,
            "trigger": trig["trigger_uuid"],
            "branch": (trig.get("branch_includes") or ["main"])[0],
        }
    raise CloudflareError(
        f"The token cannot see a Worker named {script}. Make sure it was created for the account this "
        "Worker lives in."
    )


async def set_build_vars(fetch: Fetch, token: str, account_id: str, trigger: str, secret: dict, plain: dict) -> None:
    body = {k: {"value": v, "is_secret": True} for k, v in secret.items() if v}
    body.update({k: {"value": v, "is_secret": False} for k, v in plain.items() if v})
    await call(fetch, token, "PATCH", f"/accounts/{account_id}/builds/triggers/{trigger}/environment_variables", body)


async def start_build(fetch: Fetch, token: str, account_id: str, trigger: str, branch: str) -> str:
    result = await call(fetch, token, "POST", f"/accounts/{account_id}/builds/triggers/{trigger}/builds", {"branch": branch})
    return result["build_uuid"]


async def build_status(fetch: Fetch, token: str, account_id: str, build: str) -> dict:
    r = await call(fetch, token, "GET", f"/accounts/{account_id}/builds/builds/{build}")
    return {"status": r.get("status"), "outcome": r.get("build_outcome")}


async def build_logs(fetch: Fetch, token: str, account_id: str, build: str, cursor: str | None) -> dict:
    q = f"?cursor={quote(cursor)}" if cursor else ""
    r = await call(fetch, token, "GET", f"/accounts/{account_id}/builds/builds/{build}/logs{q}") or {}
    return {"lines": [line for _, line in r.get("lines") or []], "cursor": r.get("cursor") or cursor}
