"""Cloudflare Python Worker entry: adapts the runtime to comfy_gen_worker (plain Python, tested
under CPython). Keep this file thin; logic belongs in comfy_gen_worker.

Imports run once at deploy time, inside the startup snapshot (packs load there), so nothing here may
use randomness or the network at module level.
"""

import time
from urllib.parse import parse_qsl, urlsplit

from workers import DurableObject, Response, WorkerEntrypoint, fetch

from comfy_gen_core.comfyui import Response as CoreResponse
from comfy_gen_worker.app import App
from comfy_gen_worker.http import Platform, Request


class KVAdapter:
    def __init__(self, binding):
        self._kv = binding

    async def get(self, key):
        return await self._kv.get(key)

    async def put(self, key, value):
        await self._kv.put(key, value)


async def platform_fetch(url, method="GET", headers=None, body=None):
    kw = {"method": method, "headers": headers or {}}
    if body is not None:
        kw["body"] = body
    resp = await fetch(url, **kw)
    # No headers: nothing reads them (image types are sniffed), and each one is an FFI crossing.
    return CoreResponse(resp.status, await resp.bytes())


def _env(env, name):
    value = getattr(env, name, None)
    return str(value) if value is not None else None


class Default(WorkerEntrypoint):
    def _app(self):
        env = {name: _env(self.env, name) for name in ("VERSION", "DEV_WORKER_HOST")}
        return App(Platform(kv=KVAdapter(self.env.KV), fetch=platform_fetch, now=time.time, env=env))

    async def fetch(self, request):
        url = urlsplit(request.url)
        method = str(request.method)
        body = await request.bytes() if method in ("POST", "PUT", "PATCH") else b""
        req = Request(
            method=method,
            path=url.path,
            host=url.netloc,
            scheme=url.scheme or "https",
            query=dict(parse_qsl(url.query)),
            # Only the cookie: copying every header across the JS boundary costs CPU per header,
            # and claude.ai sends many.
            headers={"cookie": request.headers.get("cookie") or ""},
            body=body,
        )
        resp = await self._app().handle(req)
        return Response(resp.body, status=resp.status, headers=resp.headers)

    async def scheduled(self, controller, env, ctx):
        await self._app().scheduled()


class Relay(DurableObject):
    """The PC path's mailbox (design §9). Declared from the first release so adding the agent later
    needs no template change; the relay itself arrives with the agent."""

    async def fetch(self, request):
        return Response("The PC relay is not available yet.", status=501)
