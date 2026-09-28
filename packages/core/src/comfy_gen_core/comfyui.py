"""Async ComfyUI client over a pluggable transport.

ComfyUI's own HTTP API is the generator interface everywhere: Modal (HTTPS with proxy-token headers,
from the Worker's fetch), a PC (through the Worker's relay to the agent), or localhost (the MCPB).
The client only needs something that sends one HTTP request and hands back status, headers and body,
so the relay can carry requests as plain data.

Completion always comes from polling /history. No WebSocket: it doesn't survive the relay, and the
Worker has no use for step progress.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Protocol

BOOTING = (502, 503, 504)  # what a scale-to-zero host answers while a container starts
# Seconds between /history polls: quick at first (a warm generation takes a few seconds), then
# sparse, so a long wait costs few requests. The Worker's free plan allows 50 per invocation.
POLL_SCHEDULE = (1, 1, 2, 2, 3, 5, 5, 8)
POLL_SCHEDULE_TAIL = 10
COLD_START_POLL_S = 5.0  # Modal boots in about 44 s: ~9 retries
QUEUE_CHECK_EVERY = 5  # polls between queue checks while nothing looks wrong
# Requests kept back for after the wait: the result image and one re-request at lower quality, or
# the queue position for a Pending answer.
BUDGET_RESERVE = 2


class ComfyUIError(Exception):
    """A generation failed. The message is meant for the user."""


@dataclass
class Response:
    status: int
    content: bytes = b""
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", errors="replace")

    def json(self):
        return json.loads(self.content)


class Transport(Protocol):
    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        body: bytes | None = None,
        timeout: float = 30.0,
    ) -> Response: ...


class HttpxTransport:
    """HTTP(S) to a ComfyUI base URL with fixed extra headers, for CPython callers.

    Connection errors are reported as 503, so a host that isn't listening yet looks the same as one
    that is booting.
    """

    def __init__(self, base_url: str, headers: dict[str, str] | None = None):
        import httpx  # optional dependency (the "httpx" extra); the Worker never imports this

        self._httpx = httpx
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self.base_url, headers=headers or {})

    async def request(self, method, path, *, params=None, headers=None, body=None, timeout=30.0) -> Response:
        try:
            resp = await self._client.request(
                method, path, params=params, headers=headers, content=body, timeout=timeout,
            )
        except (self._httpx.ConnectError, self._httpx.ConnectTimeout, self._httpx.RemoteProtocolError) as e:
            return Response(503, str(e).encode())
        return Response(resp.status_code, resp.content, dict(resp.headers))

    async def aclose(self) -> None:
        await self._client.aclose()


@dataclass(frozen=True)
class OutputImage:
    """A file ComfyUI owns: an output (generated), or an input (uploaded)."""

    filename: str
    subfolder: str = ""
    type: str = "output"

    def params(self) -> dict[str, str]:
        return {"filename": self.filename, "subfolder": self.subfolder, "type": self.type}

    def load_value(self) -> str:
        """The value LoadImage takes to read this file: inputs by relative path, outputs and temp
        files with ComfyUI's "[output]" / "[temp]" annotation (verified on Modal, S5)."""
        path = f"{self.subfolder}/{self.filename}" if self.subfolder else self.filename
        return path if self.type == "input" else f"{path} [{self.type}]"


def encode_multipart(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    """multipart/form-data body. files: {field: (filename, data, mime)}. Returns (body, content_type)."""
    boundary = "----comfygen" + secrets.token_hex(12)
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for name, (filename, data, mime) in files.items():
        head = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        )
        parts.append(head.encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


class ComfyUIClient:
    """
    cold_start_s     how long submit() keeps retrying while the host answers 502/503/504
    poll_interval_s  fixed seconds between polls (tests); None follows POLL_SCHEDULE
    request_budget   max transport requests this client may make (the Worker's per-invocation
                     subrequest limit); None means unlimited. wait() stops early, returning None,
                     when only BUDGET_RESERVE requests are left.
    """

    def __init__(
        self,
        transport: Transport,
        cold_start_s: float = 0,
        poll_interval_s: float | None = None,
        request_budget: int | None = None,
    ):
        self.transport = transport
        self.cold_start_s = cold_start_s
        self.poll_interval_s = poll_interval_s
        self.request_budget = request_budget
        self.requests_made = 0
        self.client_id = secrets.token_hex(16)

    def remaining(self) -> int | None:
        return None if self.request_budget is None else self.request_budget - self.requests_made

    def _can_spend(self, n: int) -> bool:
        """Whether n more requests fit while keeping the reserve."""
        left = self.remaining()
        return left is None or left - n >= BUDGET_RESERVE

    async def _request(self, method: str, path: str, **kw) -> Response:
        self.requests_made += 1
        return await self.transport.request(method, path, **kw)

    def _poll_delay(self, polls: int) -> float:
        if self.poll_interval_s is not None:
            return self.poll_interval_s
        return POLL_SCHEDULE[polls] if polls < len(POLL_SCHEDULE) else POLL_SCHEDULE_TAIL

    async def submit(self, workflow: dict) -> str:
        """Queue a workflow and return its prompt_id, waiting out a cold start when allowed."""
        body = json.dumps({"prompt": workflow, "client_id": self.client_id}).encode()
        deadline = time.monotonic() + self.cold_start_s
        while True:
            resp = await self._request(
                "POST", "/prompt", headers={"Content-Type": "application/json"}, body=body,
            )
            if resp.status == 200:
                return resp.json()["prompt_id"]
            if resp.status not in BOOTING or not self.cold_start_s:
                raise ComfyUIError(_rejection(resp))
            if time.monotonic() > deadline:
                raise ComfyUIError(f"The GPU did not start within {self.cold_start_s:.0f}s.")
            # Leave room for at least one more submit and a couple of polls after it.
            if not self._can_spend(3):
                raise ComfyUIError("The GPU is still starting up. Please try again in a minute.")
            await asyncio.sleep(COLD_START_POLL_S)

    async def wait(self, prompt_id: str, timeout: float) -> list[OutputImage] | None:
        """Poll until the prompt finishes. Returns its images, or None if still running at *timeout*.

        Raises ComfyUIError on an execution error, or when the prompt is in neither history nor queue
        (unknown id, cancelled, or the GPU worker was replaced mid-job).
        """
        deadline = time.monotonic() + timeout
        interrupted = False  # saw a 5xx since we started waiting
        polls = 0
        while True:
            # A poll can cost up to three requests (history, queue, history again).
            if not self._can_spend(3):
                return None
            entry, status = await self._history_entry(prompt_id)
            interrupted = interrupted or status >= 500
            if entry is not None:
                return _outputs(prompt_id, entry)
            check_queue = status == 200 and (interrupted or polls % QUEUE_CHECK_EVERY == 0)
            if check_queue and await self._queue_position(prompt_id) is None:
                # It may have finished between the two requests: look once more.
                entry, _ = await self._history_entry(prompt_id)
                if entry is not None:
                    return _outputs(prompt_id, entry)
                if interrupted:
                    raise ComfyUIError("The GPU worker restarted mid-image. Please retry.")
                raise ComfyUIError(f"Unknown or expired request {prompt_id}: it is not queued and has no result.")
            if time.monotonic() >= deadline:
                return None
            await asyncio.sleep(self._poll_delay(polls))
            polls += 1

    async def status_message(self, prompt_id: str) -> str:
        left = self.remaining()
        if left is not None and left < 1:
            return "Generating"
        pos = await self._queue_position(prompt_id)
        if pos == 0:
            return "Currently being generated"
        if pos:
            return f"Position {pos} in queue"
        return "Generating"

    async def _history_entry(self, prompt_id: str) -> tuple[dict | None, int]:
        resp = await self._request("GET", f"/history/{prompt_id}")
        if resp.status != 200:
            return None, resp.status
        entry = resp.json().get(prompt_id)
        if not entry:
            return None, 200
        status = entry.get("status") or {}
        if status.get("status_str") == "error" or status.get("completed") or entry.get("outputs"):
            return entry, 200
        return None, 200

    async def _queue_position(self, prompt_id: str) -> int | None:
        """0 if running, n > 0 if pending at position n, None if not queued. An unreadable queue
        counts as running, so a flaky read never fails a live job."""
        resp = await self._request("GET", "/queue")
        if resp.status != 200:
            return 0
        q = resp.json()
        if any(len(i) > 1 and i[1] == prompt_id for i in q.get("queue_running") or []):
            return 0
        pending = sorted(q.get("queue_pending") or [], key=lambda i: i[0] if i else 0)
        for n, item in enumerate(pending, 1):
            if len(item) > 1 and item[1] == prompt_id:
                return n
        return None

    async def view(self, image: OutputImage, preview: str | None = None) -> Response:
        """Fetch an image from /view. *preview* ("webp;90", "jpeg;85") has ComfyUI convert it first."""
        params = image.params()
        if preview:
            params["preview"] = preview
        resp = await self._request("GET", "/view", params=params, timeout=60)
        if resp.status != 200:
            raise ComfyUIError(f"Could not fetch {image.filename} (HTTP {resp.status}).")
        return resp

    async def upload(self, data: bytes, filename: str, mime: str, subfolder: str = "") -> OutputImage:
        """Upload to ComfyUI's input folder (overwriting a same-named file)."""
        fields = {"type": "input", "overwrite": "true"}
        if subfolder:
            fields["subfolder"] = subfolder
        body, ctype = encode_multipart(fields, {"image": (filename, data, mime)})
        resp = await self._request(
            "POST", "/upload/image", headers={"Content-Type": ctype}, body=body, timeout=120,
        )
        if resp.status != 200:
            raise ComfyUIError(f"Upload to ComfyUI failed (HTTP {resp.status}): {resp.text[:300]}")
        info = resp.json()
        return OutputImage(info["name"], info.get("subfolder") or "", "input")

    async def node_classes(self) -> set[str]:
        """Every node class this ComfyUI knows. /object_info is large: callers should cache it."""
        resp = await self._request("GET", "/object_info", timeout=60)
        if resp.status != 200:
            raise ComfyUIError(f"Could not read ComfyUI's node list (HTTP {resp.status}).")
        return set(resp.json())


def _rejection(resp: Response) -> str:
    """User-facing text for a rejected /prompt, pulling ComfyUI's validation message when present."""
    try:
        data = resp.json()
    except ValueError:
        return f"ComfyUI rejected the workflow (HTTP {resp.status}): {resp.text[:500]}"
    err = (data.get("error") or {}) if isinstance(data, dict) else {}
    details = []
    for node_id, node_err in (data.get("node_errors") or {}).items():
        for e in node_err.get("errors", []):
            details.append(f"node {node_id} ({node_err.get('class_type', '?')}): {e.get('message')} {e.get('details', '')}".strip())
    msg = err.get("message") or f"HTTP {resp.status}"
    return "ComfyUI rejected the workflow: " + msg + ("\n" + "\n".join(details) if details else "")


def _outputs(prompt_id: str, entry: dict) -> list[OutputImage]:
    status = entry.get("status") or {}
    if status.get("status_str") == "error":
        raise ComfyUIError(f"ComfyUI execution failed: {_error_summary(status)}")
    images = [
        OutputImage(img["filename"], img.get("subfolder", ""), img.get("type", "output"))
        for node in (entry.get("outputs") or {}).values()
        for img in node.get("images", [])
        if img.get("type", "output") == "output"
    ]
    if not images:
        raise ComfyUIError(f"Job {prompt_id} finished but produced no images.")
    return images


def _error_summary(status: dict) -> str:
    for kind, data in status.get("messages") or []:
        if kind == "execution_error" and isinstance(data, dict):
            node = data.get("node_type") or data.get("node_id") or "?"
            return f"{node}: {str(data.get('exception_message', '')).strip()}"
    return json.dumps(status.get("messages"))[:500]
