// The brain: turn a tool call into a ComfyUI job and wait for it.
//
// Shared by the Worker and the MCPB. It knows packs, workflows and ComfyUI; it does not know how the
// result is shown (frontends render Done into MCP content) or how images reach ComfyUI (the
// resolveImage hook does that per machine).
//
// Stateless by design: the request token handed back on a timeout is ComfyUI's own prompt_id, so
// fetch_result needs nothing but ComfyUI's history.

import { roundHalfEven } from "./bytes.ts";
import { ComfyUIClient, ComfyUIError, type OutputImage } from "./comfyui.ts";
import { normalize, type Config } from "./config.ts";
import { UnknownTool } from "./mcp.ts";
import { groupByTool, prepare, select, type Pack } from "./packs.ts";
import { STATIC_TOOLS, toolSpecs, type ImageMode, type ToolSpec } from "./tools.ts";
import { buildPrompt, stripLossless, type NodeField, type Workflow } from "./workflow.ts";

// A tool call answers within this, counted from its start: the clients give up at 300 s (claude.ai,
// S8; Claude Code's idle timeout for HTTP servers). Before, it counted from the submit, so a slow
// cold start plus the wait ran past 300 s and the call timed out (seen from Claude Code).
export const DEFAULT_WAIT_S = 240;

// calcDimensions rounds to multiples of 64, so a pack's own output can land a couple of percent
// above its declared max_pixels. The edit path tolerates that much rather than shaving pixels off
// every edit of an image we just generated; anything past it is still clamped to the budget.
export const EDIT_BUDGET_TOLERANCE = 1.05;

export class Done {
  readonly kind = "done";
  images: OutputImage[];
  promptId: string;
  constructor(images: OutputImage[], promptId: string) {
    this.images = images;
    this.promptId = promptId;
  }
}

export class Pending {
  readonly kind = "pending";
  token: string;
  status: string;
  constructor(token: string, status: string) {
    this.token = token;
    this.status = status;
  }
  text(): string {
    return `Generation is still in progress (${this.status}). Use the fetch_result tool with request_token '${this.token}' to retrieve the result.`;
  }
}

export class Failed {
  readonly kind = "failed";
  message: string;
  constructor(message: string) {
    this.message = message;
  }
  text(): string {
    return `Error: ${this.message}`;
  }
}

export type Outcome = Done | Pending | Failed;
export type ResolvedImage = [loadValue: string, size: [number, number] | null];

/** The per-machine seam. Override what the machine supports. */
export class Hooks {
  /** Make the generator ready for *pack* (models, nodes, process). Throw ComfyUIError if not. */
  async ensure(_pack: Pack): Promise<void> {}

  /** Turn an edit_image argument into [LoadImage value, [width, height] or null]. */
  async resolveImage(_arg: string): Promise<ResolvedImage> {
    throw new ComfyUIError("Editing images is not available here.");
  }
}

export type BrainOptions = { hooks?: Hooks; waitS?: number };

export class Brain {
  readonly cfg: Config;
  readonly specs: ToolSpec[];
  private client: ComfyUIClient;
  private hooks: Hooks;
  private waitS: number;
  // Raw selected packs by tool. They are prepared (LoRAs, budget) only when called, so a request
  // pays for one pack, not all of them.
  private selected: Record<string, Pack>;

  constructor(packs: Pack[], cfg: unknown, client: ComfyUIClient, imageMode: ImageMode, opts: BrainOptions = {}) {
    this.cfg = normalize(cfg);
    this.client = client;
    this.hooks = opts.hooks ?? new Hooks();
    this.waitS = opts.waitS ?? DEFAULT_WAIT_S;
    this.specs = toolSpecs(packs, this.cfg, imageMode);
    this.selected = Object.fromEntries(select(groupByTool(packs), this.cfg.pack_selections).map((p) => [p.tool_name, p]));
  }

  /** Run one tool call. Throws UnknownTool for a tool this brain doesn't serve. */
  async call(name: string, args: Record<string, any>): Promise<Outcome> {
    this.client.stopBy = this.client.time() + this.waitS; // cold starts, uploads and the wait share it
    if (name === "fetch_result") return this.fetch(args);
    if (name === "edit_image" && "edit_image" in this.selected) return this.edit(args);
    if (name in this.selected && !STATIC_TOOLS.has(name)) return this.generate(this.selected[name], args);
    throw new UnknownTool(name);
  }

  private async generate(rawPack: Pack, args: Record<string, any>): Promise<Outcome> {
    const prompt = String(args.prompt || "").trim();
    if (!prompt) return new Failed("prompt is required.");
    const aspect = stripLossless(String(args.aspect_ratio || "square"));
    const pack = prepare(rawPack, this.cfg);
    const wf = buildPrompt(pack.workflow, prompt, pack.prompt_node_id, pack.seed_nodes, {
      dimensionNodes: pack.dimension_nodes,
      aspectRatio: aspect,
      maxPixels: pack.max_pixels ?? 1_048_576,
      loraToggles: pack.lora_toggles,
    });
    return this.run(pack, wf);
  }

  private async fetch(args: Record<string, any>): Promise<Outcome> {
    const token = stripLossless(String(args.request_token || ""));
    if (!token) return new Failed("request_token is required.");
    return this.wait(token);
  }

  private async edit(args: Record<string, any>): Promise<Outcome> {
    const prompt = String(args.prompt || "").trim();
    // Accept either mode's argument names: models sometimes use the other spelling.
    const first = stripLossless(String(args.image_path || args.image || "").trim());
    const second = stripLossless(String(args.second_image_path || args.second_image || "").trim());
    if (!prompt || !first) return new Failed("prompt and an image are required.");
    const pack = prepare(this.selected.edit_image, this.cfg);
    const images: ResolvedImage[] = [];
    try {
      await this.hooks.ensure(pack); // before uploads: a local ComfyUI may not be running yet
      images.push(await this.hooks.resolveImage(first));
      if (second) images.push(await this.hooks.resolveImage(second));
    } catch (e) {
      if (e instanceof ComfyUIError) return new Failed(e.message);
      throw e;
    }
    const [wf, promptNode, seedNodes] = editWorkflow(pack, images);
    return this.run(pack, buildPrompt(wf, prompt, promptNode, seedNodes), true);
  }

  private async run(pack: Pack, wf: Workflow, ensured = false): Promise<Outcome> {
    let promptId: string;
    try {
      if (!ensured) await this.hooks.ensure(pack);
      promptId = await this.client.submit(wf);
    } catch (e) {
      if (e instanceof ComfyUIError) return new Failed(e.message);
      throw e;
    }
    return this.wait(promptId);
  }

  private async wait(promptId: string): Promise<Outcome> {
    try {
      const stopBy = this.client.stopBy;
      const images = await this.client.wait(promptId, stopBy === null ? this.waitS : Math.max(0, stopBy - this.client.time()));
      if (images === null) {
        return new Pending(promptId, await this.client.statusMessage(promptId));
      }
      return new Done(images, promptId);
    } catch (e) {
      if (e instanceof ComfyUIError) return new Failed(e.message);
      throw e;
    }
  }
}

/**
 * The edit pack's single- or two-image workflow with the images loaded and scale nodes sized.
 * Returns [workflow, promptNodeId, seedNodes]; buildPrompt injects the prompt and seeds.
 *
 * The graph's ImageScaleToTotalPixels nodes normalize to a fixed megapixel count in both
 * directions, so left alone they would crush a large image and upscale a small one. Each is set to
 * min(source pixels, pack budget): inputs within budget pass through at native size, oversized ones
 * are reined in. Output dimensions follow the first image.
 */
export function editWorkflow(pack: Pack, images: ResolvedImage[]): [Workflow, string, NodeField[]] {
  const sfx = images.length > 1 ? "_multi" : "";
  const wf: Workflow = structuredClone(pack["workflow" + sfx]);
  const imageNodes: (string | number)[] = pack["image_nodes" + sfx];
  images.forEach(([loadValue], i) => {
    if (i < imageNodes.length) wf[String(imageNodes[i])].inputs.image = loadValue;
  });

  const budget: number = pack.max_pixels ?? 1_048_576;
  const scaleNodes: (string | number)[] = pack["edit_scale_nodes" + sfx] ?? [];
  images.forEach(([, size], i) => {
    if (i >= scaleNodes.length) return;
    const nodeId = String(scaleNodes[i]);
    if (!(nodeId in wf)) return;
    const pixels = size ? size[0] * size[1] : budget;
    const target = pixels <= budget * EDIT_BUDGET_TOLERANCE ? pixels : budget;
    // ImageScaleToTotalPixels accepts 0.01 to 16.0 megapixels, where 1.0 == 1024*1024.
    const mp = roundHalfEven((target / 1_048_576) * 1e4) / 1e4;
    wf[nodeId].inputs.megapixels = Math.min(Math.max(mp, 0.01), 16.0);
  });
  return [wf, String(pack["prompt_node_id" + sfx]), pack["seed_nodes" + sfx]];
}
