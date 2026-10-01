import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from comfy_gen_modal.deploy import modal_error, proxy_token
from comfy_gen_modal.models import needed, rel_path, validate_models, validate_pack_name

MODEL = {"url": "https://huggingface.co/x/y/resolve/main/m.safetensors", "subfolder": "vae",
         "filename": "m.safetensors", "size_bytes": 100, "sha256": "A" * 64}


PACKS = Path(__file__).resolve().parents[2] / "core" / "packs"


def test_every_builtin_pack_passes_validation():
    # The Worker sends pack["models"] as they are; the admin endpoint must accept them.
    files = sorted(PACKS.glob("*.json"))
    assert len(files) >= 7
    for pack in (json.loads(f.read_text()) for f in files):
        validate_pack_name(pack["name"])
        assert len(validate_models(pack["models"])) == len(pack["models"])


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
