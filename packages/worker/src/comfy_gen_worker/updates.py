"""Daily update check: a newer GitHub release starts a Workers Build, which fetches that release.

Nothing to sync in the user's copy of the template: its deploy command downloads the latest
release's deploy.sh on every build (design section 7).
"""

from __future__ import annotations

import logging
import re

from comfy_gen_worker import cloudflare
from comfy_gen_worker.http import Fetch
from comfy_gen_worker.store import Store

log = logging.getLogger("comfy_gen")

REPO = "lugia19/comfyui-gen-mcp"


def parse_version(tag: str) -> tuple[int, ...] | None:
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", (tag or "").strip())
    return tuple(int(x) for x in m.groups()) if m else None


async def latest_release(fetch: Fetch) -> str | None:
    resp = await fetch(
        f"https://api.github.com/repos/{REPO}/releases/latest",
        method="GET",
        headers={"Accept": "application/vnd.github+json"},
    )
    if resp.status != 200:
        return None
    return resp.json().get("tag_name")


async def check(fetch: Fetch, store: Store, current: str) -> str:
    """Start a build if a newer release exists. Returns what happened, for the log."""
    latest = await latest_release(fetch)
    new, cur = parse_version(latest or ""), parse_version(current)
    if new is None:
        return "no release found"
    if cur is not None and new <= cur:
        return f"up to date ({current})"
    setup = await store.setup()
    if setup.get("update_tried") == latest:
        return f"already tried {latest}"
    secrets = await store.secrets()
    if not secrets.get("cf_token") or not secrets.get("cf_trigger"):
        return "no Cloudflare token: updates are off"
    try:
        build = await cloudflare.start_build(
            fetch, secrets["cf_token"], secrets["cf_account_id"], secrets["cf_trigger"], secrets.get("cf_branch") or "main",
        )
    except cloudflare.CloudflareError as e:
        return f"could not start the update build: {e}"
    await store.update_setup(update_tried=latest, build=build)
    return f"updating {current} -> {latest} (build {build})"
