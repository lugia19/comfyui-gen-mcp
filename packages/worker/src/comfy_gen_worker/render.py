"""Brain outcomes to MCP content.

Results are inline WebP: claude.ai shows inline images and ignores resource_link (S2, S2c).
ComfyUI converts on the way out (/view?preview=webp;90), so the Worker only base64s the bytes, at
about 10 ms of CPU per MB (S2b). Each image comes with a text block carrying its id (for edits) and
a full-resolution link for the user.
"""

from __future__ import annotations

import base64

from comfy_gen_core import refs
from comfy_gen_core.brain import Done, Failed, Outcome, Pending
from comfy_gen_core.comfyui import ComfyUIClient, ComfyUIError
from comfy_gen_core.images import sniff_mime

PREVIEW = "webp;90"
PREVIEW_SMALLER = "webp;75"
MAX_INLINE_BYTES = 700_000


def text(s: str) -> dict:
    return {"type": "text", "text": s}


async def render(outcome: Outcome, client: ComfyUIClient, base_url: str, hmac_key: bytes) -> tuple[list[dict], bool]:
    """(content blocks, is_error) for an outcome."""
    if isinstance(outcome, Pending):
        return [text(outcome.text())], False
    if isinstance(outcome, Failed):
        return [text(outcome.text())], True
    assert isinstance(outcome, Done)
    content: list[dict] = []
    for image in outcome.images:
        try:
            if outcome.lossless:
                resp = await client.view(image)
            else:
                resp = await client.view(image, preview=PREVIEW)
                if len(resp.content) > MAX_INLINE_BYTES:
                    resp = await client.view(image, preview=PREVIEW_SMALLER)
        except ComfyUIError as e:
            return [text(f"Error: the image was generated but could not be fetched: {e}")], True
        ref = refs.sign(image, hmac_key)
        mime = sniff_mime(resp.content) or "image/png"
        content.append({"type": "image", "data": base64.b64encode(resp.content).decode(), "mimeType": mime})
        content.append(text(f"image_id: {ref}\nFull resolution: {base_url}/img/{ref}"))
    return content, False
