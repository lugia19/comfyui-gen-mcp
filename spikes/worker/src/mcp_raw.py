"""A hand-rolled, stateless MCP endpoint (streamable HTTP, JSON responses only).

Spike S1 compares its CPU cost per tools/call with the MCP SDK's. It implements only what a
tools-only server needs: initialize, notifications, ping, tools/list, tools/call. No sessions, no
SSE, so GET is 405 and every POST is answered with one JSON body.
"""

import json

import tools

SERVER_INFO = {"name": "comfy-gen-spike (raw)", "version": "0.1.0"}
# Versions we answer to; anything else gets the newest of these, per the spec's negotiation rule.
VERSIONS = ("2025-03-26", "2025-06-18", "2025-11-25")


def _result(req_id, result) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _error(req_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


async def handle(body: bytes, base: str, env) -> tuple[int, dict | None, str]:
    """Returns (status, json_body or None, log_label)."""
    try:
        msg = json.loads(body)
    except ValueError:
        return 400, _error(None, -32700, "Parse error"), "parse-error"
    if not isinstance(msg, dict):
        return 400, _error(None, -32600, "Batches are not supported"), "batch"

    method = msg.get("method", "")
    req_id = msg.get("id")
    if req_id is None:  # a notification (e.g. notifications/initialized): accept, no body
        return 202, None, method
    params = msg.get("params") or {}

    if method == "initialize":
        asked = params.get("protocolVersion")
        version = asked if asked in VERSIONS else VERSIONS[-1]
        return 200, _result(req_id, {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
        }), f"initialize {asked}"
    if method == "ping":
        return 200, _result(req_id, {}), "ping"
    if method == "tools/list":
        return 200, _result(req_id, {"tools": tools.TOOLS}), "tools/list"
    if method == "tools/call":
        name = params.get("name", "")
        try:
            content = await tools.call(name, params.get("arguments") or {}, base, env)
        except KeyError:
            return 200, _error(req_id, -32602, f"Unknown tool: {name}"), f"tools/call {name}"
        except Exception as e:
            content = [tools.text(f"Tool failed: {type(e).__name__}: {e}")]
            return 200, _result(req_id, {"content": content, "isError": True}), f"tools/call {name}"
        return 200, _result(req_id, {"content": content, "isError": False}), f"tools/call {name}"
    return 200, _error(req_id, -32601, f"Method not found: {method}"), method
