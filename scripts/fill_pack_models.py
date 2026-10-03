"""Fill a pack's model entries from Hugging Face: for each entry with a url, the filename (from the
url, when missing), size_bytes and sha256 (from the HEAD's x-linked-size / x-linked-etag, as
check_pack_models.py reads them). Only the pack's "models" block is rewritten.

    python scripts/fill_pack_models.py packages/core/packs/<pack>.json

A new entry needs only its url and subfolder (the ComfyUI models folder it goes in).
"""

import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(__file__))
from check_pack_models import head  # noqa: E402


def filled(model: dict) -> dict:
    url = model["url"]
    h = head(url)
    size = int(h.get("x-linked-size") or h.get("content-length") or 0)
    sha = (h.get("x-linked-etag") or "").strip('"')
    if not size:
        raise SystemExit(f"{url}: no size in the answer (not a Hugging Face file URL?)")
    out = {"filename": model.get("filename") or urllib.parse.unquote(url.rsplit("/", 1)[-1].split("?")[0])}
    out.update({k: v for k, v in model.items() if k not in ("filename", "size_bytes", "sha256")})
    out["size_bytes"] = size
    if len(sha) == 64:  # an LFS file's SHA-256; a small non-LFS file has a git hash instead
        out["sha256"] = sha
    return out


def main(path: str) -> int:
    text = open(path).read()
    pack = json.loads(text)
    models = [filled(m) for m in pack["models"]]
    lines = text.split("\n")
    start = lines.index('  "models": [')
    end = next(i for i in range(start, len(lines)) if lines[i] in ("  ],", "  ]"))
    block = json.dumps(models, indent=2).split("\n")[1:-1]
    lines[start + 1:end] = ["  " + line for line in block]
    out = "\n".join(lines)
    json.loads(out)
    open(path, "w").write(out)
    for m in models:
        print(f"{m['filename']}: {m['size_bytes'] / 1e9:.2f} GB, sha256 {m.get('sha256', '(none)')[:12]}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    sys.exit(main(sys.argv[1]))
