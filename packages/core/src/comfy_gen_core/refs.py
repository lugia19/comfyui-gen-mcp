"""Opaque image references and one-time upload tokens, signed with an HMAC key.

A reference is the ComfyUI location of an image (type, subfolder, filename), encoded and signed, so
the model can hand it back to us but can't forge one pointing at another path. Nothing is stored:
the free KV plan allows only 1,000 writes a day.

Upload tokens carry an expiry and a random nonce, also signed. They are single-use only in the sense
that the upload they authorize lands under a name derived from the nonce; a replay within the expiry
overwrites the same file.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets

from comfy_gen_core.comfyui import OutputImage
from comfy_gen_core.images import EXTENSIONS

_MAC_BYTES = 16
_TYPES = ("output", "input")
UPLOAD_SUBFOLDER = "comfy-gen-uploads"


class RefError(ValueError):
    """A reference or token is malformed, forged or expired. The message is meant for the model."""


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _mac(key: bytes, payload: str) -> str:
    return _b64(hmac.new(key, payload.encode(), hashlib.sha256).digest()[:_MAC_BYTES])


def _check(key: bytes, token: str, what: str) -> str:
    payload, sep, mac = token.strip().rpartition(".")
    if not sep or not payload or not hmac.compare_digest(mac, _mac(key, payload)):
        raise RefError(f"Invalid {what}.")
    return payload


def sign(image: OutputImage, key: bytes) -> str:
    """The image id the model sees."""
    payload = _b64(json.dumps([image.type, image.subfolder, image.filename], separators=(",", ":")).encode())
    return f"{payload}.{_mac(key, payload)}"


def verify(ref: str, key: bytes) -> OutputImage:
    """The image a reference points at. Raises RefError if it isn't one of ours."""
    payload = _check(key, ref, "image id")
    try:
        kind, subfolder, filename = json.loads(_unb64(payload))
    except (ValueError, TypeError) as e:
        raise RefError("Invalid image id.") from e
    if kind not in _TYPES or not isinstance(filename, str) or not isinstance(subfolder, str):
        raise RefError("Invalid image id.")
    return OutputImage(filename, subfolder, kind)


def mint_upload(key: bytes, now: float, ttl_s: int = 600) -> str:
    """A token authorizing one upload until now + ttl_s."""
    payload = _b64(json.dumps([int(now + ttl_s), secrets.token_urlsafe(12)], separators=(",", ":")).encode())
    return f"{payload}.{_mac(key, payload)}"


def check_upload(token: str, key: bytes, now: float) -> str:
    """The token's nonce if it is valid and unexpired. Raises RefError otherwise."""
    payload = _check(key, token, "upload link")
    try:
        expires, nonce = json.loads(_unb64(payload))
    except (ValueError, TypeError) as e:
        raise RefError("Invalid upload link.") from e
    if not isinstance(expires, int) or not isinstance(nonce, str):
        raise RefError("Invalid upload link.")
    if now > expires:
        raise RefError("This upload link has expired. Call request_upload again.")
    return nonce


def upload_filename(nonce: str, mime: str) -> str:
    """The input-folder file name for an upload authorized by *nonce*."""
    ext = EXTENSIONS.get(mime, "png")
    safe = "".join(c for c in nonce if c.isalnum() or c in "-_")
    return f"upload-{safe}.{ext}"
