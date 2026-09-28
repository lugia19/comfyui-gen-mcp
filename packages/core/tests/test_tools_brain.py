import json

import pytest

from comfy_gen_core import packs
from comfy_gen_core.brain import Brain, Done, Failed, Hooks, Pending
from comfy_gen_core.comfyui import ComfyUIError
from comfy_gen_core.tools import tool_specs

pytestmark = pytest.mark.anyio

BUILTIN = packs.builtin_packs()


def names(specs):
    return [s["name"] for s in specs]


def test_tool_lists_per_mode():
    paths = tool_specs(BUILTIN, {}, "paths")
    refs = tool_specs(BUILTIN, {}, "refs")
    assert "request_upload" not in names(paths) and "request_upload" in names(refs)
    assert next(s for s in paths if s["name"] == "edit_image")["inputSchema"]["required"] == ["prompt", "image_path"]
    assert next(s for s in refs if s["name"] == "edit_image")["inputSchema"]["required"] == ["prompt", "image"]
    assert "generate_custom_image" not in names(paths)
    with_custom = tool_specs(BUILTIN, {"custom_workflow": {"workflow": {}}}, "paths")
    assert "generate_custom_image" in names(with_custom)
    assert names(paths)[-1] == "fetch_result"


def test_descriptions_fill_artists_and_visible_lora_triggers():
    cfg = {"pack_settings": {"anima": {"artist_list": "@one, @two"}},
           "pack_loras": {"anima": [{"name": "a.safetensors", "trigger": "@shown"},
                                    {"name": "b.safetensors", "trigger": "@secret", "hidden": True}]}}
    desc = next(s for s in tool_specs(BUILTIN, cfg, "refs") if s["name"] == "generate_illustrated_image")["description"]
    assert "preferred default: @one, others available: @two" in desc
    assert "@shown" in desc and "@secret" not in desc
    assert "{artist_list}" not in desc and "{lora_triggers}" not in desc


class PathHooks(Hooks):
    def __init__(self):
        self.ensured = []

    async def ensure(self, pack):
        self.ensured.append(pack["name"])

    async def resolve_image(self, arg):
        return f"{arg} [output]", (512, 512) if "small" in arg else (4096, 4096)


def brain(client, **kw):
    return Brain(BUILTIN, kw.pop("cfg", {}), client, "paths", hooks=kw.pop("hooks", PathHooks()), **kw)


async def test_generate_returns_done(client, comfy):
    out = await brain(client).call("generate_realistic_image", {"prompt": "a lighthouse", "aspect_ratio": "wide"})
    assert isinstance(out, Done) and out.prompt_id == "p1" and not out.lossless
    texts = [n["inputs"].get("text") for n in comfy.prompts[0].values()]
    assert "a lighthouse" in texts


async def test_timeout_returns_a_stateless_token_and_fetch_resumes(client, comfy):
    comfy.history = ["running"] * 3
    b = brain(client, wait_s=0)
    out = await b.call("generate_illustrated_image", {"prompt": "x", "aspect_ratio": "portrait:lossless"})
    assert isinstance(out, Pending) and out.token == "p1:lossless" and "fetch_result" in out.text()
    comfy.history = []
    again = await brain(client).call("fetch_result", {"request_token": out.token})
    assert isinstance(again, Done) and again.lossless


async def test_errors_become_failed_not_exceptions(client, comfy):
    comfy.history = ["error"]
    out = await brain(client).call("generate_realistic_image", {"prompt": "x"})
    assert isinstance(out, Failed) and "out of memory" in out.text()
    assert isinstance(await brain(client).call("generate_realistic_image", {}), Failed)


async def test_ensure_failure_is_reported(client):
    class Broken(Hooks):
        async def ensure(self, pack):
            raise ComfyUIError("Models are downloading.")

    out = await brain(client, hooks=Broken()).call("generate_realistic_image", {"prompt": "x"})
    assert isinstance(out, Failed) and out.message == "Models are downloading."


async def test_inventory_check_names_missing_nodes(client, comfy):
    out = await brain(client, inventory={"KSampler"}).call("generate_realistic_image", {"prompt": "x"})
    assert isinstance(out, Failed) and "UnetLoaderGGUF (from ComfyUI-GGUF)" in out.message
    assert comfy.prompts == []


async def test_edit_single_and_multi(client, comfy):
    hooks = PathHooks()
    b = brain(client, hooks=hooks)
    edit_pack = next(p for p in BUILTIN if p["tool_name"] == "edit_image" and p.get("is_default"))
    assert isinstance(await b.call("edit_image", {"prompt": "make it night", "image_path": "small.png"}), Done)
    wf = comfy.prompts[0]
    assert wf[str(edit_pack["image_nodes"][0])]["inputs"]["image"] == "small.png [output]"
    scale = wf[str(edit_pack["edit_scale_nodes"][0])]["inputs"]["megapixels"]
    assert scale == round(512 * 512 / 1_048_576, 4)  # small input passes through at native size

    await b.call("edit_image", {"prompt": "combine", "image_path": "big.png", "second_image_path": "small.png"})
    wf2 = comfy.prompts[1]
    loads = [wf2[str(n)]["inputs"]["image"] for n in edit_pack["image_nodes_multi"]]
    assert loads == ["big.png [output]", "small.png [output]"]
    big_scale = wf2[str(edit_pack["edit_scale_nodes_multi"][0])]["inputs"]["megapixels"]
    assert big_scale == round(edit_pack["max_pixels"] / 1_048_576, 4)  # oversized input clamped
    assert hooks.ensured == [edit_pack["name"], edit_pack["name"]]


async def test_custom_workflow(client, comfy):
    wf = {"1": {"class_type": "KSamplerAdvanced", "inputs": {"noise_seed": 0, "positive": ["2", 0]}},
          "2": {"class_type": "CLIPTextEncode", "inputs": {"text": ""}}}
    b = brain(client, cfg={"custom_workflow": {"workflow": wf}})
    assert isinstance(await b.call("generate_custom_image", {"prompt": "hello"}), Done)
    assert comfy.prompts[0]["2"]["inputs"]["text"] == "hello"
    assert comfy.prompts[0]["1"]["inputs"]["noise_seed"] != 0
    bad = brain(client, cfg={"custom_workflow": {"workflow": {"nodes": []}}})
    assert "API format" in (await bad.call("generate_custom_image", {"prompt": "x"})).message


async def test_unknown_tools_raise_key_error(client):
    b = brain(client)
    with pytest.raises(KeyError):
        await b.call("no_such_tool", {})
    with pytest.raises(KeyError):
        await b.call("generate_custom_image", {"prompt": "x"})  # not configured


def test_specs_are_json_serializable(client):
    json.dumps(brain(client).specs)


async def test_brain_turns_an_exhausted_budget_into_a_token(comfy):
    from comfy_gen_core.comfyui import ComfyUIClient

    client = ComfyUIClient(comfy, poll_interval_s=0, request_budget=8)
    comfy.history = ["running"] * 100
    out = await brain(client, wait_s=3600).call("generate_realistic_image", {"prompt": "x"})
    assert isinstance(out, Pending) and out.token == "p1"
    assert client.requests_made <= 8
