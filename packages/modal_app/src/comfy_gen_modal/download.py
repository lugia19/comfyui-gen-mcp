"""One download for every file the Modal app fetches: models from Hugging Face (seeds) and LoRAs
from the Worker's storage links. Into a .part file, renamed into place once complete and checked.

No modal import: tests run it on a temporary directory.
"""

import hashlib
import os
import urllib.request

USER_AGENT = "comfy-gen-modal"  # Cloudflare 1010-blocks urllib's default against workers.dev


def _sha256_of(path: str):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8 << 20):
            digest.update(chunk)
    return digest


def download(url: str, path: str, part: str, *, size=None, sha256=None, retries=0, on_bytes=None) -> None:
    """Download *url* to *path* through *part*. A cut connection is resumed with a Range request, up to
    *retries* times. Raises ValueError (removing the .part) when the *size* or *sha256* doesn't match."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    digest = None
    for attempt in range(retries + 1):
        have = os.path.getsize(part) if os.path.exists(part) else 0
        headers = {"User-Agent": USER_AGENT, **({"Range": f"bytes={have}-"} if have else {})}
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as r:
                resumed = bool(have) and r.status == 206
                if sha256:  # hashed as it arrives; a resumed file's earlier bytes first
                    digest = _sha256_of(part) if resumed else hashlib.sha256()
                with open(part, "ab" if resumed else "wb") as out:
                    while chunk := r.read(8 << 20):
                        out.write(chunk)
                        if digest:
                            digest.update(chunk)
                        if on_bytes:
                            on_bytes(len(chunk))
        except OSError:
            if attempt == retries:
                raise
        # A connection closed early can end the read without an error: go round for the rest.
        if size is None or os.path.getsize(part) >= size:
            break
    name = os.path.basename(path)
    got = os.path.getsize(part)
    problem = (
        f"{name}: got {got} bytes, expected {size}" if size is not None and got != size
        else f"{name}: checksum mismatch" if sha256 and digest and digest.hexdigest() != sha256
        else None
    )
    if problem:
        os.remove(part)
        raise ValueError(problem)
    os.replace(part, path)
