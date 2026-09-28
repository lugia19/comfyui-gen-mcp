"""The user config shared by every brain (Worker KV, MCPB local JSON).

Both brains read and write the same shape, so switching modes keeps settings. Pack-derived settings
(pack choice, artists, LoRAs, resolution) are keyed by pack and built into the settings UI from the
loaded packs; SETTINGS_SCHEMA covers only the global, statically known fields. Frontends may add
their own keys (the MCPB's ComfyUI URL, for instance); normalize() keeps them.

Shape:
    pack_selections   {tool_name: pack_name}
    pack_settings     {config_key: {"artist_list": str, "max_pixels": int}}
    pack_loras        {config_key: [{"name", "strength", "trigger", "hidden"}]}
    custom_workflow   {"workflow": {...API format...}, "prompt_node_title": str} or None
    keep_warm_minutes int, how long an idle generator stays up
"""

from __future__ import annotations

import copy

DEFAULT_KEEP_WARM_MINUTES = 5

DEFAULTS: dict = {
    "pack_selections": {},
    "pack_settings": {},
    "pack_loras": {},
    "custom_workflow": None,
    "keep_warm_minutes": DEFAULT_KEEP_WARM_MINUTES,
}

# Each field: key, title, description, type ("int" | "bool" | "text" | "workflow"), default,
# min/max for ints, advanced for grouping. The settings app renders these.
SETTINGS_SCHEMA: list[dict] = [
    {
        "key": "keep_warm_minutes",
        "title": "Keep warm (minutes)",
        "description": (
            "How long the GPU stays up after the last image. Longer means fewer cold starts; "
            "on Modal it also means paying for idle time."
        ),
        "type": "int",
        "default": DEFAULT_KEEP_WARM_MINUTES,
        "min": 1,
        "max": 60,
    },
    {
        "key": "custom_workflow",
        "title": "Custom workflow",
        "description": (
            "A ComfyUI workflow exported in API format. When set, it backs the generate_custom_image "
            "tool."
        ),
        "type": "workflow",
        "default": None,
        "advanced": True,
    },
]


def normalize(raw: object) -> dict:
    """Fill in defaults and drop wrongly typed known values. Unknown keys are kept. Never raises."""
    cfg = copy.deepcopy(DEFAULTS)
    if not isinstance(raw, dict):
        return cfg
    for key, val in raw.items():
        if key not in DEFAULTS:
            cfg[key] = copy.deepcopy(val)  # a newer version's or a frontend's key: keep it
        elif key == "custom_workflow":
            if val is None or (isinstance(val, dict) and isinstance(val.get("workflow"), dict)):
                cfg[key] = copy.deepcopy(val)
        elif key == "keep_warm_minutes":
            if isinstance(val, int) and not isinstance(val, bool) and val > 0:
                cfg[key] = val
        elif isinstance(val, type(DEFAULTS[key])):
            cfg[key] = copy.deepcopy(val)
    return cfg
