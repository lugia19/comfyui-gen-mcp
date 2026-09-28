"""The Modal app's admin API (comfy_gen_modal.app.admin), as the Worker uses it: download a pack's
models onto the Volume, read the progress, set keep-warm. Same proxy token as ComfyUI."""

from __future__ import annotations

import json

from comfy_gen_worker.http import Fetch


class ModalAdminError(Exception):
    pass


class ModalAdmin:
    def __init__(self, fetch: Fetch, url: str, headers: dict[str, str]):
        self.fetch = fetch
        self.url = url.rstrip("/")
        self.headers = headers

    async def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        try:
            resp = await self.fetch(
                self.url + path, method=method, headers={**self.headers, "Content-Type": "application/json"},
                body=json.dumps(body).encode() if body is not None else None,
            )
        except Exception as e:
            raise ModalAdminError(f"Could not reach the Modal app: {e}") from e
        if resp.status != 200:
            raise ModalAdminError(f"The Modal app answered HTTP {resp.status}: {resp.text[:200]}")
        return resp.json()

    async def seed(self, pack: dict) -> dict:
        return await self._call("POST", "/seed", {"pack": pack["name"], "models": pack["models"]})

    async def status(self, pack_name: str) -> dict:
        return await self._call("GET", f"/seed/{pack_name}")

    async def idle(self, minutes: int) -> dict:
        return await self._call("POST", "/idle", {"seconds": max(60, min(3600, minutes * 60))})


def for_generator(fetch: Fetch, generator: dict | None) -> ModalAdmin | None:
    """The admin client for a Modal generator; None for any other kind."""
    if not generator or generator.get("kind") != "modal" or not generator.get("admin_url"):
        return None
    return ModalAdmin(fetch, generator["admin_url"], generator.get("headers") or {})


# Packs known to be fully on the Volume, in the setup KV key, so a ready pack costs no admin call.

async def pack_status(admin: ModalAdmin, store, pack: dict) -> dict:
    """The pack's seed state: {state: done|queued|downloading|failed|missing, done, total, error}."""
    seeded = (await store.setup()).get("seeded") or []
    if pack["name"] in seeded:
        return {"state": "done"}
    status = await admin.status(pack["name"])
    if status.get("state") == "done":
        await store.update_setup(seeded=sorted({*seeded, pack["name"]}))
    return status


async def seed_missing(admin: ModalAdmin, store, packs: list[dict]) -> list[str]:
    """Start downloads for the packs not known to be on the Volume. Returns warnings, never raises."""
    seeded = (await store.setup()).get("seeded") or []
    warnings = []
    for pack in packs:
        if pack["name"] in seeded or not pack.get("models"):
            continue
        try:
            await admin.seed(pack)
        except ModalAdminError as e:
            warnings.append(f"Could not start downloading {pack.get('display_name', pack['name'])}: {e}")
    return warnings
