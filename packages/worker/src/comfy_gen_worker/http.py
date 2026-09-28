"""The Worker's view of HTTP: plain request/response values and the platform services it needs.

Everything Cloudflare-specific (the Request/Response classes, fetch, storage) lives in entry.py, which
adapts it to these. The rest of the package is plain Python, tested under CPython.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol
from urllib.parse import urlencode

from comfy_gen_core.comfyui import Response as CoreResponse

# Sent on every outbound request (with_user_agent): GitHub's API refuses requests without one.
USER_AGENT = "comfy-gen-worker"


@dataclass
class Request:
    method: str
    path: str
    host: str
    query: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)  # lower-case names; entry.py passes only cookie
    body: bytes = b""
    scheme: str = "https"  # http only under wrangler dev

    def json(self) -> dict:
        try:
            data = json.loads(self.body or b"{}")
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    @property
    def base_url(self) -> str:
        return f"{self.scheme}://{self.host}"


@dataclass
class Response:
    status: int = 200
    body: bytes = b""
    headers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def json(cls, data, status: int = 200, headers: dict[str, str] | None = None) -> "Response":
        return cls(status, json.dumps(data).encode(), {"Content-Type": "application/json", **(headers or {})})

    @classmethod
    def error(cls, status: int, message: str) -> "Response":
        return cls.json({"error": message}, status)


# (url, method, headers, body) -> core Response. Implemented over workers.fetch in entry.py.
Fetch = Callable[..., Awaitable[CoreResponse]]


def with_user_agent(fetch: Fetch) -> Fetch:
    async def fetch_with_ua(url, method="GET", headers=None, body=None):
        return await fetch(url, method=method, headers={"User-Agent": USER_AGENT, **(headers or {})}, body=body)

    return fetch_with_ua


class KV(Protocol):
    async def get(self, key: str) -> str | None: ...
    async def put(self, key: str, value: str) -> None: ...


@dataclass
class Platform:
    """What the app needs from its host. entry.py builds the real one; tests build fakes."""

    kv: KV
    fetch: Fetch
    now: Callable[[], float]
    env: dict[str, str]  # VERSION; DEV_WORKER_HOST under pywrangler dev


class FetchTransport:
    """core.Transport over the Worker's fetch: how the brain reaches ComfyUI on Modal (and, until
    the relay exists, any directly reachable ComfyUI)."""

    def __init__(self, fetch: Fetch, base_url: str, headers: dict[str, str] | None = None):
        self._fetch = fetch
        self.base_url = base_url.rstrip("/")
        self._headers = headers or {}

    async def request(self, method, path, *, params=None, headers=None, body=None, timeout=30.0) -> CoreResponse:
        url = self.base_url + path + ("?" + urlencode(params) if params else "")
        try:
            return await self._fetch(url, method=method, headers={**self._headers, **(headers or {})}, body=body)
        except Exception as e:  # network failure: look like a booting host, as HttpxTransport does
            return CoreResponse(503, str(e).encode())
