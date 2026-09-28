import random

import pytest

from comfy_gen_core.workflow import (
    build_prompt,
    calc_dimensions,
    class_types,
    inject_loras,
    parse_custom_workflow,
    split_lossless,
)


def small_workflow():
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "m.safetensors"}},
        "2": {"class_type": "KSampler", "inputs": {"seed": 0, "model": ["1", 0], "positive": ["3", 0]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": ""}, "_meta": {"title": "Positive"}},
        "4": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512}},
        "5": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0]}},
    }


@pytest.mark.parametrize("value, rest, flag", [
    ("portrait", "portrait", False),
    ("portrait:lossless", "portrait", True),
    ("C:/x.png:LOSSLESS", "C:/x.png", True),
    ("C:/x.png", "C:/x.png", False),
])
def test_split_lossless(value, rest, flag):
    assert split_lossless(value) == (rest, flag)


def test_calc_dimensions_named_and_custom():
    assert calc_dimensions("square", 1_048_576) == (1024, 1024)
    w, h = calc_dimensions("portrait", 1_048_576)
    assert w % 64 == 0 and h % 64 == 0 and h > w
    assert calc_dimensions("1600x900", 1_048_576) == calc_dimensions("wide", 1_048_576)
    assert calc_dimensions("nonsense", 1_048_576) == (1024, 1024)


def test_build_prompt_sets_text_seeds_dimensions_and_copies():
    wf = small_workflow()
    out = build_prompt(
        wf, "a cat", "3", [{"node_id": "2", "field": "seed"}],
        dimension_nodes={"width": [{"node_id": "4", "field": "width"}], "height": [{"node_id": "4", "field": "height"}]},
        aspect_ratio="landscape", max_pixels=1_048_576, rng=random.Random(1),
    )
    assert out["3"]["inputs"]["text"] == "a cat"
    assert out["2"]["inputs"]["seed"] != 0
    assert (out["4"]["inputs"]["width"], out["4"]["inputs"]["height"]) == calc_dimensions("landscape", 1_048_576)
    assert wf["3"]["inputs"]["text"] == ""  # the source is untouched


def test_inject_loras_chains_and_rewires_every_model_consumer():
    wf = small_workflow()
    toggles = inject_loras(wf, [{"name": "a.safetensors", "strength": 0.5}, {"name": "b.safetensors", "trigger": "@b"}])
    chain = [nid for nid, n in wf.items() if n["class_type"] == "LoraLoaderModelOnly"]
    assert chain == ["6", "7"]
    assert wf["6"]["inputs"]["model"] == ["1", 0] and wf["7"]["inputs"]["model"] == ["6", 0]
    assert wf["2"]["inputs"]["model"] == ["7", 0] and wf["5"]["inputs"]["model"] == ["7", 0]
    assert toggles == [{"node_id": "7", "trigger": "@b", "strength": 1.0}]


def test_lora_toggles_follow_the_prompt():
    wf = small_workflow()
    toggles = inject_loras(wf, [{"name": "b.safetensors", "trigger": "@B", "strength": 0.7}])
    on = build_prompt(wf, "art by @b", "3", [], lora_toggles=toggles)
    off = build_prompt(wf, "no trigger", "3", [], lora_toggles=toggles)
    assert on["6"]["inputs"]["strength_model"] == 0.7
    assert off["6"]["inputs"]["strength_model"] == 0.0


def test_inject_loras_without_a_loader_raises():
    with pytest.raises(ValueError):
        inject_loras({"1": {"class_type": "KSampler", "inputs": {}}}, [{"name": "a"}])


def test_parse_custom_workflow_rejects_ui_format():
    with pytest.raises(ValueError, match="API format"):
        parse_custom_workflow({"nodes": [], "links": []})


def test_parse_custom_workflow_finds_the_prompt_node():
    wf = small_workflow()
    assert parse_custom_workflow(wf) == (wf, "3", ["2"])  # traced from the KSampler's positive input
    assert parse_custom_workflow(wf, "positive")[1] == "3"  # by title, case-insensitive
    wf["4"]["_meta"] = {"title": "Prompt"}
    assert parse_custom_workflow(wf)[1] == "4"  # a node titled "prompt" wins over tracing
    with pytest.raises(ValueError, match="No node titled"):
        parse_custom_workflow(wf, "missing")


def test_class_types():
    assert class_types(small_workflow()) == {
        "UNETLoader", "KSampler", "CLIPTextEncode", "EmptyLatentImage", "ModelSamplingAuraFlow",
    }
