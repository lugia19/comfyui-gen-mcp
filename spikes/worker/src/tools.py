"""The spike's MCP tools, shared by both MCP variants (SDK and hand-rolled).

Each tool returns a list of MCP content blocks as plain dicts (wire format, camelCase).
"""

import asyncio
import base64
import json
import secrets
import time

import canned

UPLOAD_TOKEN_TTL = 600
UPLOAD_TTL = 86400

_NOTE = " (Infrastructure test tool. After calling it, tell the user exactly what you received.)"

TOOLS: list[dict] = [
    {
        "name": "ping",
        "description": "Returns 'pong'. Baseline for CPU time." + _NOTE,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "image_link",
        "description": "Returns a test image as a resource_link only. Describe the image if you can see it." + _NOTE,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "image_link_text",
        "description": "Returns a test image as a resource_link plus a text block with its URL. Describe the image if you can see it." + _NOTE,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "image_inline",
        "description": "Returns a test image as inline image content only. Describe the image if you can see it." + _NOTE,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "image_both",
        "description": "Returns a test image as a resource_link and as inline image content. Describe the image if you can see it." + _NOTE,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "request_upload",
        "description": (
            "Get a one-time upload link for a file the user attached to the chat. Returns Python "
            "code to run in your code execution environment; it uploads the file and prints an "
            "image_id. Then call show_upload with that image_id." + _NOTE
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"filename": {"type": "string", "description": "Name of the attached file."}},
            "required": ["filename"],
        },
    },
    {
        "name": "show_upload",
        "description": "Returns an image uploaded through request_upload, as a resource_link and inline image. Describe it." + _NOTE,
        "inputSchema": {
            "type": "object",
            "properties": {"image_id": {"type": "string"}},
            "required": ["image_id"],
        },
    },
    {
        "name": "sibling",
        "description": "Reports whether the worker could import its workspace sibling package." + _NOTE,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "slow",
        "description": "Waits the given number of seconds, then returns. Tests how long a tool call may block." + _NOTE,
        "inputSchema": {
            "type": "object",
            "properties": {"seconds": {"type": "integer", "default": 60}},
        },
    },
]


def text(s: str) -> dict:
    return {"type": "text", "text": s}


def link(url: str, name: str, mime: str = "image/png") -> dict:
    return {"type": "resource_link", "uri": url, "name": name, "mimeType": mime}


def image(data: bytes, mime: str = "image/png") -> dict:
    return {"type": "image", "data": base64.b64encode(data).decode(), "mimeType": mime}


CANNED_IMAGE = image(canned.PNG)  # encoded once, inside the startup snapshot


def sniff_mime(data: bytes) -> str:
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


UPLOAD_SNIPPET = '''import glob, json, os, urllib.request
name = {filename!r}
hits = [p for root in ("/mnt", os.getcwd(), os.path.expanduser("~"))
        for p in glob.glob(os.path.join(root, "**", name), recursive=True)]
if not hits:
    raise SystemExit(f"{{name}} not found; attached files are usually under /mnt/user-data/uploads")
print("uploading", hits[0])
data = open(hits[0], "rb").read()
req = urllib.request.Request({url!r}, data=data, method="POST",
                             headers={{"Content-Type": "application/octet-stream",
                                      "User-Agent": "comfy-gen-upload/0.1"}})
print(json.load(urllib.request.urlopen(req, timeout=60)))
'''


async def call(name: str, args: dict, base: str, env) -> list[dict]:
    """Run one tool. *base* is the public URL prefix including the secret path."""
    img_url = f"{base}/img/canned.png"
    if name == "ping":
        return [text("pong")]
    if name == "image_link":
        return [link(img_url, "canned.png")]
    if name == "image_link_text":
        return [link(img_url, "canned.png"), text(f"Image URL: {img_url}")]
    if name == "image_inline":
        return [CANNED_IMAGE]
    if name == "image_both":
        return [link(img_url, "canned.png"), CANNED_IMAGE]
    if name == "request_upload":
        token = secrets.token_urlsafe(18)
        await env.SPIKE_KV.put(f"utok:{token}", str(args.get("filename", "")), expirationTtl=UPLOAD_TOKEN_TTL)
        snippet = UPLOAD_SNIPPET.format(filename=str(args.get("filename", "")), url=f"{base}/upload/{token}")
        return [text(
            "Run this Python in your code execution environment. It prints a JSON object with an "
            "image_id; then call show_upload with it. The link works once and expires in 10 minutes. "
            "If the request is blocked, the user needs to allow this domain in their code execution "
            "network settings.\n\n```python\n" + snippet + "```"
        )]
    if name == "show_upload":
        image_id = str(args.get("image_id", ""))
        raw = await env.SPIKE_KV.get(f"upload:{image_id}")
        if not raw:
            return [text(f"No upload with id {image_id!r} (expired or never uploaded).")]
        meta = json.loads(raw)
        data = base64.b64decode(meta["b64"])
        return [
            link(f"{base}/uploads/{image_id}", meta.get("filename") or image_id, meta["mime"]),
            image(data, meta["mime"]),
            text(f"{len(data)} bytes, {meta['mime']}, uploaded {meta['filename']!r}"),
        ]
    if name == "sibling":
        try:
            from comfy_gen_spike_sibling import hello
            return [text(hello())]
        except Exception as e:
            return [text(f"sibling import FAILED: {type(e).__name__}: {e}")]
    if name == "slow":
        seconds = max(0, min(int(args.get("seconds") or 60), 600))
        t = time.monotonic()
        await asyncio.sleep(seconds)
        return [text(f"waited {time.monotonic() - t:.1f}s")]
    raise KeyError(name)
