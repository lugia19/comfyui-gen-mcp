"""The Worker's state in KV, cached per isolate.

Three keys, read on most requests, written rarely (the free plan allows 1,000 KV writes a day):
    config   the user config (comfy_gen_core.config shape)
    secrets  generated keys, the Cloudflare token and discovery, the generator's URL and headers
    setup    setup progress: the current build, its nonce, what builds reported back

Reads are cached per isolate for CACHE_S, so a warm MCP call costs no KV reads. Writes update the
cache of the isolate that made them; another isolate sees them within CACHE_S.
"""

from __future__ import annotations

import json
import secrets as pysecrets

from comfy_gen_core import config as config_mod

from comfy_gen_worker.http import KV

CACHE_S = 30.0

# Module-level so the cache survives across requests in one isolate.
_cache: dict[str, tuple[float, dict]] = {}


class Store:
    def __init__(self, kv: KV, now):
        self.kv = kv
        self.now = now

    async def _get(self, key: str) -> dict | None:
        hit = _cache.get(key)
        if hit and self.now() - hit[0] < CACHE_S:
            return hit[1]
        raw = await self.kv.get(key)
        data = json.loads(raw) if raw else None
        if data is not None:
            _cache[key] = (self.now(), data)
        return data

    async def _put(self, key: str, data: dict) -> None:
        await self.kv.put(key, json.dumps(data))
        _cache[key] = (self.now(), data)

    async def config(self) -> dict:
        return config_mod.normalize(await self._get("config"))

    async def save_config(self, cfg: dict) -> dict:
        cfg = config_mod.normalize(cfg)
        await self._put("config", cfg)
        return cfg

    async def secrets(self) -> dict:
        """The secrets, generating the Worker's own keys on first use (one KV write, ever)."""
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

    async def update_secrets(self, **changes) -> dict:
        data = {**await self.secrets(), **changes}
        await self._put("secrets", {k: v for k, v in data.items() if v is not None})
        return data

    async def setup(self) -> dict:
        return await self._get("setup") or {}

    async def update_setup(self, **changes) -> dict:
        data = {**await self.setup(), **changes}
        await self._put("setup", {k: v for k, v in data.items() if v is not None})
        return data


def clear_cache() -> None:
    """For tests."""
    _cache.clear()
