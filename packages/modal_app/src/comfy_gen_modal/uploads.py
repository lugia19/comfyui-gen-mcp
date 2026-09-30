"""LoRA files in and out of the Volume, straight from the browser or the PC agent.

A Modal web request is cut off after 150 s and a LoRA can be hundreds of MB, so uploads come in
16 MiB chunks. Each chunk is its own file, committed on its own: requests may land on different
containers, which don't see each other's writes until a commit and a reload. `assemble` then
reloads once and joins them. The upload session's random id is the capability: whoever holds it can
write that one file's chunks and finish it, nothing else.

Downloads (the PC agent copying a LoRA to itself) are sessions too: a random id that reads one file
for an hour. They answer Range requests, so a download cut off at 150 s resumes. The Worker creates
both kinds of session through the admin API.

No modal import: the store is anything dict-like (the app's modal.Dict in production), and the
Volume root is a parameter, so tests run on a temporary directory.
"""

import hashlib
import os
import re
import secrets
import shutil

CHUNK_SIZE = 16 << 20
MAX_SIZE = 2 << 30  # the largest Anima LoRAs are a few hundred MB
SESSION_S = 24 * 3600
DOWNLOAD_S = 3600
_LORA_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._()\-]{0,150}\.safetensors")
_ID = re.compile(r"[A-Za-z0-9_\-]{43}")


class UploadError(ValueError):
    """A request the client got wrong. The message is shown to the user; *status* is the HTTP code."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def validate_lora_name(name: object) -> str:
    if not isinstance(name, str) or not _LORA_NAME.fullmatch(name) or ".." in name:
        raise UploadError(f"LoRA files must be .safetensors with a plain name: {name!r}")
    return name


def loras_dir(root: str) -> str:
    return f"{root}/models/loras"


def chunk_dir(root: str, upload_id: str) -> str:
    return f"{root}/uploads/{upload_id}"


def chunk_path(root: str, upload_id: str, index: int) -> str:
    return f"{chunk_dir(root, upload_id)}/{index:05d}"


def chunk_length(session: dict, index: int) -> int:
    return min(session["chunk_size"], session["size"] - index * session["chunk_size"])


def _key(upload_id: str) -> str:
    return f"upload:{upload_id}"


def new_session(store, filename: object, size: object, origin: object, now: float) -> dict:
    name = validate_lora_name(filename)
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_SIZE:
        raise UploadError(f"size must be 1 byte to {MAX_SIZE >> 30} GB")
    if not isinstance(origin, str) or not origin.startswith(("https://", "http://")):
        raise UploadError("origin must be the settings page's origin")
    upload_id = secrets.token_urlsafe(32)
    session = {
        "id": upload_id, "filename": name, "size": size, "chunk_size": CHUNK_SIZE,
        "chunks": -(-size // CHUNK_SIZE), "origin": origin, "expires": now + SESSION_S,
        "state": "uploading", "done": 0,
    }
    store[_key(upload_id)] = session
    return session


def session(store, upload_id: str, now: float) -> dict:
    s = store.get(_key(upload_id)) if _ID.fullmatch(upload_id or "") else None
    if not s or s["expires"] < now:
        raise UploadError("unknown or expired upload", 404)
    return s


def update(store, s: dict, **changes) -> dict:
    s = {**s, **changes}
    store[_key(s["id"])] = s
    return s


def put_chunk(store, root: str, upload_id: str, index: int, data: bytes, sha256: str | None, now: float) -> dict:
    """Store one chunk. Idempotent: a retried chunk overwrites the same file."""
    s = session(store, upload_id, now)
    if s["state"] != "uploading":
        raise UploadError(f"upload is {s['state']}", 409)
    if not 0 <= index < s["chunks"]:
        raise UploadError(f"chunk {index} out of range (0 to {s['chunks'] - 1})")
    if len(data) != chunk_length(s, index):
        raise UploadError(f"chunk {index} has {len(data)} bytes, expected {chunk_length(s, index)}")
    if not sha256 or hashlib.sha256(data).hexdigest() != sha256.lower():
        raise UploadError(f"chunk {index} checksum mismatch")
    os.makedirs(chunk_dir(root, upload_id), exist_ok=True)
    tmp = chunk_path(root, upload_id, index) + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, chunk_path(root, upload_id, index))
    return s


def received(root: str, s: dict) -> list[int]:
    """Chunk indexes on disk at their full length."""
    return [i for i in range(s["chunks"])
            if os.path.exists(p := chunk_path(root, s["id"], i)) and os.path.getsize(p) == chunk_length(s, i)]


def missing(root: str, s: dict) -> list[int]:
    have = set(received(root, s))
    return [i for i in range(s["chunks"]) if i not in have]


def finish(store, root: str, upload_id: str, now: float) -> tuple[dict, bool]:
    """Mark an upload whose chunks have all arrived as assembling. Returns the session and whether
    the caller should start `assemble` (False when it was finished already). The caller reloads the
    Volume first: the chunks were committed by other containers."""
    s = session(store, upload_id, now)
    if s["state"] != "uploading":
        return s, False
    if gaps := missing(root, s):
        raise UploadError(f"{len(gaps)} chunk(s) still missing, first {gaps[0]}", 409)
    return update(store, s, state="assembling", done=0), True


def assemble(store, root: str, upload_id: str, now: float) -> dict:
    """Join the chunks into loras/<name>, then drop them; the session ends "assembled" (or "failed").
    The caller reloads the Volume first, commits after, and only then marks the session "done":
    a page that sees "done" lists the LoRAs at once (seen live: marked before the commit, the new
    file was missing from that list). *store* gets progress in "done" (bytes)."""
    s = session(store, upload_id, now)
    if gaps := missing(root, s):
        return update(store, s, state="failed", error=f"missing chunks: {gaps[:10]}")
    os.makedirs(loras_dir(root), exist_ok=True)
    dest = f"{loras_dir(root)}/{s['filename']}"
    part = f"{dest}.part-upload"
    done = 0
    with open(part, "wb") as out:
        for i in range(s["chunks"]):
            with open(chunk_path(root, upload_id, i), "rb") as fh:
                shutil.copyfileobj(fh, out, 8 << 20)
            done += chunk_length(s, i)
            s = update(store, s, done=done)
    if os.path.getsize(part) != s["size"]:
        os.remove(part)
        return update(store, s, state="failed", error="assembled size does not match")
    os.replace(part, dest)
    shutil.rmtree(chunk_dir(root, upload_id), ignore_errors=True)
    return update(store, s, state="assembled")


def sweep(store, root: str, now: float) -> int:
    """Delete chunk directories whose session expired or is finished. Returns how many."""
    base = f"{root}/uploads"
    removed = 0
    for upload_id in os.listdir(base) if os.path.isdir(base) else []:
        s = store.get(_key(upload_id)) if _ID.fullmatch(upload_id) else None
        if not s or s["expires"] < now or s["state"] in ("done", "failed"):
            shutil.rmtree(f"{base}/{upload_id}", ignore_errors=True)
            removed += 1
    return removed


def list_loras(root: str) -> dict[str, int]:
    d = loras_dir(root)
    names = sorted(os.listdir(d)) if os.path.isdir(d) else []
    return {n: os.path.getsize(f"{d}/{n}") for n in names if n.endswith(".safetensors")}


def delete_lora(root: str, name: object) -> None:
    path = f"{loras_dir(root)}/{validate_lora_name(name)}"
    if not os.path.exists(path):
        raise UploadError(f"no LoRA named {name}", 404)
    os.remove(path)


def _download_key(download_id: str) -> str:
    return f"download:{download_id}"


def new_download(store, root: str, name: object, now: float) -> dict:
    name = validate_lora_name(name)
    if not os.path.isfile(f"{loras_dir(root)}/{name}"):
        raise UploadError(f"no LoRA named {name}", 404)
    download_id = secrets.token_urlsafe(32)
    d = {"id": download_id, "filename": name, "expires": now + DOWNLOAD_S}
    store[_download_key(download_id)] = d
    return d


def download_path(store, root: str, download_id: str, now: float) -> str:
    d = store.get(_download_key(download_id)) if _ID.fullmatch(download_id or "") else None
    if not d or d["expires"] < now:
        raise UploadError("unknown or expired download", 404)
    path = f"{loras_dir(root)}/{d['filename']}"
    if not os.path.isfile(path):
        raise UploadError(f"{d['filename']} is no longer on the Volume", 404)
    return path


def cors_headers(s: dict, origin: str | None) -> dict[str, str]:
    """CORS for the browser's chunk requests: only the settings page that created the session."""
    if origin != s["origin"]:
        return {}
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "PUT, GET",
        "Access-Control-Allow-Headers": "Content-Type, X-Chunk-Sha256",
        "Access-Control-Max-Age": "3600",
        "Vary": "Origin",
    }


def web_app(store, commit, root: str, reload=None, start_assemble=None):
    """The public FastAPI app: chunk PUTs and status (CORS for the session's origin only), finishing
    an upload (the agent's; the browser finishes through the Worker), and downloads. *commit* and
    *reload* are async callables (the Volume's), *start_assemble* an async callable taking the upload
    id. The store's blocking calls run in a thread, off the event loop."""
    import asyncio
    import time

    from fastapi import FastAPI, Request, Response
    from fastapi.responses import FileResponse, JSONResponse

    api = FastAPI()

    def lookup(upload_id: str):
        try:
            return session(store, upload_id, time.time()), None
        except UploadError as e:
            return None, JSONResponse({"error": str(e)}, status_code=e.status)

    @api.options("/u/{rest:path}")
    async def preflight(rest: str, request: Request):
        s, err = await asyncio.to_thread(lookup, rest.split("/")[0])
        return err or Response(status_code=204, headers=cors_headers(s, request.headers.get("origin")))

    @api.put("/u/{upload_id}/{index}")
    async def put(upload_id: str, index: int, request: Request):
        s, err = await asyncio.to_thread(lookup, upload_id)
        if err:
            return err
        cors = cors_headers(s, request.headers.get("origin"))
        data = await request.body()
        try:
            await asyncio.to_thread(put_chunk, store, root, upload_id, index, data,
                                    request.headers.get("x-chunk-sha256"), time.time())
        except UploadError as e:
            return JSONResponse({"error": str(e)}, status_code=e.status, headers=cors)
        await commit()
        return JSONResponse({"ok": True, "index": index}, headers=cors)

    @api.get("/u/{upload_id}")
    async def status(upload_id: str, request: Request):
        s, err = await asyncio.to_thread(lookup, upload_id)
        if err:
            return err
        body = {"state": s["state"], "chunks": s["chunks"], "received": received(root, s)}
        if s.get("error"):
            body["error"] = s["error"]
        return JSONResponse(body, headers=cors_headers(s, request.headers.get("origin")))

    @api.post("/u/{upload_id}/finish")
    async def finish_upload(upload_id: str):
        if reload:
            await reload()
        try:
            s, start = await asyncio.to_thread(finish, store, root, upload_id, time.time())
        except UploadError as e:
            return JSONResponse({"error": str(e)}, status_code=e.status)
        if start and start_assemble:
            await start_assemble(upload_id)
        return JSONResponse({"state": s["state"]})

    @api.get("/d/{download_id}")
    async def download(download_id: str):
        if reload:
            await reload()
        try:
            path = await asyncio.to_thread(download_path, store, root, download_id, time.time())
        except UploadError as e:
            return JSONResponse({"error": str(e)}, status_code=e.status)
        return FileResponse(path, media_type="application/octet-stream")  # answers Range with 206

    return api
