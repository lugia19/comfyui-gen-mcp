"""Check every pack's model entries (and the model sets in tools.json) against Hugging Face: the size and sha256 in the pack must match
what the URL serves (HEAD, x-linked-size / x-linked-etag). The Modal seed skips files whose size
matches, so a wrong size means a re-download on every seed.

    python scripts/check_pack_models.py
"""

import glob
import json
import os
import sys
import time
import urllib.error
import urllib.request

PACKS = os.path.join(os.path.dirname(__file__), "..", "packages", "core", "packs")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # the LFS headers are on the redirect itself


def head(url: str):
    """(status, headers) of the file's redirect. A refusal (429, 5xx: CI runners share their IPs and
    get rate limited) is asked again a few times."""
    opener = urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "comfy-gen-ci"})
    for attempt in range(4):
        try:
            resp = opener.open(req, timeout=60)
            status, headers = resp.status, resp.headers
        except urllib.error.HTTPError as e:
            status, headers = e.code, e.headers
        if headers.get("x-linked-size") or not (status == 429 or status >= 500) or attempt == 3:
            return status, headers
        time.sleep(2 ** (attempt + 1))


MODEL_SETS = ("remove_marks", "remove_background")  # tools.json's model sets (core packs.ts)


def model_lists():
    """(source, models) per pack, and per model set in tools.json (the tool definitions)."""
    for path in sorted(glob.glob(os.path.join(PACKS, "*.json"))):
        data = json.load(open(path))
        name = os.path.basename(path)
        if name == "tools.json":
            for key in MODEL_SETS:
                yield f"{name} {key}", data[key]["models"]
        else:
            yield name, data["models"]


def main() -> int:
    bad, seen = 0, {}
    for source, models in model_lists():
        for m in models:
            if m["url"] not in seen:
                status, h = head(m["url"])
                # Not the file's redirect (no x-linked-size): say what came back, not a size mismatch.
                seen[m["url"]] = (int(h.get("x-linked-size") or 0), (h.get("x-linked-etag") or "").strip('"'), status)
            size, sha, status = seen[m["url"]]
            problems = []
            if not size:
                problems.append(f"HTTP {status} without the file's headers (refused, or a wrong URL)")
            elif size != m.get("size_bytes"):
                problems.append(f"size {m.get('size_bytes')} != {size}")
            if size and m.get("sha256") and sha != m["sha256"]:
                problems.append(f"sha256 {m['sha256'][:12]}… != {sha[:12]}…")
            if problems:
                bad += 1
                print(f"{source}: {m['filename']}: {'; '.join(problems)}")
    print(f"{len(seen)} files checked, {bad} problems")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
