"""Images the user attached in claude.ai, uploaded through the code-execution sandbox (S3).

request_upload hands the model a one-time link and a Python snippet. The sandbox runs the snippet,
which posts the attached file to /upload/<token>; the Worker stores it in ComfyUI's input folder
and answers with an image id that edit_image takes.
"""

from __future__ import annotations

from comfy_gen_core import refs
from comfy_gen_core.comfyui import ComfyUIClient, ComfyUIError
from comfy_gen_core.images import sniff_mime

from comfy_gen_worker.http import Response

UPLOAD_TTL_S = 600
MAX_UPLOAD_BYTES = 20_000_000

# The snippet sets its own User-Agent: Cloudflare rejects urllib's default with Error 1010.
SNIPPET = '''import glob, os, urllib.request
name = {filename!r}
hits = [p for root in ("/mnt", os.getcwd(), os.path.expanduser("~"))
        for p in glob.glob(os.path.join(root, "**", name), recursive=True)]
if not hits:
    raise SystemExit(f"{{name}} not found; attached files are usually under /mnt/user-data/uploads")
data = open(hits[0], "rb").read()
req = urllib.request.Request({url!r}, data=data, method="POST",
                             headers={{"Content-Type": "application/octet-stream",
                                       "User-Agent": "comfy-gen-upload"}})
print(urllib.request.urlopen(req, timeout=120).read().decode())
'''


def request_upload(args: dict, base_url: str, hmac_key: bytes, now: float) -> tuple[list[dict], bool]:
    """The request_upload tool: a fresh link and the snippet to use it."""
    filename = str(args.get("filename") or "").strip()
    if not filename:
        return [{"type": "text", "text": "Error: filename is required."}], True
    token = refs.mint_upload(hmac_key, now, UPLOAD_TTL_S)
    code = SNIPPET.format(filename=filename, url=f"{base_url}/upload/{token}")
    return [{"type": "text", "text": (
        "Run this Python in your code execution environment. It uploads the attached file and prints "
        "a JSON object with an image_id; pass that image_id to edit_image. The link expires in 10 "
        "minutes. If the request is blocked, the user needs to allow this domain in their code "
        "execution network settings.\n\n```python\n" + code + "```"
    )}], False


async def receive(token: str, body: bytes, client: ComfyUIClient, hmac_key: bytes, now: float) -> Response:
    """POST /upload/<token>: store the body in ComfyUI's input folder, answer with its image id."""
    try:
        nonce = refs.check_upload(token, hmac_key, now)
    except refs.RefError as e:
        return Response.error(403, str(e))
    if not body:
        return Response.error(400, "empty body")
    if len(body) > MAX_UPLOAD_BYTES:
        return Response.error(413, "image too large")
    mime = sniff_mime(body)
    if mime is None:
        return Response.error(415, "not a PNG, JPEG, WebP or GIF image")
    try:
        image = await client.upload(body, refs.upload_filename(nonce, mime), mime, subfolder=refs.UPLOAD_SUBFOLDER)
    except ComfyUIError as e:
        return Response.error(502, str(e))
    return Response.json({"image_id": refs.sign(image, hmac_key), "bytes": len(body), "mime": mime})
