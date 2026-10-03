"""Check every pack's model entries against Hugging Face: the size and sha256 in the pack must match
what the URL serves (HEAD, x-linked-size / x-linked-etag). The Modal seed skips files whose size
matches, so a wrong size means a re-download on every seed.

    python scripts/check_pack_models.py
"""

import glob
import json
import os
import sys
import urllib.error
import urllib.request

PACKS = os.path.join(os.path.dirname(__file__), "..", "packages", "core", "packs")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # the LFS headers are on the redirect itself


def head(url: str):
    opener = urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "comfy-gen-ci"})
    try:
        return opener.open(req, timeout=60).headers
    except urllib.error.HTTPError as e:
        return e.headers


def main() -> int:
    bad, seen = 0, {}
    for path in sorted(glob.glob(os.path.join(PACKS, "*.json"))):
        if os.path.basename(path) == "tools.json":  # the tool definitions, not a pack
            continue
        for m in json.load(open(path))["models"]:
            if m["url"] not in seen:
                h = head(m["url"])
                seen[m["url"]] = (int(h.get("x-linked-size") or h.get("content-length") or 0),
                                  (h.get("x-linked-etag") or "").strip('"'))
            size, sha = seen[m["url"]]
            problems = []
            if size != m.get("size_bytes"):
                problems.append(f"size {m.get('size_bytes')} != {size}")
            if m.get("sha256") and sha != m["sha256"]:
                problems.append(f"sha256 {m['sha256'][:12]}… != {sha[:12]}…")
            if problems:
                bad += 1
                print(f"{os.path.basename(path)}: {m['filename']}: {'; '.join(problems)}")
    print(f"{len(seen)} files checked, {bad} problems")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
