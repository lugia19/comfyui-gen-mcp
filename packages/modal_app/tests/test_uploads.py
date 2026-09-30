import asyncio
import hashlib
import os

import pytest
from fastapi.testclient import TestClient

from comfy_gen_modal import uploads
from comfy_gen_modal.uploads import UploadError

ORIGIN = "https://comfy-gen.someone.workers.dev"
NOW = 1_800_000_000.0


@pytest.fixture
def small_chunks(monkeypatch):
    monkeypatch.setattr(uploads, "CHUNK_SIZE", 10)


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def put_all(store, root, s, data):
    for i in range(s["chunks"]):
        part = data[i * s["chunk_size"]:(i + 1) * s["chunk_size"]]
        uploads.put_chunk(store, root, s["id"], i, part, sha(part), NOW)


@pytest.mark.parametrize("name", ["a.safetensors", "My LoRA (v2)_x-1.safetensors"])
def test_lora_names_ok(name):
    assert uploads.validate_lora_name(name) == name


@pytest.mark.parametrize("name", ["a.ckpt", "../a.safetensors", "a/b.safetensors", ".a.safetensors", "", None,
                                  "x" * 200 + ".safetensors"])
def test_lora_names_rejected(name):
    with pytest.raises(UploadError):
        uploads.validate_lora_name(name)


@pytest.mark.parametrize("size", [0, -1, True, 1.5, uploads.MAX_SIZE + 1])
def test_session_size_limits(size):
    with pytest.raises(UploadError):
        uploads.new_session({}, "a.safetensors", size, ORIGIN, NOW)


def test_upload_and_assemble(tmp_path, small_chunks):
    store, root = {}, str(tmp_path)
    data = os.urandom(35)
    s = uploads.new_session(store, "style.safetensors", len(data), ORIGIN, NOW)
    assert s["chunks"] == 4 and len(s["id"]) == 43
    # out of order, one retried
    for i in [3, 1, 0, 2, 1]:
        part = data[i * 10:(i + 1) * 10]
        uploads.put_chunk(store, root, s["id"], i, part, sha(part), NOW)
    assert uploads.missing(root, s) == []
    done = uploads.assemble(store, root, s["id"], NOW)
    assert done["state"] == "assembled" and done["done"] == 35  # "done" only after the commit
    assert (tmp_path / "models/loras/style.safetensors").read_bytes() == data
    assert not (tmp_path / "uploads" / s["id"]).exists()
    assert uploads.list_loras(root) == {"style.safetensors": 35}


def test_chunk_checks(tmp_path, small_chunks):
    store, root = {}, str(tmp_path)
    s = uploads.new_session(store, "a.safetensors", 25, ORIGIN, NOW)
    good = b"x" * 10
    with pytest.raises(UploadError, match="out of range"):
        uploads.put_chunk(store, root, s["id"], 3, good, sha(good), NOW)
    with pytest.raises(UploadError, match="expected 5"):
        uploads.put_chunk(store, root, s["id"], 2, good, sha(good), NOW)  # the last chunk is short
    with pytest.raises(UploadError, match="checksum"):
        uploads.put_chunk(store, root, s["id"], 0, good, sha(b"other"), NOW)
    with pytest.raises(UploadError, match="checksum"):
        uploads.put_chunk(store, root, s["id"], 0, good, None, NOW)
    with pytest.raises(UploadError, match="expired") as e:
        uploads.put_chunk(store, root, s["id"], 0, good, sha(good), NOW + uploads.SESSION_S + 1)
    assert e.value.status == 404
    with pytest.raises(UploadError, match="unknown"):
        uploads.put_chunk(store, root, "../../etc", 0, good, sha(good), NOW)


def test_assemble_refuses_gaps_and_finished_uploads_take_no_chunks(tmp_path, small_chunks):
    store, root = {}, str(tmp_path)
    s = uploads.new_session(store, "a.safetensors", 20, ORIGIN, NOW)
    uploads.put_chunk(store, root, s["id"], 0, b"y" * 10, sha(b"y" * 10), NOW)
    assert uploads.assemble(store, root, s["id"], NOW)["state"] == "failed"
    assert not (tmp_path / "models/loras/a.safetensors").exists()
    with pytest.raises(UploadError, match="failed") as e:
        uploads.put_chunk(store, root, s["id"], 1, b"y" * 10, sha(b"y" * 10), NOW)
    assert e.value.status == 409


def test_sweep_removes_finished_and_expired_chunks(tmp_path, small_chunks):
    store, root = {}, str(tmp_path)
    live = uploads.new_session(store, "a.safetensors", 10, ORIGIN, NOW)
    old = uploads.new_session(store, "b.safetensors", 10, ORIGIN, NOW - uploads.SESSION_S - 5)
    for s in (live, old):
        uploads.put_chunk(store, root, s["id"], 0, b"z" * 10, sha(b"z" * 10), NOW - uploads.SESSION_S - 5 if s is old else NOW)
    os.makedirs(tmp_path / "uploads" / "stray")
    assert uploads.sweep(store, root, NOW) == 2
    assert os.listdir(tmp_path / "uploads") == [live["id"]]


def test_delete(tmp_path):
    (tmp_path / "models/loras").mkdir(parents=True)
    (tmp_path / "models/loras/a.safetensors").write_bytes(b"1")
    uploads.delete_lora(str(tmp_path), "a.safetensors")
    assert uploads.list_loras(str(tmp_path)) == {}
    with pytest.raises(UploadError) as e:
        uploads.delete_lora(str(tmp_path), "a.safetensors")
    assert e.value.status == 404
    with pytest.raises(UploadError):
        uploads.delete_lora(str(tmp_path), "../../input/x.safetensors")


def test_web_app(tmp_path, small_chunks):
    store, root, commits = {}, str(tmp_path), []

    async def commit():
        commits.append(1)

    client = TestClient(uploads.web_app(store, commit, root))
    s = uploads.new_session(store, "a.safetensors", 15, ORIGIN, 4_000_000_000)  # far from expiry
    url = f"/u/{s['id']}"

    pre = client.options(f"{url}/0", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "PUT"})
    assert pre.status_code == 204 and pre.headers["access-control-allow-origin"] == ORIGIN
    assert "X-Chunk-Sha256" in pre.headers["access-control-allow-headers"]
    other = client.options(f"{url}/0", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in other.headers

    r = client.put(f"{url}/0", content=b"a" * 10, headers={"Origin": ORIGIN, "X-Chunk-Sha256": sha(b"a" * 10)})
    assert r.status_code == 200 and r.headers["access-control-allow-origin"] == ORIGIN and commits == [1]
    bad = client.put(f"{url}/1", content=b"b" * 5, headers={"Origin": ORIGIN, "X-Chunk-Sha256": sha(b"x")})
    assert bad.status_code == 400 and "checksum" in bad.json()["error"]
    assert bad.headers["access-control-allow-origin"] == ORIGIN  # the browser can read the error
    assert client.get(url, headers={"Origin": ORIGIN}).json() == {"state": "uploading", "chunks": 2, "received": [0]}
    assert client.put("/u/nope/0", content=b"x").status_code == 404


def test_finish_through_the_web_app(tmp_path, small_chunks):
    store, root, started, reloads = {}, str(tmp_path), [], []

    async def commit():
        pass

    async def reload():
        reloads.append(1)

    async def start(upload_id):
        started.append(upload_id)

    client = TestClient(uploads.web_app(store, commit, root, reload, start))
    s = uploads.new_session(store, "a.safetensors", 15, ORIGIN, 4_000_000_000)
    client.put(f"/u/{s['id']}/0", content=b"a" * 10, headers={"X-Chunk-Sha256": sha(b"a" * 10)})
    early = client.post(f"/u/{s['id']}/finish")
    assert early.status_code == 409 and "missing" in early.json()["error"] and started == []
    client.put(f"/u/{s['id']}/1", content=b"b" * 5, headers={"X-Chunk-Sha256": sha(b"b" * 5)})
    assert client.post(f"/u/{s['id']}/finish").json() == {"state": "assembling"}
    assert client.post(f"/u/{s['id']}/finish").json() == {"state": "assembling"}  # a retry starts nothing
    assert started == [s["id"]] and len(reloads) == 3
    assert client.post("/u/nope/finish").status_code == 404


def test_downloads(tmp_path):
    store, root = {}, str(tmp_path)
    (tmp_path / "models/loras").mkdir(parents=True)
    data = os.urandom(100)
    (tmp_path / "models/loras/a.safetensors").write_bytes(data)
    with pytest.raises(UploadError) as e:
        uploads.new_download(store, root, "b.safetensors", NOW)
    assert e.value.status == 404
    with pytest.raises(UploadError):
        uploads.new_download(store, root, "../x.safetensors", NOW)

    async def noop():
        pass

    client = TestClient(uploads.web_app(store, noop, root, noop))
    d = uploads.new_download(store, root, "a.safetensors", 4_000_000_000)
    whole = client.get(f"/d/{d['id']}")
    assert whole.status_code == 200 and whole.content == data
    rest = client.get(f"/d/{d['id']}", headers={"Range": "bytes=60-"})  # resuming a cut download
    assert rest.status_code == 206 and rest.content == data[60:]
    assert client.get("/d/nope").status_code == 404
    old = uploads.new_download(store, root, "a.safetensors", 1_000_000_000)  # long expired
    assert client.get(f"/d/{old['id']}").status_code == 404
    os.remove(tmp_path / "models/loras/a.safetensors")
    assert "no longer" in client.get(f"/d/{d['id']}").json()["error"]
