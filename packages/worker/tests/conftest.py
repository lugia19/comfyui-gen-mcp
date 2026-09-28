import json
import os
import sys
from urllib.parse import parse_qsl, urlsplit

import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "src"))
sys.path.insert(0, os.path.join(HERE, "..", "..", "core", "tests"))  # FakeComfy

from comfy_gen_core.comfyui import Response  # noqa: E402
from fake_comfy import FakeComfy, _json, no_waiting, png  # noqa: E402

from comfy_gen_worker import store  # noqa: E402
from comfy_gen_worker.app import App  # noqa: E402
from comfy_gen_worker.http import Platform, Request  # noqa: E402

COMFY = "https://comfy.example"
ADMIN = "https://admin.example"  # the Modal app's admin API
HOST = "comfy-gen.someone.workers.dev"
TOKEN = "cfut_owner"


class FakeKV:
    def __init__(self):
        self.data: dict[str, str] = {}
        self.writes = 0

    async def get(self, key):
        return self.data.get(key)

    async def put(self, key, value):
        self.writes += 1
        self.data[key] = value


class FakeNet:
    """The Worker's fetch: routes to FakeComfy, a scripted Cloudflare API, GitHub, and image URLs."""

    def __init__(self, comfy):
        self.comfy = comfy
        self.calls = []
        self.latest_release = "v1.0.0"
        self.token_status = "active"
        self.scripts = {"comfy-gen": "tag1"}  # what the token can see
        self.builds_started = []
        self.build_vars = {}
        self.admin_calls = []  # (method, path, body)
        self.seed_state = {}  # pack -> progress entry
        self.admin_up = True

    async def __call__(self, url, method="GET", headers=None, body=None):
        self.calls.append((method, url, headers or {}))
        parts = urlsplit(url)
        if url.startswith(COMFY):
            params = dict(parse_qsl(parts.query)) or None
            return await self.comfy.request(method, parts.path, params=params, headers=headers, body=body)
        if parts.netloc == "api.cloudflare.com":
            return self._cloudflare(method, parts.path.removeprefix("/client/v4"), body)
        if url.startswith(ADMIN):
            return self._admin(method, parts.path, json.loads(body) if body else None)
        if parts.netloc == "api.github.com":
            return _json({"tag_name": self.latest_release})
        if parts.netloc == "images.example":
            return Response(200, png(1600, 900)) if parts.path.endswith(".png") else Response(404)
        return Response(404)

    def _cloudflare(self, method, path, body):
        if path == "/user/tokens/verify":
            ok = self.token_status == "active"
            return _cf({"id": "t", "status": "active"} if ok else None, ok)
        if path == "/accounts":
            return _cf([{"id": "acct1", "name": "Someone"}])
        if "/workers/scripts-search" in path:
            return _cf([{"id": tag, "script_name": name} for name, tag in self.scripts.items()])
        if path.endswith("/builds/workers/tag1/triggers"):
            return _cf([{"trigger_uuid": "trig1", "branch_includes": ["main"]}])
        if path.endswith("/environment_variables") and method == "PATCH":
            self.build_vars.update(json.loads(body))
            return _cf(None)
        if path.endswith("/builds") and method == "POST":
            self.builds_started.append(json.loads(body))
            return _cf({"build_uuid": f"build{len(self.builds_started)}"})
        if "/builds/builds/" in path and path.endswith("/logs"):
            return _cf({"lines": [[1, "hello"], [2, "world"]], "cursor": "c2"})
        if "/builds/builds/" in path:
            return _cf({"status": "running", "build_outcome": None})
        return _cf(None, ok=False)

    def _admin(self, method, path, body):
        if not self.admin_up:
            return Response(503, b"cold")
        self.admin_calls.append((method, path, body))
        if method == "POST" and path == "/seed":
            self.seed_state[body["pack"]] = {"state": "queued", "done": 0, "total": 1}
            return _json({"started": True, **self.seed_state[body["pack"]]})
        if method == "GET" and path.startswith("/seed/"):
            return _json(self.seed_state.get(path.rsplit("/", 1)[1], {"state": "missing"}))
        if method == "POST" and path == "/idle":
            return _json({"seconds": body["seconds"]})
        return Response(404)


def _cf(result, ok=True):
    return Response(200 if ok else 400, json.dumps({"success": ok, "result": result, "errors": [] if ok else [{"code": 1, "message": "nope"}]}).encode())


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def comfy(monkeypatch):
    no_waiting(monkeypatch)
    return FakeComfy()


@pytest.fixture
def world(comfy):
    store.clear_cache()
    kv, net, clock = FakeKV(), FakeNet(comfy), Clock()
    app = App(Platform(kv=kv, fetch=net, now=clock, env={"VERSION": "v1.0.0"}))
    return app, kv, net, clock


def request(method, path, body=b"", headers=None, query=None):
    if isinstance(body, (dict, list)):
        body = json.dumps(body).encode()
    return Request(method=method, path=path, host=HOST, query=query or {}, headers=headers or {}, body=body)
