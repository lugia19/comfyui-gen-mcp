import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from comfy_gen_modal.deploy import modal_error, post, proxy_token, report
from comfy_gen_modal.models import delete_models, needed, rel_path, stored, validate_files, validate_models, validate_pack_name

MODEL = {"url": "https://huggingface.co/x/y/resolve/main/m.safetensors", "subfolder": "vae",
         "filename": "m.safetensors", "size_bytes": 100, "sha256": "A" * 64}


PACKS = Path(__file__).resolve().parents[2] / "core" / "packs"


def test_every_builtin_pack_passes_validation():
    # The Worker sends pack["models"] as they are; the admin endpoint must accept them.
    files = sorted(f for f in PACKS.glob("*.json") if f.name != "tools.json")  # tools.json: the tool definitions
    assert len(files) >= 7
    for pack in (json.loads(f.read_text()) for f in files):
        validate_pack_name(pack["name"])
        assert len(validate_models(pack["models"])) == len(pack["models"])


def test_the_watermark_removal_models_pass_validation():
    # Seeded as a pack of their own (core packs.ts MARK_MODELS), into our node's folder.
    marks = json.loads((PACKS / "tools.json").read_text())["remove_marks"]
    validate_pack_name(marks["name"])
    assert [m["subfolder"] for m in validate_models(marks["models"])] == ["comfy_gen", "comfy_gen"]


def test_the_background_removal_models_pass_validation():
    # Seeded from the start (core packs.ts BG_MODELS): RMBG 2.0 into ComfyUI's own background_removal
    # folder, isnet-anime into our node's.
    bg = json.loads((PACKS / "tools.json").read_text())["remove_background"]
    validate_pack_name(bg["name"])
    assert [m["subfolder"] for m in validate_models(bg["models"])] == ["background_removal", "comfy_gen"]


def test_validation_keeps_known_keys_and_normalizes_the_hash():
    (m,) = validate_models([{**MODEL, "extra": 1}])
    assert m == {**MODEL, "sha256": "a" * 64}


@pytest.mark.parametrize("bad", [
    {"url": "http://plain.example/m"},
    {"url": "file:///etc/passwd"},
    {"subfolder": "custom_nodes"},
    {"filename": "../../root/.bashrc"},
    {"filename": "a/b.safetensors"},
    {"filename": ".hidden"},
    {"size_bytes": -1},
    {"size_bytes": True},
    {"sha256": "nothex"},
])
def test_validation_rejects(bad):
    with pytest.raises(ValueError):
        validate_models([{**MODEL, **bad}])


@pytest.mark.parametrize("name", ["", "a/b", "../x", None, "x" * 300])
def test_pack_names(name):
    with pytest.raises(ValueError):
        validate_pack_name(name)


def test_needed_skips_complete_files_only():
    a = {**MODEL, "filename": "a.safetensors"}
    b = {**MODEL, "filename": "b.safetensors"}
    c = {**MODEL, "filename": "c.safetensors", "size_bytes": None}
    present = {rel_path(a): 100, rel_path(b): 42, rel_path(c): 7}
    assert needed([a, b, c], present) == [b]  # b is truncated; c has no size to check
    assert needed([a], {}) == [a]


def test_stored_and_deleted_models_are_only_the_named_ones(tmp_path):
    (tmp_path / "vae").mkdir()
    (tmp_path / "vae" / "a.safetensors").write_bytes(b"123")
    (tmp_path / "vae" / "b.safetensors").write_bytes(b"45")
    assert stored(str(tmp_path), ["vae/a.safetensors", "vae/missing.gguf"]) == {"vae/a.safetensors": 3}
    assert delete_models(str(tmp_path), ["vae/a.safetensors", "vae/missing.gguf"]) == {"vae/a.safetensors": 3}
    assert sorted(p.name for p in (tmp_path / "vae").iterdir()) == ["b.safetensors"]


@pytest.mark.parametrize("bad", [["loras/a.safetensors"], ["vae/../x"], ["vae/"], ["etc/passwd"], ["vae/a/b"], "vae/a", [3], ["x"] * 101])
def test_stored_model_files_are_checked(bad):
    with pytest.raises(ValueError):
        validate_files(bad)


def test_proxy_token_is_minted_once():
    minted = []

    def create():
        minted.append(1)
        return SimpleNamespace(token_id="wk-1", token_secret="ws-1")

    token, new = proxy_token(None, create)
    assert new and token == {"id": "wk-1", "secret": "ws-1"}
    again, new = proxy_token(token, create)
    assert not new and again == token and len(minted) == 1


def test_app_defines_what_deploy_looks_up():
    import modal

    from comfy_gen_modal import app as mod

    assert mod.app.name == mod.APP_NAME == "comfy-gen"
    assert all(isinstance(getattr(mod, n), modal.Function) for n in ("seed", "admin", "fetch_lora"))
    assert "comfy_gen:" in mod.EXTRA_PATHS and "  diffusion_models: diffusion_models" in mod.EXTRA_PATHS


def test_comfy_args_go_after_ours_as_a_list():
    from comfy_gen_modal import app as mod

    argv = mod.comfy_argv(["--reserve-vram", "2", "--some-dir", "/a b"])
    assert argv[:3] == ["comfy", "launch", "--"]
    assert argv[-7:] == ["--cache-ram", "4", "6", "--reserve-vram", "2", "--some-dir", "/a b"]  # no shell: a space stays


def test_comfy_args_refuse_where_comfyui_listens_and_keeps_files():
    from comfy_gen_modal.comfy_args import validate_comfy_args

    assert validate_comfy_args(["--lowvram", "--cache-ram", "8"]) == ["--lowvram", "--cache-ram", "8"]
    assert validate_comfy_args([]) == []
    for bad in (["--listen", "0.0.0.0"], ["--liste"], ["--output-directory=/x"], "--lowvram", [1], ["lowvram"],
                ["--a\nb"], ["--fast"] * 41, ["--x", "a" * 301]):
        with pytest.raises(ValueError):
            validate_comfy_args(bad)


def test_comfyui_that_wont_run_with_the_flags_starts_again_without_them(monkeypatch):
    import sys
    import time

    from comfy_gen_modal import app as mod

    # A ComfyUI that refuses any flag of the user's, as argparse does, and otherwise keeps running.
    script = "import sys, time\nif sys.argv[1:]: print('main.py: error: unrecognized arguments:', *sys.argv[1:]); sys.exit(2)\ntime.sleep(60)"
    monkeypatch.setattr(mod, "comfy_argv", lambda user: [sys.executable, "-c", script, *user])
    monkeypatch.setattr(mod, "state", {"comfy_args": ["--bogus"]})
    mod._launch()
    deadline = time.monotonic() + 20
    while "comfy_args_error" not in mod.state and time.monotonic() < deadline:
        time.sleep(0.1)
    try:
        error = mod.state["comfy_args_error"]
        assert error["args"] == ["--bogus"] and "unrecognized arguments: --bogus" in error["output"]
        assert mod._proc_args == [] and mod._proc.poll() is None  # running, without them
    finally:
        mod._stop()


PAYMENT_LOG = """Built image im-gefkBmufHh1oFqRfPbgzr9 in 4.65s


╭─ Error ──────────────────────────────────────────────────────────────────────╮
│ Please add a payment method to use L4 GPU functions.                         │
╰──────────────────────────────────────────────────────────────────────────────╯
"""


def test_modal_error_reads_the_error_panel():
    assert modal_error(PAYMENT_LOG) == "Please add a payment method to use L4 GPU functions."
    two_lines = "╭─ Error ─────╮\n│ Token missing. Could not │\n│ authenticate client.     │\n╰─────────────╯\n"
    assert modal_error(two_lines) == "Token missing. Could not authenticate client."
    assert modal_error("building...\nsomething broke\n\n") == "something broke"
    assert modal_error("") == "modal deploy failed"


def test_report_is_the_build_callbacks_body():
    ok = report({"server_url": "https://s", "admin_url": "https://a", "proxy_token_id": "wk", "proxy_token_secret": "ws"}, "n1", "v2.0.0")
    assert ok == {"nonce": "n1", "stage": "modal", "version": "v2.0.0", "modal_result": "deployed",
                  "modal": {"server_url": "https://s", "admin_url": "https://a", "proxy_token_id": "wk", "proxy_token_secret": "ws"}}
    bad = report({"error": "Please add a payment method"}, "n1", "v2.0.0")
    assert bad["modal_result"] == "failed" and bad["modal_error"] == "Please add a payment method" and "modal" not in bad


def test_post_sends_its_user_agent_and_retries_a_5xx(monkeypatch):
    import io
    import urllib.error
    import urllib.request

    seen = []

    class Resp(io.BytesIO):
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def urlopen(req, timeout):
        seen.append((req.full_url, req.get_header("User-agent"), req.data))
        if len(seen) == 1:
            raise urllib.error.HTTPError(req.full_url, 502, "bad gateway", {}, None)
        return Resp(b"{}")

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    monkeypatch.setattr("time.sleep", lambda s: None)
    post("https://w.example/build-callback", {"nonce": "n"})
    assert len(seen) == 2 and seen[1][1] == "comfy-gen-modal" and b'"nonce": "n"' in seen[1][2]

    seen.clear()

    def refuse(req, timeout):
        seen.append(req)
        raise urllib.error.HTTPError(req.full_url, 403, "bad nonce", {}, None)

    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    post("https://w.example/build-callback", {"nonce": "n"})
    assert len(seen) == 1  # a 4xx isn't retried
