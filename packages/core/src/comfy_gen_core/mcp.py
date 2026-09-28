"""A stateless MCP server over streamable HTTP, JSON responses only.

Implements what a tools-only server needs: initialize, notifications, ping, tools/list and
tools/call. No sessions and no SSE, so each POST gets one JSON body (the transport answers GET with
405). The official MCP SDK costs about 2 s of CPU per fresh Worker isolate (S1); this costs a few ms.

Request-independent JSON (the tool list, server info) is serialized once, when the handler is
built; in the Worker that is at import, inside the startup snapshot, or once per config.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable

# Versions we answer to; a client asking for another gets the newest of these (the spec's rule).
PROTOCOL_VERSIONS = ("2025-03-26", "2025-06-18", "2025-11-25")

# (tool name, arguments) -> (content blocks, is_error). Raise KeyError for an unknown tool.
ToolCall = Callable[[str, dict], Awaitable[tuple[list[dict], bool]]]


class McpHandler:
    def __init__(self, name: str, version: str, tools: list[dict], call: ToolCall, instructions: str | None = None):
        self._call = call
        self._tools_json = json.dumps({"tools": tools}, separators=(",", ":"))
        info = {"name": name, "version": version}
        rest = {"capabilities": {"tools": {"listChanged": False}}, "serverInfo": info}
        if instructions:
            rest["instructions"] = instructions
        # initialize's result minus protocolVersion, which depends on the request.
        self._init_rest = json.dumps(rest, separators=(",", ":"))[1:]

    async def handle(self, body: bytes) -> tuple[int, bytes | None]:
        """One POSTed JSON-RPC message in; (HTTP status, response body or None for 202) out."""
        try:
            msg = json.loads(body)
        except ValueError:
            return 400, _error(None, -32700, "Parse error")
        if not isinstance(msg, dict):
            return 400, _error(None, -32600, "Batches are not supported")

        method = msg.get("method")
        req_id = msg.get("id")
        if req_id is None:  # a notification (notifications/initialized, cancelled, ...): accept it
            return 202, None
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}

        if method == "tools/call":
            name = params.get("name")
            args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
            if not isinstance(name, str):
                return 200, _error(req_id, -32602, "tools/call needs a tool name")
            try:
                content, is_error = await self._call(name, args)
            except KeyError:
                return 200, _error(req_id, -32602, f"Unknown tool: {name}")
            except Exception as e:  # a bug in a tool: tell the model rather than dropping the call
                content, is_error = [{"type": "text", "text": f"Tool failed: {type(e).__name__}: {e}"}], True
            result = json.dumps({"content": content, "isError": is_error}, separators=(",", ":"))
            return 200, _result(req_id, result)
        if method == "tools/list":
            return 200, _result(req_id, self._tools_json)
        if method == "ping":
            return 200, _result(req_id, "{}")
        if method == "initialize":
            asked = params.get("protocolVersion")
            version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[-1]
            return 200, _result(req_id, '{"protocolVersion":' + json.dumps(version) + "," + self._init_rest)
        return 200, _error(req_id, -32601, f"Method not found: {method}")


def _result(req_id, result_json: str) -> bytes:
    return ('{"jsonrpc":"2.0","id":' + json.dumps(req_id) + ',"result":' + result_json + "}").encode()


def _error(req_id, code: int, message: str) -> bytes:
    return json.dumps({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}).encode()
