"""Spike worker: S1 (MCP CPU cost), S2 (image rendering), S3 (sandbox upload), S4 (Builds API from
the Worker), S6 (Durable Object WebSocket hibernation), S7 (workspace sibling import).

Routes (SECRET = the SPIKE_SECRET secret):
  /SECRET/                  index with the connector URLs
  /SECRET/noop              constant response: the bare Python request cost (S1b)
  /SECRET/raw/mcp           MCP via the hand-rolled handler   (S1, S2, S3, S7)
                            (the MCP SDK variant was removed after S1: it exceeds the free CPU budget)
  /SECRET/img/canned.png    the test image                    (S2)
  /SECRET/upload/<token>    one-time upload target            (S3)
  /SECRET/uploads/<id>      an uploaded image                 (S3)
  /SECRET/builds            the Builds page and its /api      (S4)
  /build-callback           called by the build, nonce-checked (S4)
  /relay/connect            the stand-in agent's WebSocket, bearer RELAY_SECRET (S6)
  /SECRET/relay/call        a round trip through the DO to the agent (S6)
  /SECRET/relay/status      how many agent sockets the DO holds (S6)

Every request logs one JSON line with "spike" and "route" so Workers Logs can be filtered and
grouped by it next to $workers.cpuTimeMs.
"""

import asyncio
import base64
import hmac
import json
import secrets
import time
from urllib.parse import parse_qs, urlparse

from js import WebSocketPair, WebSocketRequestResponsePair
from workers import DurableObject, Response, WorkerEntrypoint

import builds
import canned
import mcp_raw
import tools

RELAY_CALL_TIMEOUT_S = 30


def log(**fields) -> None:
    print(json.dumps({"spike": True, **fields}))


def json_response(data, status: int = 200) -> Response:
    return Response(json.dumps(data), status=status, headers={"Content-Type": "application/json"})


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        # S1b floor: no parsing, no logging, no JSON. Anything a request costs beyond this is ours.
        if request.url.endswith("/noop") and request.url.endswith(f"/{self.env.SPIKE_SECRET}/noop"):
            return Response("ok")
        url = urlparse(request.url)
        path = url.path
        host = url.hostname
        secret = str(self.env.SPIKE_SECRET)
        prefix = f"/{secret}"

        if path == "/build-callback" and request.method == "POST":
            return await self._build_callback(request)
        if path == "/relay/connect":
            return await self._relay_connect(request)
        if not (path == prefix or path.startswith(prefix + "/")):
            return Response("Not found", status=404)

        sub = path[len(prefix):] or "/"
        base = f"https://{host}{prefix}"
        if sub == "/raw/mcp":  # the hot path: checked first, no log line
            return await self._raw_mcp(request, base)
        log(route=sub.split("/")[1] if sub != "/" else "index", method=str(request.method))

        if sub in ("/", ""):
            return Response(self._index(base), headers={"Content-Type": "text/html; charset=utf-8"})
        if sub == "/img/canned.png":
            return Response(canned.PNG, headers={"Content-Type": "image/png", "Cache-Control": "no-store"})
        if sub.startswith("/upload/") and request.method == "POST":
            return await self._upload(request, sub[len("/upload/"):])
        if sub.startswith("/uploads/"):
            return await self._uploaded(sub[len("/uploads/"):])
        if sub == "/builds":
            return Response(builds.PAGE, headers={"Content-Type": "text/html; charset=utf-8"})
        if sub.startswith("/builds/api/"):
            return await self._builds_api(request, sub[len("/builds/api"):], host, url.query)
        if sub == "/relay/call":
            return json_response(await self.env.RELAY.getByName("agent").call(parse_qs(url.query).get("path", ["/ping"])[0]))
        if sub == "/relay/status":
            return json_response(await self.env.RELAY.getByName("agent").status())
        return Response("Not found", status=404)

    # ── S1 / S2 / S3 ──────────────────────────────────────────────────

    async def _raw_mcp(self, request, base: str):
        if request.method != "POST":
            return Response("Method not allowed", status=405, headers={"Allow": "POST"})
        status, body = await mcp_raw.handle(await request.bytes(), base, self.env)
        if body is None:
            return Response(None, status=status)
        return Response(body, status=status, headers={"Content-Type": "application/json"})

    async def _upload(self, request, token: str):
        key = f"utok:{token}"
        filename = await self.env.SPIKE_KV.get(key)
        if filename is None:
            return json_response({"error": "unknown or expired upload link"}, 404)
        await self.env.SPIKE_KV.delete(key)
        data = await request.bytes()
        if not data:
            return json_response({"error": "empty body"}, 400)
        image_id = secrets.token_urlsafe(12)
        mime = tools.sniff_mime(data)
        meta = {"b64": base64.b64encode(data).decode(), "mime": mime, "filename": filename}
        await self.env.SPIKE_KV.put(f"upload:{image_id}", json.dumps(meta), expirationTtl=tools.UPLOAD_TTL)
        log(route="upload", bytes=len(data), mime=mime)
        return json_response({"image_id": image_id, "bytes": len(data), "mime": mime})

    async def _uploaded(self, image_id: str):
        raw = await self.env.SPIKE_KV.get(f"upload:{image_id}")
        if not raw:
            return Response("Not found", status=404)
        meta = json.loads(raw)
        return Response(base64.b64decode(meta["b64"]), headers={"Content-Type": meta["mime"]})

    # ── S4 ────────────────────────────────────────────────────────────

    async def _builds_api(self, request, sub: str, host: str, query: str):
        token = request.headers.get("X-CF-Token") or ""
        if not token:
            return json_response({"error": "paste a token first"}, 400)
        q = {k: v[0] for k, v in parse_qs(query).items()}
        try:
            if sub == "/discover":
                return json_response(await builds.discover(token, host))
            if sub == "/vars":
                b = await request.json()
                return json_response(await builds.set_vars(
                    token, b["account_id"], b["trigger"], self.env.SPIKE_KV, host, b.get("extra")))
            if sub == "/build":
                b = await request.json()
                return json_response(await builds.start_build(token, b["account_id"], b["trigger"], b["branch"]))
            if sub == "/status":
                return json_response(await builds.build_status(token, q["account_id"], q["build"]))
            if sub == "/logs":
                return json_response(await builds.build_logs(token, q["account_id"], q["build"], q.get("cursor")))
            if sub == "/callbacks":
                listed = await self.env.SPIKE_KV.list(prefix="callback:")
                out = []
                for k in listed["keys"]:
                    out.append(json.loads(await self.env.SPIKE_KV.get(k["name"])))
                return json_response(out)
        except builds.CFError as e:
            return json_response({"error": str(e)}, 502)
        return json_response({"error": "unknown"}, 404)

    async def _build_callback(self, request):
        body = await request.json()
        expected = await self.env.SPIKE_KV.get("nonce")
        ok = bool(expected) and hmac.compare_digest(str(body.get("nonce", "")), expected)
        log(route="build-callback", ok=ok)
        if not ok:
            return json_response({"error": "bad nonce"}, 403)
        body.pop("nonce", None)
        body["received_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        await self.env.SPIKE_KV.put(f"callback:{int(time.time() * 1000)}", json.dumps(body), expirationTtl=86400)
        return json_response({"ok": True})

    # ── S6 ────────────────────────────────────────────────────────────

    async def _relay_connect(self, request):
        auth = request.headers.get("Authorization") or ""
        if not hmac.compare_digest(auth, f"Bearer {self.env.RELAY_SECRET}"):
            return Response("Unauthorized", status=401)
        if (request.headers.get("Upgrade") or "").lower() != "websocket":
            return Response("Expected a WebSocket upgrade", status=426)
        return await self.env.RELAY.getByName("agent").fetch(request)

    def _index(self, base: str) -> str:
        return f"""<!doctype html><meta charset="utf-8"><title>comfy-gen spikes</title>
<body style="font:14px system-ui;margin:16px">
<h1>comfy-gen spikes</h1>
<p>Connector URL (claude.ai: Settings, Connectors, Add custom connector):</p>
<ul><li><code>{base}/raw/mcp</code></li></ul>
<p><a href="{base}/img/canned.png">Test image</a> ({canned.DESCRIPTION})</p>
<p><a href="{base}/builds">Builds spike (S4)</a> &middot; <a href="{base}/relay/status">Relay status</a>
 &middot; <a href="{base}/relay/call?path=/ping">Relay round trip</a></p>
</body>"""


class Relay(DurableObject):
    """One per user in the product. Holds the agent's WebSocket with the hibernation API.

    ping/pong text frames are answered by the runtime without waking the object. A call from the
    Worker sends a JSON request down the socket and waits for the reply with the same id; while it
    waits the object is awake (billed), which is fine because that's the length of one request.
    """

    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.ctx.setWebSocketAutoResponse(WebSocketRequestResponsePair.new("ping", "pong"))
        self.pending: dict[str, asyncio.Future] = {}
        log(route="relay-do-wake")  # one line per constructor run = one wake from hibernation

    async def fetch(self, request):
        client, server = WebSocketPair.new().object_values()
        self.ctx.acceptWebSocket(server)
        log(route="relay-accept", sockets=len(list(self.ctx.getWebSockets())))
        return Response(None, status=101, web_socket=client)

    async def webSocketMessage(self, ws, message):
        if not isinstance(message, str):
            return
        try:
            msg = json.loads(message)
        except ValueError:
            return
        fut = self.pending.pop(msg.get("id"), None)
        if fut is not None and not fut.done():
            fut.set_result(msg)

    async def webSocketClose(self, ws, code, reason, wasClean):
        log(route="relay-close", code=code, reason=str(reason))

    async def call(self, path: str) -> dict:
        sockets = list(self.ctx.getWebSockets())
        if not sockets:
            return {"error": "agent offline"}
        req_id = secrets.token_hex(8)
        fut = asyncio.get_running_loop().create_future()
        self.pending[req_id] = fut
        t = time.monotonic()
        sockets[-1].send(json.dumps({"id": req_id, "method": "GET", "path": path}))
        try:
            reply = await asyncio.wait_for(fut, RELAY_CALL_TIMEOUT_S)
        except asyncio.TimeoutError:
            self.pending.pop(req_id, None)
            return {"error": f"no reply in {RELAY_CALL_TIMEOUT_S}s"}
        return {"reply": reply, "round_trip_ms": round((time.monotonic() - t) * 1000, 1), "sockets": len(sockets)}

    async def status(self) -> dict:
        return {"sockets": len(list(self.ctx.getWebSockets()))}
