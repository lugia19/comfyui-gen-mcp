"""Model packs: load, validate, pick one per tool, apply the user's customizations.

A pack is a JSON document: a workflow, the nodes to patch (prompt, seeds, dimensions), the model
files it needs, and the tool it backs. Several packs can back one tool (e.g. Anima and Anima Turbo
both back generate_illustrated_image); the user's config picks one.
"""

from __future__ import annotations

import copy
import json
import logging
from importlib import resources

from comfy_gen_core.workflow import inject_loras

log = logging.getLogger("comfy_gen")

REQUIRED_FIELDS = (
    "name", "display_name", "tool_name", "tool_description", "models", "workflow",
    "prompt_node_id", "seed_nodes",
)


def validate(pack: object, source: str = "pack") -> dict:
    """Check a pack has the required fields. Returns it; raises ValueError otherwise."""
    if not isinstance(pack, dict):
        raise ValueError(f"{source}: not a JSON object")
    missing = [f for f in REQUIRED_FIELDS if f not in pack]
    if missing:
        raise ValueError(f"{source}: missing required fields {missing}")
    return pack


def builtin_packs() -> list[dict]:
    """The packs shipped inside this package, sorted by file name. Bad files are logged and skipped."""
    packs = []
    root = resources.files("comfy_gen_core").joinpath("packs")
    for entry in sorted(root.iterdir(), key=lambda e: e.name):
        if not entry.name.endswith(".json"):
            continue
        try:
            packs.append(validate(json.loads(entry.read_text(encoding="utf-8")), entry.name))
        except (ValueError, json.JSONDecodeError) as e:
            log.error("Skipping pack %s: %s", entry.name, e)
    return packs


def config_key(pack: dict) -> str:
    """The config bucket a pack reads its settings from. Anima and Anima Turbo share one."""
    return pack.get("config_key", pack["name"])


def group_by_tool(packs: list[dict]) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for pack in packs:
        groups.setdefault(pack["tool_name"], []).append(pack)
    return groups


def select(groups: dict[str, list[dict]], selections: dict[str, str]) -> list[dict]:
    """One pack per tool: the configured one, else the is_default one, else the first."""
    chosen = []
    for group in groups.values():
        wanted = selections.get(group[0]["tool_name"])
        chosen.append(
            next((p for p in group if p["name"] == wanted), None)
            or next((p for p in group if p.get("is_default")), None)
            or group[0]
        )
    return chosen


def _loras(pack: dict, cfg: dict) -> list[dict]:
    raw = cfg.get("pack_loras", {}).get(config_key(pack)) or []
    if raw and not pack.get("default_artist_list"):
        # LoRAs are only supported for the Anima-family packs (the ones with an artist list).
        log.warning("Pack '%s': LoRAs configured but not supported for this pack, ignoring", pack["name"])
        return []
    loras = []
    for entry in raw:
        if isinstance(entry, str):
            entry = {"name": entry}
        if not isinstance(entry, dict) or not entry.get("name"):
            log.warning("Pack '%s': skipping malformed LoRA entry %r", pack["name"], entry)
            continue
        try:
            strength = float(entry.get("strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        loras.append({
            "name": str(entry["name"]),
            "strength": strength,
            "trigger": str(entry.get("trigger") or "").strip(),
        })
    return loras


def _max_pixels(pack: dict, cfg: dict) -> int | None:
    """The user's resolution budget, clamped to the model's limit. None when unset or invalid."""
    limit = pack.get("max_pixels_limit")
    if not limit:
        return None
    value = cfg.get("pack_settings", {}).get(config_key(pack), {}).get("max_pixels")
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        return None
    return min(value, limit)


def prepare(pack: dict, cfg: dict) -> dict:
    """A copy of *pack* with the user's LoRAs spliced in and resolution budget applied.

    Failures are logged and the pack served unmodified rather than taking the tool down.
    """
    pack = copy.deepcopy(pack)
    loras = _loras(pack, cfg)
    if loras:
        try:
            pack["lora_toggles"] = inject_loras(pack["workflow"], loras, pack.get("lora_target"))
        except ValueError as e:
            log.error("Pack '%s': LoRA injection failed (%s), serving it unmodified", pack["name"], e)
    budget = _max_pixels(pack, cfg)
    if budget is not None:
        pack["max_pixels"] = budget
    return pack


def required_nodes(pack: dict) -> dict[str, str]:
    """Custom node classes the pack needs, mapped to the node package providing them."""
    return dict(pack.get("required_nodes") or {})


def download_size(pack: dict) -> int:
    """Total bytes of the pack's model files, for the settings UI."""
    return sum(int(m.get("size_bytes") or 0) for m in pack.get("models", []))
