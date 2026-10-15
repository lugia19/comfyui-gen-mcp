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
import { imageSize, sniffMime } from "./images.ts";
import { UnknownTool } from "./mcp.ts";
import { BG_MODELS, FACE_MODELS, groupByTool, MARK_MODELS, packFor, prepare, redrawPack, select, type Pack } from "./packs.ts";
import { STATIC_TOOLS, toolSpecs, type ImageMode, type ToolSpec } from "./tools.ts";
import * as refs from "./refs.ts";
import { buildPrompt, redrawWorkflow, withImages, type Workflow } from "./workflow.ts";

// A tool call answers within this, counted from its start. claude.ai gives up at 300 s (S8), but a
// claude.ai connector used from Claude Code gave up at about 183 s (2026-10-01: a cold Modal edit
// answered at 211 s, to nobody). 150 s leaves room for rendering after the wait.
export const DEFAULT_WAIT_S = 150;

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
  retryable: boolean; // see ComfyUIError
  constructor(message: string, retryable = false) {
    this.message = message;
    this.retryable = retryable;
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

/** Image bytes into a ComfyUI's input folder, for an edit (the hooks' resolveImage): [what
 * LoadImage takes, the size]. Named after *key*: the same key reuses the same file. *what* names
 * the image in errors. Throws ComfyUIError for anything but a PNG, JPEG, WebP or GIF of at most
 * *maxBytes*. */
export async function uploadInput(client: ComfyUIClient, data: Uint8Array, key: string, what: string, maxBytes: number): Promise<ResolvedImage> {
  const mime = sniffMime(data);
  if (!mime) throw new ComfyUIError(`${what} is not a PNG, JPEG, WebP or GIF image.`);
  if (data.length > maxBytes) throw new ComfyUIError(`${what} is too large (${Math.floor(data.length / 1e6)} MB; the limit is ${maxBytes / 1e6} MB).`);
  const image = await client.upload(data, refs.uploadFilename(key, mime), mime, refs.UPLOAD_SUBFOLDER);
  return [image.loadValue(), imageSize(data)];
}

/** *canRemoveMarks*: the GPU's ComfyUI has our extension's mark-removal node, so the remove_marks
 * setting can apply. *canRemoveBackground*: it can take the background removal model (a PC agent
 * from before v1.16.0 lacks its folder). */
export type BrainOptions = { hooks?: Hooks; waitS?: number; canRemoveMarks?: boolean; canRemoveBackground?: boolean; canRedraw?: boolean };

export const BACKGROUND_UNAVAILABLE =
  "Background removal needs a newer Comfy-Gen agent on this PC. The agent updates itself when it restarts; try again after that, or without remove_background.";

export const REDRAW_UNAVAILABLE =
  "Redrawing needs a newer Comfy-Gen agent on this PC. The agent updates itself when it restarts; try again after that.";

// Redraw's strength: the sampler's denoise. 0.9 changed expressions clearly and kept identity in
// the spikes (0.8 barely changed them); below 0.3 nothing visible changes.
const REDRAW_STRENGTH = 0.9;
const MIN_STRENGTH = 0.3;
const MIN_BOX_SIDE = 0.01;

export class Brain {
  readonly cfg: Config;
  readonly specs: ToolSpec[];
  private client: ComfyUIClient;
  private hooks: Hooks;
  private waitS: number;
  private canRemoveMarks: boolean;
  private canRemoveBackground: boolean;
  private canRedraw: boolean;
  private packs: Pack[];
  // Raw selected packs by tool. They are prepared (LoRAs, budget) only when called, so a request
  // pays for one pack, not all of them.
  private selected: Record<string, Pack>;

  constructor(packs: Pack[], cfg: unknown, client: ComfyUIClient, imageMode: ImageMode, opts: BrainOptions = {}) {
    this.cfg = normalize(cfg);
    this.client = client;
    this.hooks = opts.hooks ?? new Hooks();
    this.waitS = opts.waitS ?? DEFAULT_WAIT_S;
    this.canRemoveMarks = opts.canRemoveMarks ?? false;
    this.canRemoveBackground = opts.canRemoveBackground ?? false;
    this.canRedraw = opts.canRedraw ?? false;
    this.packs = packs;
    this.specs = toolSpecs(packs, this.cfg, imageMode);
    this.selected = Object.fromEntries(select(groupByTool(packs), this.cfg.pack_selections).map((p) => [p.tool_name, p]));
  }

  /** Run one tool call. Throws UnknownTool for a tool this brain doesn't serve. */
  async call(name: string, args: Record<string, any>): Promise<Outcome> {
    this.client.stopBy = this.client.time() + this.waitS; // cold starts, uploads and the wait share it
    if (name === "fetch_result") return this.fetch(args);
    if (name === "edit_image" && "edit_image" in this.selected) return this.edit(args);
    if (name === "redraw" && this.specs.some((s) => s.name === "redraw")) return this.redraw(args);
    if (name in this.selected && !STATIC_TOOLS.has(name)) {
      const pack = packFor(this.packs, this.selected[name], args.model); // a scripted caller's hidden `model`
      return typeof pack === "string" ? new Failed(pack) : this.generate(pack, args);
    }
    throw new UnknownTool(name);
  }

  private async generate(rawPack: Pack, args: Record<string, any>): Promise<Outcome> {
    const prompt = String(args.prompt || "").trim();
    if (!prompt) return new Failed("prompt is required.");
    const aspect = String(args.aspect_ratio || "square");
    const removeBackground = args.remove_background === true;
    if (removeBackground && !this.canRemoveBackground) return new Failed(BACKGROUND_UNAVAILABLE);
    const pack = prepare(rawPack, this.cfg, { removeMarks: await this.marksReady(), removeBackground });
    const wf = buildPrompt(pack.workflow, prompt, {
      aspectRatio: aspect,
      maxPixels: pack.max_pixels ?? 1_048_576,
      loraToggles: pack.lora_toggles,
      negative: String(args.negative ?? ""),
    });
    return this.run(pack, wf, removeBackground ? [BG_MODELS] : []);
  }

  private async fetch(args: Record<string, any>): Promise<Outcome> {
    const token = String(args.request_token || "").trim();
    if (!token) return new Failed("request_token is required.");
    return this.wait(token);
  }

  private async edit(args: Record<string, any>): Promise<Outcome> {
    const prompt = String(args.prompt || "").trim();
    // Accept either mode's argument names: models sometimes use the other spelling.
    const first = String(args.image_path || args.image || "").trim();
    const second = String(args.second_image_path || args.second_image || "").trim();
    if (!prompt || !first) return new Failed("prompt and an image are required.");
    const removeBackground = args.remove_background === true;
    if (removeBackground && !this.canRemoveBackground) return new Failed(BACKGROUND_UNAVAILABLE);
    const pack = prepare(this.selected.edit_image, this.cfg, { removeMarks: await this.marksReady(), removeBackground });
    const images: ResolvedImage[] = [];
    try {
      // Before uploads: a local ComfyUI may not be running yet.
      await this.ensureAll(pack, removeBackground ? [BG_MODELS] : []);
      images.push(await this.hooks.resolveImage(first));
      if (second) images.push(await this.hooks.resolveImage(second));
    } catch (e) {
      if (e instanceof ComfyUIError) return new Failed(e.message, e.retryable);
      throw e;
    }
    const wf = editWorkflow(pack, images);
    // LoRAs gated on their triggers here too (an edit pack in a LoRA group).
    return this.run(pack, buildPrompt(wf, prompt, { loraToggles: pack.lora_toggles }), null);
  }

  private async redraw(args: Record<string, any>): Promise<Outcome> {
    const prompt = String(args.prompt || "").trim();
    const image = String(args.image_path || args.image || "").trim();
    if (!prompt || !image) return new Failed("prompt and an image are required.");
    const box = redrawBox(args.box);
    if (box instanceof Failed) return box;
    const strength = args.strength === undefined || args.strength === null ? REDRAW_STRENGTH : Number(args.strength);
    if (!Number.isFinite(strength) || strength < MIN_STRENGTH || strength > 1) return new Failed(`strength must be a number from ${MIN_STRENGTH} to 1.`);
    if (!this.canRedraw) return new Failed(REDRAW_UNAVAILABLE);
    const rawPack = redrawPack(this.packs, Object.values(this.selected), args.style, args.model);
    if (typeof rawPack === "string") return new Failed(rawPack);
    const pack = prepare(rawPack, this.cfg);
    let loadValue: string;
    try {
      await this.ensureAll(pack, box ? [] : [FACE_MODELS]); // before the upload, as for edits
      [loadValue] = await this.hooks.resolveImage(image);
    } catch (e) {
      if (e instanceof ComfyUIError) return new Failed(e.message, e.retryable);
      throw e;
    }
    const wf = redrawWorkflow(pack.workflow, loadValue, { box, strength, maxPixels: pack.max_pixels ?? 1_048_576 });
    return this.run(pack, buildPrompt(wf, prompt, { loraToggles: pack.lora_toggles, negative: String(args.negative ?? "") }), null);
  }

  /** Make *pack* ready, after the model sets the call also needs (*extra*): a call that asked for a
   * background removal waits for its model like for the pack's, never going out without it. */
  private async ensureAll(pack: Pack, extra: Pack[]): Promise<void> {
    for (const models of extra) await this.hooks.ensure(models);
    await this.hooks.ensure(pack);
  }

  /** Whether this call's images get their signatures and watermarks removed: the setting is on, the
   * GPU can (*canRemoveMarks*), and its models are there. They are fetched like a pack's (ensure);
   * while they download, images go out as they come rather than waiting for them. */
  private async marksReady(): Promise<boolean> {
    if (!this.canRemoveMarks || !this.cfg.remove_marks) return false;
    try {
      await this.hooks.ensure(MARK_MODELS);
      return true;
    } catch (e) {
      if (e instanceof ComfyUIError) return false;
      throw e;
    }
  }

  /** Submit *wf* and wait for it. *extra*: the model sets to make ready with the pack, null when the
   * caller already did. */
  private async run(pack: Pack, wf: Workflow, extra: Pack[] | null = []): Promise<Outcome> {
    let promptId: string;
    try {
      if (extra) await this.ensureAll(pack, extra);
      promptId = await this.client.submit(wf);
    } catch (e) {
      if (e instanceof ComfyUIError) return new Failed(e.message, e.retryable);
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
      if (e instanceof ComfyUIError) return new Failed(e.message, e.retryable);
      throw e;
    }
  }
}

/** A redraw call's box for the node: "left,top,right,bottom" fractions, "" for the largest face; a
 * Failed saying what is wrong with it. Accepts the four numbers as an array or a string of them
 * (some callers send one). */
export function redrawBox(box: unknown): string | Failed {
  if (box === undefined || box === null || box === "") return "";
  let parts: unknown[] = [];
  if (Array.isArray(box)) parts = box;
  else if (typeof box === "string") parts = box.replace(/[[\]()]/g, "").split(",").map((v) => (v.trim() === "" ? NaN : Number(v)));
  const n = parts.map((v) => (typeof v === "number" ? v : NaN));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return new Failed("box must be four numbers: [left, top, right, bottom].");
  if (n.some((v) => v < -0.05 || v > 1.05)) {
    return new Failed("box is fractions of the image's width and height, from 0 to 1, not pixels: divide by the image's size.");
  }
  const [l, t, r, b] = n.map((v) => Math.min(1, Math.max(0, v)));
  if (r - l < MIN_BOX_SIDE || b - t < MIN_BOX_SIDE) return new Failed("box is empty: left must be less than right, and top less than bottom.");
  return [l, t, r, b].map((v) => String(roundHalfEven(v * 1e4) / 1e4)).join(",");
}

/**
 * The edit pack's workflow for *images* (one, or two: withImages adds the second image's nodes),
 * with the images loaded and each scale node sized; buildPrompt then injects the prompt and seeds.
 *
 * The graph's ImageScaleToTotalPixels nodes normalize to a fixed megapixel count in both
 * directions, so left alone they would crush a large image and upscale a small one. Each is set to
 * min(source pixels, pack budget): inputs within budget pass through at native size, oversized ones
 * are reined in. Output dimensions follow the first image.
 */
export function editWorkflow(pack: Pack, images: ResolvedImage[]): Workflow {
  const [wf, nodes] = withImages(pack.workflow, Math.max(1, images.length));
  const budget: number = pack.max_pixels ?? 1_048_576;
  images.forEach(([loadValue, size], i) => {
    const { load, scale } = nodes[i];
    wf[load].inputs.image = loadValue;
    if (!scale) return;
    const pixels = size ? size[0] * size[1] : budget;
    const target = pixels <= budget * EDIT_BUDGET_TOLERANCE ? pixels : budget;
    // ImageScaleToTotalPixels accepts 0.01 to 16.0 megapixels, where 1.0 == 1024*1024.
    const mp = roundHalfEven((target / 1_048_576) * 1e4) / 1e4;
    wf[scale].inputs.megapixels = Math.min(Math.max(mp, 0.01), 16.0);
  });
  return wf;
}
