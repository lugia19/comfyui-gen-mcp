import copy

import pytest

from comfy_gen_core import config, packs


@pytest.fixture(scope="module")
def builtin():
    return packs.builtin_packs()


def test_builtin_packs_load(builtin):
    names = {p["name"] for p in builtin}
    assert {"anima", "anima_turbo", "flux2klein", "flux2klein_edit", "z_image_turbo"} <= names
    for p in builtin:
        assert "comfy-dxt" not in str(p["workflow"])  # renamed output prefix


def test_validate_names_missing_fields():
    with pytest.raises(ValueError, match="missing required fields"):
        packs.validate({"name": "x"})


def test_select_prefers_configured_then_default_then_first(builtin):
    groups = packs.group_by_tool(builtin)
    by_tool = {p["tool_name"]: p["name"] for p in packs.select(groups, {})}
    defaults = {p["tool_name"]: p["name"] for p in builtin if p.get("is_default")}
    for tool, name in defaults.items():
        assert by_tool[tool] == name
    illustrated = groups["generate_illustrated_image"]
    other = next(p["name"] for p in illustrated if p["name"] != by_tool["generate_illustrated_image"])
    chosen = packs.select(groups, {"generate_illustrated_image": other})
    assert other in {p["name"] for p in chosen}


def test_prepare_splices_loras_only_for_anima(builtin):
    anima = next(p for p in builtin if p["name"] == "anima")
    klein = next(p for p in builtin if p["name"] == "flux2klein")
    cfg = {"pack_loras": {"anima": [{"name": "style.safetensors", "trigger": "@style"}],
                          "flux2klein": [{"name": "x.safetensors"}]}}
    prepared = packs.prepare(anima, cfg)
    assert any(n["class_type"] == "LoraLoaderModelOnly" for n in prepared["workflow"].values())
    assert prepared["lora_toggles"][0]["trigger"] == "@style"
    assert not any(n["class_type"] == "LoraLoaderModelOnly" for n in packs.prepare(klein, cfg)["workflow"].values())
    assert "lora_toggles" not in anima  # the builtin pack is untouched


def test_prepare_clamps_max_pixels_to_the_limit(builtin):
    pack = next(p for p in builtin if p.get("max_pixels_limit"))
    key = packs.config_key(pack)
    over = packs.prepare(pack, {"pack_settings": {key: {"max_pixels": pack["max_pixels_limit"] * 10}}})
    assert over["max_pixels"] == pack["max_pixels_limit"]
    bad = packs.prepare(pack, {"pack_settings": {key: {"max_pixels": "big"}}})
    assert bad["max_pixels"] == pack["max_pixels"]


def test_normalize_fills_defaults_and_keeps_unknown_keys():
    cfg = config.normalize({"keep_warm_minutes": 0, "pack_loras": "junk", "comfyui_url": "http://x"})
    assert cfg["keep_warm_minutes"] == config.DEFAULT_KEEP_WARM_MINUTES
    assert cfg["pack_loras"] == {}
    assert cfg["comfyui_url"] == "http://x"
    assert config.normalize(None) == config.DEFAULTS
    raw = {"custom_workflow": {"workflow": {"1": {}}}}
    out = config.normalize(raw)
    out["custom_workflow"]["workflow"]["1"]["x"] = 1
    assert raw == {"custom_workflow": {"workflow": {"1": {}}}}  # a deep copy
    assert config.normalize({"custom_workflow": "nope"})["custom_workflow"] is None
    assert copy.deepcopy(config.DEFAULTS) == config.normalize({})
