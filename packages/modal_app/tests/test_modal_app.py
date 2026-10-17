import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from comfy_gen_modal.deploy import modal_error, post, proxy_token, report
from comfy_gen_modal.models import needed, rel_path, validate_models, validate_pack_name

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
