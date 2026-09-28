"""Model files on the Volume: validation and what still needs downloading. No modal import, so the
tests (and the admin endpoint's input checks) run without the SDK."""

from __future__ import annotations

import re

VOL = "/vol"
MODELS_DIR = f"{VOL}/models"
INPUT_DIR = f"{VOL}/input"
OUTPUT_DIR = f"{VOL}/output"

# The folders ComfyUI's loaders read, mapped in extra_model_paths.yaml.
SUBFOLDERS = ("diffusion_models", "text_encoders", "vae", "loras")

_SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._\-]{0,199}")
_SHA256 = re.compile(r"[0-9a-f]{64}")


def validate_pack_name(name: object) -> str:
    if not isinstance(name, str) or not _SAFE_NAME.fullmatch(name):
        raise ValueError(f"bad pack name: {name!r}")
    return name


def validate_models(models: object) -> list[dict]:
    """The pack's model entries, checked: an https URL, a known subfolder, a plain file name, and
    optionally a size and sha256. Raises ValueError. Only these keys are kept."""
    if not isinstance(models, list) or not models:
        raise ValueError("models must be a non-empty list")
    out = []
    for m in models:
        if not isinstance(m, dict):
            raise ValueError("each model must be an object")
        url, sub, name = m.get("url"), m.get("subfolder"), m.get("filename")
        if not isinstance(url, str) or not url.startswith("https://"):
            raise ValueError(f"bad url: {url!r}")
        if sub not in SUBFOLDERS:
            raise ValueError(f"bad subfolder: {sub!r}")
        if not isinstance(name, str) or not _SAFE_NAME.fullmatch(name) or ".." in name:
            raise ValueError(f"bad filename: {name!r}")
        size, sha = m.get("size_bytes"), m.get("sha256")
        if size is not None and (not isinstance(size, int) or isinstance(size, bool) or size <= 0):
            raise ValueError(f"bad size for {name}")
        if sha is not None and (not isinstance(sha, str) or not _SHA256.fullmatch(sha.lower())):
            raise ValueError(f"bad sha256 for {name}")
        out.append({"url": url, "subfolder": sub, "filename": name, "size_bytes": size,
                    "sha256": sha.lower() if sha else None})
    return out


def rel_path(model: dict) -> str:
    return f"{model['subfolder']}/{model['filename']}"


def needed(models: list[dict], present: dict[str, int]) -> list[dict]:
    """The models not yet on the Volume. *present* maps rel_path to the file's size; a file of the
    wrong size (an interrupted copy from before .part files, a changed upstream) is fetched again."""
    todo = []
    for m in models:
        size = present.get(rel_path(m))
        if size is None or (m.get("size_bytes") and size != m["size_bytes"]):
            todo.append(m)
    return todo
