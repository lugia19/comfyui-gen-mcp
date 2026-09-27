"""The same tools, served by the official MCP SDK (v2 MCPServer, stateless, JSON responses).

Follows cloudflare/python-workers-examples/mcp-server: build the Starlette app once per isolate
and hand each request to it through workers.asgi.
"""

from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import CallToolResult

import tools


def build_app(path: str, base: str, env):
    server = MCPServer("comfy-gen-spike (sdk)")

    async def run(name: str, args: dict) -> CallToolResult:
        return CallToolResult.model_validate({"content": await tools.call(name, args, base, env)})

    desc = {t["name"]: t["description"] for t in tools.TOOLS}

    @server.tool(name="ping", description=desc["ping"])
    async def ping() -> CallToolResult:
        return await run("ping", {})

    @server.tool(name="image_link", description=desc["image_link"])
    async def image_link() -> CallToolResult:
        return await run("image_link", {})

    @server.tool(name="image_link_text", description=desc["image_link_text"])
    async def image_link_text() -> CallToolResult:
        return await run("image_link_text", {})

    @server.tool(name="image_inline", description=desc["image_inline"])
    async def image_inline() -> CallToolResult:
        return await run("image_inline", {})

    @server.tool(name="image_both", description=desc["image_both"])
    async def image_both() -> CallToolResult:
        return await run("image_both", {})

    @server.tool(name="request_upload", description=desc["request_upload"])
    async def request_upload(filename: str) -> CallToolResult:
        return await run("request_upload", {"filename": filename})

    @server.tool(name="show_upload", description=desc["show_upload"])
    async def show_upload(image_id: str) -> CallToolResult:
        return await run("show_upload", {"image_id": image_id})

    @server.tool(name="sibling", description=desc["sibling"])
    async def sibling() -> CallToolResult:
        return await run("sibling", {})

    @server.tool(name="slow", description=desc["slow"])
    async def slow(seconds: int = 60) -> CallToolResult:
        return await run("slow", {"seconds": seconds})

    return server.streamable_http_app(
        streamable_http_path=path,
        stateless_http=True,
        json_response=True,
        # The SDK turns on localhost-only Host checks by default; this runs on workers.dev.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
