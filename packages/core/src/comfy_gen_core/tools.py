"""The MCP tool list: names, descriptions, input schemas.

Computed from packs and config alone (no generator, no server), because the MCPB's stdio shim must
answer tools/list before its local server is up.

Two image modes, because the two brains see images differently:
    "paths"  MCPB. Claude Desktop runs on the same machine, so edit_image takes local paths.
    "refs"   Worker. Claude never sees a filesystem: images are opaque ids, and attached images come
             in through request_upload and the code-execution sandbox.
"""

from __future__ import annotations

from comfy_gen_core import packs as packs_mod

IMAGE_MODES = ("paths", "refs")

_ASPECT_PROP = {
    "type": "string",
    "enum": ["square", "portrait", "landscape", "tall", "wide"],
    "default": "square",
    "description": "Image shape: square (1:1), portrait (3:4), landscape (4:3), tall (9:16), wide (16:9).",
}

GENERATION_SCHEMA = {
    "type": "object",
    "properties": {"prompt": {"type": "string"}, "aspect_ratio": _ASPECT_PROP},
    "required": ["prompt"],
}

EDIT_SCHEMA_PATHS = {
    "type": "object",
    "properties": {
        "prompt": {"type": "string"},
        "image_path": {"type": "string"},
        "second_image_path": {"type": "string"},
    },
    "required": ["prompt", "image_path"],
}

EDIT_SCHEMA_REFS = {
    "type": "object",
    "properties": {
        "prompt": {"type": "string"},
        "image": {"type": "string", "description": "An image id, or a public https URL."},
        "second_image": {"type": "string", "description": "Optional second image id or https URL."},
    },
    "required": ["prompt", "image"],
}

FETCH_SCHEMA = {
    "type": "object",
    "properties": {"request_token": {"type": "string"}},
    "required": ["request_token"],
}

UPLOAD_SCHEMA = {
    "type": "object",
    "properties": {
        "filename": {
            "type": "string",
            "description": "Name of the attached file, as it appears in your code execution environment.",
        },
    },
    "required": ["filename"],
}

CUSTOM_DESC = (
    "Generate an image using the user's custom ComfyUI workflow. "
    "Use natural language to describe the image. "
    "The aspect_ratio parameter controls image shape: "
    "square (1:1), portrait (3:4), landscape (4:3), tall (9:16), wide (16:9). Default is square."
)

FETCH_DESC = (
    "Fetch the result of an image generation that is still in progress. "
    "Use this when a generation tool returns a request_token instead of an image."
)

_EDIT_SIZING = (
    "Optionally pass a second image as reference material. When using two images, refer to them as "
    "'image1' and 'image2' in the prompt.\n\n"
    "The output keeps the size and aspect ratio of the FIRST image (image1): it comes back at the "
    "resolution it went in at, unless it is very large, in which case it is scaled down to fit the "
    "model's budget. The second image only serves as reference material. So when combining images "
    "(e.g. putting image2's subject into image1's scene), pass the one whose framing should be kept "
    "first.\n\n"
)

_EDIT_TIPS = (
    "Prompting tips:\n"
    "- Be precise and verbatim when describing desired changes (e.g. 'change the text to say \"Hello World\"')\n"
    "- For targeted edits, say 'change nothing else' and mention what should stay the same\n"
    "- Describe what you want the result to look like, not the editing operation"
)

EDIT_DESC_PATHS = (
    "Edit an image using a text prompt. "
    "image_path can be a local file path (e.g. C:/Users/me/photo.png) or a publicly accessible URL. "
    "Previously generated images return their saved_path; use that.\n\n"
    "If the user uploads an image to the chat to be edited, ask them for its file path on their "
    "machine or a public URL instead, as uploaded chat images cannot be accessed directly. On Windows, "
    "the user can get a file's path by holding Shift, right-clicking the file, and selecting "
    "'Copy as path'.\n\n"
    + _EDIT_SIZING + _EDIT_TIPS
)

EDIT_DESC_REFS = (
    "Edit an image using a text prompt. `image` is an image id or a public https URL. Every image "
    "these tools return comes with its image id, and request_upload returns one for an image the user "
    "attached.\n\n"
    "To edit an image the user attached to the chat, call request_upload with its filename, run the "
    "code it returns in your code execution environment, and pass the image id it prints. If code "
    "execution is unavailable, ask the user to enable it (Settings > Capabilities > Code execution "
    "and file creation) or to give a public URL.\n\n"
    + _EDIT_SIZING + _EDIT_TIPS
)

UPLOAD_DESC = (
    "Get a one-time upload link for an image the user attached to the chat, so edit_image can use it. "
    "Returns Python code to run in your code execution environment; it uploads the file and prints the "
    "image id to pass to edit_image. The link expires after 10 minutes, so call this right before the "
    "edit."
)

# Tools defined here rather than by a generation pack. A pack whose tool_name is one of these (the
# edit packs back edit_image) is data for that tool, not a tool of its own.
STATIC_TOOLS = frozenset({"generate_custom_image", "edit_image", "fetch_result", "request_upload"})


def describe(pack: dict, groups: dict[str, list[dict]], cfg: dict) -> str:
    """Final tool description for a selected pack.

    A tool with several packs uses group_tool_description. {artist_list} is filled from the
    configured artists (else the pack's defaults), {lora_triggers} from the configured trigger-gated
    LoRAs.
    """
    key = packs_mod.config_key(pack)
    desc = pack["tool_description"]
    if len(groups.get(pack["tool_name"], [])) > 1 and pack.get("group_tool_description"):
        desc = pack["group_tool_description"]

    if pack.get("default_artist_list"):
        artists = cfg.get("pack_settings", {}).get(key, {}).get("artist_list") or pack["default_artist_list"]
        parts = [a.strip() for a in artists.split(",") if a.strip()]
        if parts:
            others = ", ".join(parts[1:]) or "none"
            artists = f"preferred default: {parts[0]}, others available: {others}"
        desc = desc.replace("{artist_list}", artists)

    if "{lora_triggers}" in desc:
        triggers: list[str] = []
        for e in cfg.get("pack_loras", {}).get(key, []):
            if not isinstance(e, dict) or e.get("hidden"):
                continue  # hidden LoRAs still gate on their trigger but aren't advertised
            trig = (e.get("trigger") or "").strip()
            if trig and trig not in triggers:
                triggers.append(trig)
        lora_text = ""
        if triggers:
            lora_text = (
                "\n\nThe following trigger words will cause a LoRA to be applied to the prompt "
                "(these can be either artist styles, usually prefixed with @, or concept tags). "
                "These triggers must be used verbatim: " + ", ".join(triggers) + "."
            )
        desc = desc.replace("{lora_triggers}", lora_text)

    return desc


def tool_specs(all_packs: list[dict], cfg: dict, image_mode: str) -> list[dict]:
    """[{name, description, inputSchema}] for every tool this brain serves."""
    if image_mode not in IMAGE_MODES:
        raise ValueError(f"image_mode must be one of {IMAGE_MODES}")
    groups = packs_mod.group_by_tool(all_packs)
    selected = packs_mod.select(groups, cfg.get("pack_selections", {}))
    specs = [
        {"name": p["tool_name"], "description": describe(p, groups, cfg), "inputSchema": GENERATION_SCHEMA}
        for p in selected
        if p["tool_name"] not in STATIC_TOOLS
    ]
    if cfg.get("custom_workflow"):
        specs.append({"name": "generate_custom_image", "description": CUSTOM_DESC, "inputSchema": GENERATION_SCHEMA})
    if any(p["tool_name"] == "edit_image" for p in selected):
        if image_mode == "paths":
            specs.append({"name": "edit_image", "description": EDIT_DESC_PATHS, "inputSchema": EDIT_SCHEMA_PATHS})
        else:
            specs.append({"name": "edit_image", "description": EDIT_DESC_REFS, "inputSchema": EDIT_SCHEMA_REFS})
            specs.append({"name": "request_upload", "description": UPLOAD_DESC, "inputSchema": UPLOAD_SCHEMA})
    specs.append({"name": "fetch_result", "description": FETCH_DESC, "inputSchema": FETCH_SCHEMA})
    return specs
