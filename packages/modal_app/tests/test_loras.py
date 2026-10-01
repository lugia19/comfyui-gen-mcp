"""The Volume's LoRA files: list, delete, and fetch from the Worker's storage links."""

from __future__ import annotations

import http.server
import threading

import pytest

from comfy_gen_modal import loras


@pytest.mark.parametrize("name", ["a.safetensors", "My Style v2 (final).safetensors", "x_1-2.safetensors"])
def test_lora_names_ok(name):
    assert loras.validate_lora_name(name) == name


@pytest.mark.parametrize("name", ["../a.safetensors", "a.ckpt", "", ".a.safetensors", "a/b.safetensors", None, "a..b.safetensors"])
def test_lora_names_rejected(name):
    with pytest.raises(loras.LoraError):
        loras.validate_lora_name(name)


def test_fetch_requests_are_checked():
    ok = {"name": "a.safetensors", "url": "https://w.example/store/t", "size": 10}
    assert loras.validate_fetch(ok) == ("a.safetensors", "https://w.example/store/t", 10)
    for bad in ({**ok, "url": "file:///etc/passwd"}, {**ok, "size": 0}, {**ok, "size": True}, {**ok, "name": "../x.safetensors"}):
        with pytest.raises(loras.LoraError):
            loras.validate_fetch(bad)


def test_list_and_delete(tmp_path):
    d = tmp_path / "models" / "loras"
    d.mkdir(parents=True)
    (d / "a.safetensors").write_bytes(b"12345")
    (d / "notes.txt").write_text("x")
    assert loras.list_loras(str(tmp_path)) == {"a.safetensors": 5}
    loras.delete_lora(str(tmp_path), "a.safetensors")
    assert loras.list_loras(str(tmp_path)) == {}
    with pytest.raises(loras.LoraError) as e:
        loras.delete_lora(str(tmp_path), "a.safetensors")
    assert e.value.status == 404


@pytest.fixture
def server():
    """A storage link: serves DATA, honouring Range; cut_at drops the first answer after that many bytes."""
    data = bytes(range(256)) * 400
    state = {"cut_at": None, "ranges": []}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            start = 0
            rng = self.headers.get("Range")
            state["ranges"].append(rng)
            if rng:
                start = int(rng.split("=")[1].split("-")[0])
            body = data[start:]
            self.send_response(206 if rng else 200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if state["cut_at"] is not None:
                cut, state["cut_at"] = state["cut_at"], None
                self.wfile.write(body[:cut])
                self.wfile.flush()
                self.connection.close()
                return
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/store/t", data, state
    srv.shutdown()


def test_fetch_downloads_and_resumes(tmp_path, server):
    url, data, state = server
    state["cut_at"] = 30000
    loras.fetch(str(tmp_path), "s.safetensors", url, len(data))
    assert (tmp_path / "models" / "loras" / "s.safetensors").read_bytes() == data
    assert state["ranges"] == [None, "bytes=30000-"]
    assert not (tmp_path / "models" / "loras" / "s.safetensors.part-fetch").exists()


def test_fetch_refuses_a_wrong_size(tmp_path, server):
    url, data, _ = server
    with pytest.raises(loras.LoraError):
        loras.fetch(str(tmp_path), "s.safetensors", url, len(data) + 1)
    assert loras.list_loras(str(tmp_path)) == {}
