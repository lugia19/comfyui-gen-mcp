"""LoRA files on the Volume, copied from the Worker's R2 storage (design §4, "LoRAs").

Every LoRA comes in through an upload to the Worker, which keeps it in R2. The Volume is one of the
GPUs that copy from there: the admin API's /loras/fetch spawns `fetch`, which downloads a storage
link (a URL the Worker signs, with Range for resuming) into loras/ through a .part file, checks the
size, and renames it into place.

No modal import: the Volume root is a parameter, so tests run on a temporary directory.
"""

import os
import re
import urllib.request

MAX_SIZE = 2 << 30  # the largest Anima LoRAs are a few hundred MB
USER_AGENT = "comfy-gen-modal"  # Cloudflare 1010-blocks urllib's default against workers.dev
_LORA_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._()\-]{0,150}\.safetensors")


class LoraError(ValueError):
    """A request the client got wrong. The message is shown to the user; *status* is the HTTP code."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def validate_lora_name(name: object) -> str:
    if not isinstance(name, str) or not _LORA_NAME.fullmatch(name) or ".." in name:
        raise LoraError(f"LoRA files must be .safetensors with a plain name: {name!r}")
    return name


def validate_fetch(body: dict) -> tuple[str, str, int]:
    name = validate_lora_name(body.get("name"))
    url, size = body.get("url"), body.get("size")
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        raise LoraError("url must be an http(s) URL")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_SIZE:
        raise LoraError(f"size must be 1 byte to {MAX_SIZE >> 30} GB")
    return name, url, size


def loras_dir(root: str) -> str:
    return f"{root}/models/loras"


def list_loras(root: str) -> dict[str, int]:
    d = loras_dir(root)
    if not os.path.isdir(d):
        return {}
    return {n: os.path.getsize(f"{d}/{n}") for n in sorted(os.listdir(d)) if _LORA_NAME.fullmatch(n)}


def delete_lora(root: str, name: object) -> None:
    path = f"{loras_dir(root)}/{validate_lora_name(name)}"
    if not os.path.exists(path):
        raise LoraError(f"no LoRA named {name}", 404)
    os.remove(path)


def fetch(root: str, name: str, url: str, size: int, retries: int = 5) -> None:
    """Download *url* into loras/<name>, resuming a cut connection with a Range request."""
    os.makedirs(loras_dir(root), exist_ok=True)
    part = f"{loras_dir(root)}/{name}.part-fetch"
    for attempt in range(retries + 1):
        have = os.path.getsize(part) if os.path.exists(part) else 0
        headers = {"User-Agent": USER_AGENT, **({"Range": f"bytes={have}-"} if have else {})}
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as r:
                mode = "ab" if have and r.status == 206 else "wb"
                with open(part, mode) as out:
                    while chunk := r.read(8 << 20):
                        out.write(chunk)
        except OSError:
            if attempt == retries:
                raise
        # A connection closed early can end the read without an error: go round for the rest.
        if os.path.getsize(part) >= size:
            break
    got = os.path.getsize(part)
    if got != size:
        os.remove(part)
        raise LoraError(f"{name}: got {got} bytes, expected {size}", 502)
    os.replace(part, f"{loras_dir(root)}/{name}")
