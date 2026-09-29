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
import { groupByTool, prepare, requiredNodes, select, type Pack } from "./packs.ts";
import { STATIC_TOOLS, toolSpecs, type ImageMode, type ToolSpec } from "./tools.ts";
import { buildPrompt, classTypes, parseCustomWorkflow, splitLossless, type NodeField, type Workflow } from "./workflow.ts";

export const DEFAULT_WAIT_S = 240; // the MCP client gives up at 300 s (S8)

// calcDimensions rounds to multiples of 64, so a pack's own output can land a couple of percent
// above its declared max_pixels. The edit path tolerates that much rather than shaving pixels off
// every edit of an image we just generated; anything past it is still clamped to the budget.
export const EDIT_BUDGET_TOLERANCE = 1.05;

export class Done {
  readonly kind = "done";
  images: OutputImage[];
  promptId: string;
  lossless: boolean;
  constructor(images: OutputImage[], promptId: string, lossless = false) {
    this.images = images;
    this.promptId = promptId;
    this.lossless = lossless;
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

export type BrainOptions = { hooks?: Hooks; inventory?: Set<string> | null; waitS?: number };

export class Brain {
  readonly cfg: Config;
  readonly specs: ToolSpec[];
  private client: ComfyUIClient;
  private hooks: Hooks;
  private inventory: Set<string> | null;
  private waitS: number;
  // Raw selected packs by tool. They are prepared (LoRAs, budget) only when called, so a request
  // pays for one pack, not all of them.
  private selected: Record<string, Pack>;

  constructor(packs: Pack[], cfg: unknown, client: ComfyUIClient, imageMode: ImageMode, opts: BrainOptions = {}) {
    this.cfg = normalize(cfg);
    this.client = client;
    this.hooks = opts.hooks ?? new Hooks();
    this.inventory = opts.inventory ?? null;
    this.waitS = opts.waitS ?? DEFAULT_WAIT_S;
    this.specs = toolSpecs(packs, this.cfg, imageMode);
    this.selected = Object.fromEntries(select(groupByTool(packs), this.cfg.pack_selections).map((p) => [p.tool_name, p]));
  }

  /** Run one tool call. Throws UnknownTool for a tool this brain doesn't serve. */
  async call(name: string, args: Record<string, any>): Promise<Outcome> {
    if (name === "fetch_result") return this.fetch(args);
    if (name === "edit_image" && "edit_image" in this.selected) return this.edit(args);
    if (name === "generate_custom_image" && this.cfg.custom_workflow) return this.custom(args);
    if (name in this.selected && !STATIC_TOOLS.has(name)) return this.generate(this.selected[name], args);
    throw new UnknownTool(name);
  }

  private async generate(rawPack: Pack, args: Record<string, any>): Promise<Outcome> {
    const prompt = String(args.prompt || "").trim();
    if (!prompt) return new Failed("prompt is required.");
    const [aspect, lossless] = splitLossless(String(args.aspect_ratio || "square"));
    const pack = prepare(rawPack, this.cfg);
    const wf = buildPrompt(pack.workflow, prompt, pack.prompt_node_id, pack.seed_nodes, {
      dimensionNodes: pack.dimension_nodes,
      aspectRatio: aspect,
      maxPixels: pack.max_pixels ?? 1_048_576,
      loraToggles: pack.lora_toggles,
    });
    return this.run(pack, wf, lossless);
  }

  private async custom(args: Record<string, any>): Promise<Outcome> {
    const prompt = String(args.prompt || "").trim();
    if (!prompt) return new Failed("prompt is required.");
    const [, lossless] = splitLossless(String(args.aspect_ratio || "square"));
    let pack: Pack;
    try {
      pack = customPack(this.cfg.custom_workflow!);
    } catch (e) {
      return new Failed(`The custom workflow is invalid: ${(e as Error).message}`);
    }
    const wf = buildPrompt(pack.workflow, prompt, pack.prompt_node_id, pack.seed_nodes);
    return this.run(pack, wf, lossless);
  }

  private async fetch(args: Record<string, any>): Promise<Outcome> {
    const [token, lossless] = splitLossless(String(args.request_token || ""));
    if (!token) return new Failed("request_token is required.");
    return this.wait(token, lossless);
  }

  private async edit(args: Record<string, any>): Promise<Outcome> {
    const prompt = String(args.prompt || "").trim();
    // Accept either mode's argument names: models sometimes use the other spelling.
    let first = String(args.image_path || args.image || "").trim();
    let second = String(args.second_image_path || args.second_image || "").trim();
    if (!prompt || !first) return new Failed("prompt and an image are required.");
    let lossless: boolean;
    [first, lossless] = splitLossless(first);
    if (second) {
      let lossless2: boolean;
      [second, lossless2] = splitLossless(second);
      lossless ||= lossless2;
    }
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
    return this.run(pack, buildPrompt(wf, prompt, promptNode, seedNodes), lossless, true);
  }

  private async run(pack: Pack, wf: Workflow, lossless: boolean, ensured = false): Promise<Outcome> {
    if (this.inventory) {
      const missing = [...classTypes(wf)].filter((c) => !this.inventory!.has(c)).sort();
      if (missing.length) return new Failed(missingNodesMessage(missing, requiredNodes(pack)));
    }
    let promptId: string;
    try {
      if (!ensured) await this.hooks.ensure(pack);
      promptId = await this.client.submit(wf);
    } catch (e) {
      if (e instanceof ComfyUIError) return new Failed(e.message);
      throw e;
    }
    return this.wait(promptId, lossless);
  }

  private async wait(promptId: string, lossless: boolean): Promise<Outcome> {
    try {
      const images = await this.client.wait(promptId, this.waitS);
      if (images === null) {
        return new Pending(promptId + (lossless ? ":lossless" : ""), await this.client.statusMessage(promptId));
      }
      return new Done(images, promptId, lossless);
    } catch (e) {
      if (e instanceof ComfyUIError) return new Failed(e.message);
      throw e;
    }
  }
}

/** A synthetic pack for the user's custom workflow. Throws if it can't be used. */
export function customPack(custom: { workflow?: unknown; prompt_node_title?: string }): Pack {
  const [wf, promptNode, samplers] = parseCustomWorkflow(custom.workflow, custom.prompt_node_title || null);
  return {
    name: "custom",
    display_name: "Custom workflow",
    tool_name: "generate_custom_image",
    tool_description: "",
    workflow: wf,
    prompt_node_id: promptNode,
    seed_nodes: samplers.map((sid) => ({ node_id: sid, field: wf[sid].class_type === "KSamplerAdvanced" ? "noise_seed" : "seed" })),
    models: [],
  };
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

/** User-facing text for node classes the generator doesn't have. */
export function missingNodesMessage(missing: string[], known: Record<string, string>): string {
  const named = missing.map((cls) => (cls in known ? `${cls} (from ${known[cls]})` : cls));
  return (
    "This generator does not have the node(s) this workflow needs: " + named.join(", ") + ". " +
    "Install them in its ComfyUI, then try again."
  );
}
