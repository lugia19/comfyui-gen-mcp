"""LoRA files on the Volume, copied from the Worker's R2 storage (design §4, "LoRAs").

Every LoRA comes in through an upload to the Worker, which keeps it in R2. The Volume is one of the
GPUs that copy from there: the admin API's /loras/fetch spawns `fetch`, which downloads a storage
link (a URL the Worker signs, with Range for resuming) into loras/ through a .part file, checks the
size, and renames it into place.

No modal import: the Volume root is a parameter, so tests run on a temporary directory.
"""

import os
import re

from comfy_gen_modal.download import download

MAX_SIZE = 2 << 30  # the largest Anima LoRAs are a few hundred MB
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
    path = f"{loras_dir(root)}/{name}"
    try:
        download(url, path, f"{path}.part-fetch", size=size, retries=retries)
    except ValueError as e:
        raise LoraError(str(e), 502) from e
