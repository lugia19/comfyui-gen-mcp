"""A hand-rolled, stateless MCP endpoint (streamable HTTP, JSON responses only).

It implements only what a tools-only server needs: initialize, notifications, ping, tools/list,
tools/call. No sessions, no SSE, so GET is 405 and every POST is answered with one JSON body.
S1 showed the MCP SDK exceeds the free plan's CPU budget; this is the replacement.

Anything that doesn't depend on the request is serialized at import, which happens once at deploy
time inside the startup snapshot, so a request only pays for its own bytes.
"""

import json

import tools

SERVER_INFO = {"name": "comfy-gen-spike (raw)", "version": "0.1.0"}
# Versions we answer to; anything else gets the newest of these, per the spec's negotiation rule.
VERSIONS = ("2025-03-26", "2025-06-18", "2025-11-25")

_TOOLS_LIST = json.dumps({"tools": tools.TOOLS})
_CAPABILITIES = json.dumps({"tools": {"listChanged": False}})
_SERVER_INFO = json.dumps(SERVER_INFO)


def _wrap(req_id, result_json: str) -> bytes:
    return f'{{"jsonrpc":"2.0","id":{json.dumps(req_id)},"result":{result_json}}}'.encode()


def _error(req_id, code: int, message: str) -> bytes:
    return json.dumps({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}).encode()


async def handle(body: bytes, base: str, env) -> tuple[int, bytes | None]:
    """Returns (status, response body or None for 202)."""
    try:
        msg = json.loads(body)
    except ValueError:
        return 400, _error(None, -32700, "Parse error")
    if not isinstance(msg, dict):
        return 400, _error(None, -32600, "Batches are not supported")

    method = msg.get("method", "")
    req_id = msg.get("id")
    if req_id is None:  # a notification (e.g. notifications/initialized): accept, no body
        return 202, None
    params = msg.get("params") or {}

    if method == "tools/call":
        name = params.get("name", "")
        try:
            content = await tools.call(name, params.get("arguments") or {}, base, env)
        except KeyError:
            return 200, _error(req_id, -32602, f"Unknown tool: {name}")
        except Exception as e:
            content = [tools.text(f"Tool failed: {type(e).__name__}: {e}")]
            return 200, _wrap(req_id, json.dumps({"content": content, "isError": True}))
        return 200, _wrap(req_id, json.dumps({"content": content, "isError": False}))
    if method == "tools/list":
        return 200, _wrap(req_id, _TOOLS_LIST)
    if method == "ping":
        return 200, _wrap(req_id, "{}")
    if method == "initialize":
        asked = params.get("protocolVersion")
        version = asked if asked in VERSIONS else VERSIONS[-1]
        return 200, _wrap(req_id, (
            f'{{"protocolVersion":{json.dumps(version)},"capabilities":{_CAPABILITIES},'
            f'"serverInfo":{_SERVER_INFO}}}'
        ))
    return 200, _error(req_id, -32601, f"Method not found: {method}")
