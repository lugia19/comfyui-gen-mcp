from types import SimpleNamespace

import pytest

from comfy_gen_core.packs import builtin_packs
from comfy_gen_modal.deploy import proxy_token
from comfy_gen_modal.models import needed, rel_path, validate_models, validate_pack_name

MODEL = {"url": "https://huggingface.co/x/y/resolve/main/m.safetensors", "subfolder": "vae",
         "filename": "m.safetensors", "size_bytes": 100, "sha256": "A" * 64}


def test_every_builtin_pack_passes_validation():
    # The Worker sends pack["models"] as they are; the admin endpoint must accept them.
    for pack in builtin_packs():
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
    assert isinstance(mod.seed, modal.Function) and isinstance(mod.admin, modal.Function)
    assert "comfy_gen:" in mod.EXTRA_PATHS and "  diffusion_models: diffusion_models" in mod.EXTRA_PATHS
