"""Workflow building: prompt injection, seeds, dimensions, LoRA splicing, custom workflows.

Pure functions over ComfyUI API-format workflow dicts. No I/O, so it runs anywhere.
"""

from __future__ import annotations

import copy
import logging
import math
import random
import re

log = logging.getLogger("comfy_gen")

ASPECT_RATIOS: dict[str, tuple[int, int]] = {
    "square":    (1, 1),
    "portrait":  (3, 4),
    "landscape": (4, 3),
    "tall":      (9, 16),
    "wide":      (16, 9),
}

# "1024x768"-style aspect override; deliberately absent from the tool schemas and descriptions.
# It's for scripted callers, not the model.
_WH_RE = re.compile(r"^\s*(\d+)\s*[xX]\s*(\d+)\s*$")

# ":lossless" suffix on an existing string argument, asking for a PNG instead of the default lossy
# format. Smuggled rather than a real parameter so the model never sees it. Same audience as "WxH".
_LOSSLESS_SUFFIX = ":lossless"

# Loaders whose output carries MODEL, and at which index. LoRAs go on the model path only.
MODEL_LOADERS: dict[str, int] = {
    "UNETLoader": 0,
    "UnetLoaderGGUF": 0,
    "CheckpointLoaderSimple": 0,
    "CheckpointLoader": 0,
}

SAMPLERS = ("KSampler", "KSamplerAdvanced")


def split_lossless(value: str) -> tuple[str, bool]:
    """Strip a trailing ':lossless' marker (case-insensitive), returning (rest, flag).

    Only a trailing match is stripped, so Windows drive colons survive.
    """
    s = (value or "").strip()
    if s.lower().endswith(_LOSSLESS_SUFFIX):
        return s[: -len(_LOSSLESS_SUFFIX)].strip(), True
    return value, False


def calc_dimensions(aspect: str, max_pixels: int) -> tuple[int, int]:
    """Width and height for an aspect ratio name (or "WxH") within a pixel budget.

    "WxH" sets the shape, not the size: it is scaled to the same budget. Unknown values fall back to
    square. Rounds to multiples of 64 (latent alignment).
    """
    ratio = ASPECT_RATIOS.get(aspect)
    if ratio is None:
        m = _WH_RE.match(aspect or "")
        if m and int(m.group(1)) > 0 and int(m.group(2)) > 0:
            ratio = (int(m.group(1)), int(m.group(2)))
        else:
            ratio = (1, 1)
    w_ratio, h_ratio = ratio
    scale = math.sqrt(max_pixels / (w_ratio * h_ratio))
    w = round(w_ratio * scale / 64) * 64
    h = round(h_ratio * scale / 64) * 64
    return max(w, 64), max(h, 64)


def build_prompt(
    workflow: dict,
    prompt_text: str,
    prompt_node_id: str,
    seed_nodes: list[dict],
    dimension_nodes: dict | None = None,
    aspect_ratio: str = "square",
    max_pixels: int = 1_048_576,
    lora_toggles: list[dict] | None = None,
    rng: random.Random | None = None,
) -> dict:
    """Deep-copy a workflow, inject the prompt, randomize seeds, set dimensions.

    seed_nodes: [{"node_id": "19", "field": "seed"}, ...]
    dimension_nodes: {"width": [{"node_id": "28", "field": "width"}], "height": [...]}
    lora_toggles: [{"node_id": "58", "trigger": "@mychar", "strength": 0.8}, ...]. Each node gets its
        strength when its trigger is a case-insensitive substring of the prompt, otherwise 0.
    """
    rng = rng or random
    wf = copy.deepcopy(workflow)
    wf[str(prompt_node_id)]["inputs"]["text"] = prompt_text

    for sn in seed_nodes:
        nid, field = str(sn["node_id"]), sn["field"]
        if nid in wf:
            wf[nid]["inputs"][field] = rng.randint(0, 2**64 - 1)

    if dimension_nodes:
        w, h = calc_dimensions(aspect_ratio, max_pixels)
        for axis, value in (("width", w), ("height", h)):
            for patch in dimension_nodes.get(axis, []):
                if str(patch["node_id"]) in wf:
                    wf[str(patch["node_id"])]["inputs"][patch["field"]] = value

    if lora_toggles:
        lowered = prompt_text.lower()
        for tog in lora_toggles:
            nid = str(tog["node_id"])
            if nid not in wf:
                continue
            trigger = tog.get("trigger") or ""
            active = (not trigger) or (trigger.lower() in lowered)
            wf[nid]["inputs"]["strength_model"] = float(tog["strength"]) if active else 0.0

    return wf


def _find_loader_source(workflow: dict, loaders: dict[str, int]) -> list | None:
    for node_id, node in workflow.items():
        idx = loaders.get(node.get("class_type"))
        if idx is not None:
            return [node_id, idx]
    return None


def _next_node_id(workflow: dict) -> int:
    highest = 0
    for key in workflow:
        try:
            highest = max(highest, int(key))
        except (TypeError, ValueError):
            continue
    return highest + 1


def _consumers_of(workflow: dict, source: list) -> list[tuple[str, str]]:
    """Every (node_id, input_key) whose input link is exactly *source* ([node_id, index])."""
    matches = []
    for node_id, node in workflow.items():
        for key, val in node.get("inputs", {}).items():
            if isinstance(val, list) and len(val) == 2 and val[0] == source[0] and val[1] == source[1]:
                matches.append((node_id, key))
    return matches


def inject_loras(workflow: dict, loras: list[dict], target: dict | None = None) -> list[dict]:
    """Splice a chain of LoraLoaderModelOnly nodes after the model loader, in place.

    Each lora is {"name", "strength" (default 1.0), "trigger" (optional)}. Every downstream MODEL
    consumer is rewired to the end of the chain. Returns toggle descriptors for the trigger-gated
    LoRAs, for build_prompt. *target* can override detection: {"model": [id, idx]}.

    Raises ValueError if there is no model loader to attach to.
    """
    if not loras:
        return []

    target = target or {}
    model_src = target.get("model") or _find_loader_source(workflow, MODEL_LOADERS)
    if model_src is None:
        raise ValueError(
            "Could not locate a model loader to attach LoRAs to. "
            f"Known loaders: {sorted(MODEL_LOADERS)}. "
            "Set a 'lora_target' override in the pack JSON if this workflow is non-standard."
        )

    # Record consumers before splicing, so the new nodes aren't rewired.
    model_consumers = _consumers_of(workflow, model_src)

    next_id = _next_node_id(workflow)
    model_head = model_src
    toggles: list[dict] = []
    for lora in loras:
        strength = float(lora.get("strength", 1.0))
        trigger = str(lora.get("trigger") or "").strip()
        node_id = str(next_id)
        next_id += 1
        title = f"Load LoRA (injected{', trigger=' + trigger if trigger else ''})"
        workflow[node_id] = {
            "inputs": {"lora_name": lora["name"], "strength_model": strength, "model": model_head},
            "class_type": "LoraLoaderModelOnly",
            "_meta": {"title": title},
        }
        model_head = [node_id, 0]
        if trigger:
            toggles.append({"node_id": node_id, "trigger": trigger, "strength": strength})

    for node_id, key in model_consumers:
        workflow[node_id]["inputs"][key] = model_head

    return toggles


def parse_custom_workflow(wf: object, prompt_node_title: str | None = None) -> tuple[dict, str, list[str]]:
    """Validate a custom API-format workflow, returning (workflow, prompt_node_id, sampler_ids).

    The prompt node is the one titled *prompt_node_title* (case-insensitive) if given, else a node
    titled "prompt", else the first KSampler's positive input.

    Raises ValueError with a message meant for the user.
    """
    if not isinstance(wf, dict) or "nodes" in wf or not wf or not all(isinstance(v, dict) for v in wf.values()):
        raise ValueError(
            "The workflow is not in API format. In ComfyUI, enable dev mode "
            "(Settings > Enable Dev mode Options) and use 'Save (API Format)' / 'Export (API)' "
            "instead of the regular Save."
        )

    samplers = [nid for nid, node in wf.items() if node.get("class_type") in SAMPLERS]

    def title(node: dict) -> str:
        return str(node.get("_meta", {}).get("title", "")).strip().lower()

    if prompt_node_title:
        wanted = prompt_node_title.strip().lower()
        for node_id, node in wf.items():
            if title(node) == wanted:
                return wf, node_id, samplers
        available = [f"  {nid}: {n.get('_meta', {}).get('title', '(no title)')}" for nid, n in wf.items()]
        raise ValueError(
            f"No node titled '{prompt_node_title}' in the workflow.\nAvailable nodes:\n" + "\n".join(available)
        )

    if not samplers:
        raise ValueError(
            "The workflow has no KSampler and no prompt node title is configured. "
            "Set the prompt node title in settings."
        )

    for node_id, node in wf.items():
        if title(node) == "prompt":
            return wf, node_id, samplers

    positive = wf[samplers[0]].get("inputs", {}).get("positive")
    if not (isinstance(positive, list) and positive):
        raise ValueError("Could not find the prompt node: the first KSampler has no positive input link.")
    return wf, str(positive[0]), samplers


def class_types(workflow: dict) -> set[str]:
    """Every node class a workflow uses, for validating against a generator's inventory."""
    return {str(n.get("class_type")) for n in workflow.values() if isinstance(n, dict) and n.get("class_type")}
