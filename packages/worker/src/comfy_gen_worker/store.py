"""The Worker's state, in the State Durable Object (entry.py), cached per isolate.

Three keys, read on most requests, written rarely:
    config   the user config (comfy_gen_core.config shape)
    secrets  generated keys, the Cloudflare token and discovery, the generator's URL and headers
    setup    setup progress: the current build and its nonce

Reads, missing keys included, are cached per isolate for CACHE_S, so a warm MCP call costs no
storage reads. Writes update the cache of the isolate that made them; another isolate sees them within
CACHE_S. The settings pages use Store(cache=False): right after a login or a save, the next page
load may land on another isolate, and it must not show the state from before.
"""

from __future__ import annotations

import json
import secrets as pysecrets

from comfy_gen_core import config as config_mod

from comfy_gen_worker.http import KV

CACHE_S = 30.0

# Module-level so the cache survives across requests in one isolate.
_cache: dict[str, tuple[float, dict | None]] = {}


class Store:
    def __init__(self, kv: KV, now, cache: bool = True):
        self.kv = kv
        self.now = now
        self.cache = cache

    async def _get(self, key: str, transform=None) -> dict | None:
        """The key's value, run through *transform* once per cache fill."""
        hit = _cache.get(key) if self.cache else None
        if hit and self.now() - hit[0] < CACHE_S:
            return hit[1]
        raw = await self.kv.get(key)
        data = json.loads(raw) if raw else None
        if transform:
            data = transform(data)
        _cache[key] = (self.now(), data)
        return data

    async def _put(self, key: str, data: dict) -> None:
        await self.kv.put(key, json.dumps(data))
        _cache[key] = (self.now(), data)

    async def config(self) -> dict:
        return await self._get("config", config_mod.normalize)

    async def save_config(self, cfg: dict) -> dict:
        cfg = config_mod.normalize(cfg)
        await self._put("config", cfg)
        return cfg

    async def secrets(self) -> dict:
        """The secrets, generating the Worker's own keys on first use (one write, ever)."""
        data = await self._get("secrets")
        if data is None or "mcp_secret" not in data:
            data = {
                **(data or {}),
                "mcp_secret": pysecrets.token_urlsafe(24),
                "hmac_key": pysecrets.token_hex(32),
                "cookie_key": pysecrets.token_hex(32),
            }
            await self._put("secrets", data)
        return data

    async def update_secrets(self, **changes) -> None:
        await self._update("secrets", await self.secrets(), changes)

    async def setup(self) -> dict:
        return await self._get("setup") or {}

    async def update_setup(self, **changes) -> None:
        await self._update("setup", await self.setup(), changes)

    async def _update(self, key: str, current: dict, changes: dict) -> None:
        """Merge *changes* in; a None value removes the key."""
        data = {**current, **changes}
        await self._put(key, {k: v for k, v in data.items() if v is not None})


def clear_cache() -> None:
    """For tests."""
    _cache.clear()
