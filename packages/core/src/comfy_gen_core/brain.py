"""The brain: turn a tool call into a ComfyUI job and wait for it.

Shared by the Worker and the MCPB. It knows packs, workflows and ComfyUI; it does not know how the
result is shown (frontends render Done into MCP content) or how images reach ComfyUI (the
resolve_image hook does that per machine).

Stateless by design: the request token handed back on a timeout is ComfyUI's own prompt_id, so
fetch_result needs nothing but ComfyUI's history.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass

from comfy_gen_core import config as config_mod
from comfy_gen_core import packs as packs_mod
from comfy_gen_core.comfyui import ComfyUIClient, ComfyUIError, OutputImage
from comfy_gen_core.tools import STATIC_TOOLS, tool_specs
from comfy_gen_core.workflow import build_prompt, class_types, parse_custom_workflow, split_lossless

DEFAULT_WAIT_S = 240  # the MCP client gives up at 300 s (S8)

# calc_dimensions rounds to multiples of 64, so a pack's own output can land a couple of percent above
# its declared max_pixels. The edit path tolerates that much rather than shaving pixels off every
# edit of an image we just generated; anything past it is still clamped to the budget.
EDIT_BUDGET_TOLERANCE = 1.05


@dataclass
class Done:
    images: list[OutputImage]
    prompt_id: str
    lossless: bool = False


@dataclass
class Pending:
    token: str
    status: str

    def text(self) -> str:
        return (
            f"Generation is still in progress ({self.status}). Use the fetch_result tool with "
            f"request_token '{self.token}' to retrieve the result."
        )


@dataclass
class Failed:
    message: str

    def text(self) -> str:
        return f"Error: {self.message}"


Outcome = Done | Pending | Failed


class Hooks:
    """The per-machine seam. Subclass and override what the machine supports."""

    async def ensure(self, pack: dict) -> None:
        """Make the generator ready for *pack* (models, nodes, process). Raise ComfyUIError if not."""

    async def resolve_image(self, arg: str) -> tuple[str, tuple[int, int] | None]:
        """Turn an edit_image argument into (LoadImage value, (width, height) or None)."""
        raise ComfyUIError("Editing images is not available here.")


class Brain:
    def __init__(
        self,
        packs: list[dict],
        cfg: dict,
        client: ComfyUIClient,
        image_mode: str,
        hooks: Hooks | None = None,
        inventory: set[str] | None = None,
        wait_s: float = DEFAULT_WAIT_S,
    ):
        self.cfg = config_mod.normalize(cfg)
        self.client = client
        self.image_mode = image_mode
        self.hooks = hooks or Hooks()
        self.inventory = inventory
        self.wait_s = wait_s
        self.specs = tool_specs(packs, self.cfg, image_mode)
        groups = packs_mod.group_by_tool(packs)
        # Raw selected packs by tool. They are prepared (LoRAs, budget) only when called, so a
        # request pays for one pack, not all of them.
        self._selected = {p["tool_name"]: p for p in packs_mod.select(groups, self.cfg["pack_selections"])}

    # ── dispatch ──────────────────────────────────────────────────────

    async def call(self, name: str, args: dict) -> Outcome:
        """Run one tool call. Raises KeyError for a tool this brain doesn't serve."""
        if name == "fetch_result":
            return await self._fetch(args)
        if name == "edit_image" and "edit_image" in self._selected:
            return await self._edit(args)
        if name == "generate_custom_image" and self.cfg.get("custom_workflow"):
            return await self._custom(args)
        if name in self._selected and name not in STATIC_TOOLS:
            return await self._generate(self._selected[name], args)
        raise KeyError(name)

    # ── tools ─────────────────────────────────────────────────────────

    async def _generate(self, raw_pack: dict, args: dict) -> Outcome:
        prompt = str(args.get("prompt") or "").strip()
        if not prompt:
            return Failed("prompt is required.")
        aspect, lossless = split_lossless(str(args.get("aspect_ratio") or "square"))
        pack = packs_mod.prepare(raw_pack, self.cfg)
        wf = build_prompt(
            pack["workflow"], prompt, pack["prompt_node_id"], pack["seed_nodes"],
            dimension_nodes=pack.get("dimension_nodes"), aspect_ratio=aspect,
            max_pixels=pack.get("max_pixels", 1_048_576), lora_toggles=pack.get("lora_toggles"),
        )
        return await self._run(pack, wf, lossless)

    async def _custom(self, args: dict) -> Outcome:
        prompt = str(args.get("prompt") or "").strip()
        if not prompt:
            return Failed("prompt is required.")
        _, lossless = split_lossless(str(args.get("aspect_ratio") or "square"))
        try:
            pack = custom_pack(self.cfg["custom_workflow"])
        except ValueError as e:
            return Failed(f"The custom workflow is invalid: {e}")
        wf = build_prompt(pack["workflow"], prompt, pack["prompt_node_id"], pack["seed_nodes"])
        return await self._run(pack, wf, lossless)

    async def _fetch(self, args: dict) -> Outcome:
        token, lossless = split_lossless(str(args.get("request_token") or ""))
        if not token:
            return Failed("request_token is required.")
        return await self._wait(token, lossless)

    async def _edit(self, args: dict) -> Outcome:
        prompt = str(args.get("prompt") or "").strip()
        # Accept either mode's argument names: models sometimes use the other spelling.
        first = str(args.get("image_path") or args.get("image") or "").strip()
        second = str(args.get("second_image_path") or args.get("second_image") or "").strip()
        if not prompt or not first:
            return Failed("prompt and an image are required.")
        first, lossless = split_lossless(first)
        if second:
            second, lossless2 = split_lossless(second)
            lossless = lossless or lossless2

        pack = packs_mod.prepare(self._selected["edit_image"], self.cfg)
        try:
            await self.hooks.ensure(pack)  # before uploads: a local ComfyUI may not be running yet
            images = [await self.hooks.resolve_image(first)]
            if second:
                images.append(await self.hooks.resolve_image(second))
        except ComfyUIError as e:
            return Failed(str(e))
        wf, prompt_node, seed_nodes = edit_workflow(pack, images)
        wf = build_prompt(wf, prompt, prompt_node, seed_nodes)
        return await self._run(pack, wf, lossless, ensured=True)

    # ── the job ───────────────────────────────────────────────────────

    async def _run(self, pack: dict, wf: dict, lossless: bool, ensured: bool = False) -> Outcome:
        if self.inventory is not None:
            missing = sorted(class_types(wf) - self.inventory)
            if missing:
                return Failed(missing_nodes_message(missing, packs_mod.required_nodes(pack)))
        try:
            if not ensured:
                await self.hooks.ensure(pack)
            prompt_id = await self.client.submit(wf)
        except ComfyUIError as e:
            return Failed(str(e))
        return await self._wait(prompt_id, lossless)

    async def _wait(self, prompt_id: str, lossless: bool) -> Outcome:
        try:
            images = await self.client.wait(prompt_id, self.wait_s)
            if images is None:
                token = prompt_id + (":lossless" if lossless else "")
                return Pending(token, await self.client.status_message(prompt_id))
        except ComfyUIError as e:
            return Failed(str(e))
        return Done(images, prompt_id, lossless)


# ── helpers (module level so frontends and tests can use them) ────────

def custom_pack(custom: dict) -> dict:
    """A synthetic pack for the user's custom workflow. Raises ValueError if it can't be used."""
    wf, prompt_node, samplers = parse_custom_workflow(custom.get("workflow"), custom.get("prompt_node_title") or None)
    return {
        "name": "custom",
        "display_name": "Custom workflow",
        "tool_name": "generate_custom_image",
        "workflow": wf,
        "prompt_node_id": prompt_node,
        "seed_nodes": [
            {"node_id": sid, "field": "noise_seed" if wf[sid].get("class_type") == "KSamplerAdvanced" else "seed"}
            for sid in samplers
        ],
        "models": [],
    }


def edit_workflow(pack: dict, images: list[tuple[str, tuple[int, int] | None]]) -> tuple[dict, str, list[dict]]:
    """The edit pack's single- or two-image workflow with the images loaded and scale nodes sized.

    Returns (workflow, prompt_node_id, seed_nodes); build_prompt injects the prompt and seeds.

    The graph's ImageScaleToTotalPixels nodes normalize to a fixed megapixel count in both directions,
    so left alone they would crush a large image and upscale a small one. Each is set to
    min(source pixels, pack budget): inputs within budget pass through at native size, oversized ones
    are reined in. Output dimensions follow the first image.
    """
    multi = len(images) > 1
    sfx = "_multi" if multi else ""
    wf = copy.deepcopy(pack["workflow" + sfx])
    for node_id, (load_value, _) in zip(pack["image_nodes" + sfx], images):
        wf[str(node_id)]["inputs"]["image"] = load_value

    budget = pack.get("max_pixels", 1_048_576)
    for node_id, (_, size) in zip(pack.get("edit_scale_nodes" + sfx, []), images):
        node_id = str(node_id)
        if node_id not in wf:
            continue
        pixels = size[0] * size[1] if size else budget
        target = pixels if pixels <= budget * EDIT_BUDGET_TOLERANCE else budget
        # ImageScaleToTotalPixels accepts 0.01 to 16.0 megapixels, where 1.0 == 1024*1024.
        wf[node_id]["inputs"]["megapixels"] = min(max(round(target / 1_048_576, 4), 0.01), 16.0)

    return wf, str(pack["prompt_node_id" + sfx]), pack["seed_nodes" + sfx]


def missing_nodes_message(missing: list[str], known: dict[str, str]) -> str:
    """User-facing text for node classes the generator doesn't have."""
    named = [f"{cls} (from {known[cls]})" if cls in known else cls for cls in missing]
    return (
        "This generator does not have the node(s) this workflow needs: " + ", ".join(named) + ". "
        "The cloud generator supports core ComfyUI plus ComfyUI-GGUF; workflows needing other custom "
        "nodes run on a local generator."
    )
