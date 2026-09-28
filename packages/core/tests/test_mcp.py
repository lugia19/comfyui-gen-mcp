import json

import pytest

from comfy_gen_core.mcp import PROTOCOL_VERSIONS, McpHandler

pytestmark = pytest.mark.anyio

TOOLS = [{"name": "echo", "description": "d", "inputSchema": {"type": "object"}}]


async def call(name, args):
    if name == "boom":
        raise RuntimeError("kaput")
    if name != "echo":
        raise KeyError(name)
    return [{"type": "text", "text": args.get("x", "")}], False


def handler():
    return McpHandler("test", "1.0", TOOLS, call, instructions="be nice")


async def rpc(method, params=None, id=1):
    msg = {"jsonrpc": "2.0", "method": method}
    if id is not None:
        msg["id"] = id
    if params is not None:
        msg["params"] = params
    status, body = await handler().handle(json.dumps(msg).encode())
    return status, json.loads(body) if body else None


async def test_initialize_negotiates_the_version():
    _, r = await rpc("initialize", {"protocolVersion": "2025-06-18"})
    assert r["result"]["protocolVersion"] == "2025-06-18"
    assert r["result"]["serverInfo"] == {"name": "test", "version": "1.0"}
    assert r["result"]["instructions"] == "be nice"
    _, r = await rpc("initialize", {"protocolVersion": "1999-01-01"})
    assert r["result"]["protocolVersion"] == PROTOCOL_VERSIONS[-1]


async def test_notifications_get_202_and_no_body():
    assert await rpc("notifications/initialized", id=None) == (202, None)


async def test_tools_list_and_call():
    _, r = await rpc("tools/list", id="a")
    assert r["id"] == "a" and r["result"]["tools"] == TOOLS
    _, r = await rpc("tools/call", {"name": "echo", "arguments": {"x": "hi"}})
    assert r["result"] == {"content": [{"type": "text", "text": "hi"}], "isError": False}


async def test_unknown_tool_is_a_protocol_error_and_a_crash_is_a_tool_error():
    _, r = await rpc("tools/call", {"name": "nope"})
    assert r["error"]["code"] == -32602
    _, r = await rpc("tools/call", {"name": "boom"})
    assert r["result"]["isError"] and "kaput" in r["result"]["content"][0]["text"]


async def test_bad_input():
    assert (await handler().handle(b"{not json"))[0] == 400
    assert (await handler().handle(b"[]"))[0] == 400
    _, r = await rpc("resources/list")
    assert r["error"]["code"] == -32601
    _, r = await rpc("ping")
    assert r["result"] == {}
