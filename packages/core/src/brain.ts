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
import { redrawPackFor } from "./metadata.ts";
import { BG_MODELS, canRedraw, FACE_MODELS, groupByTool, MARK_MODELS, packFor, prepare, redrawPack, referenceInput, select, TOOLS, type Pack } from "./packs.ts";
import { STATIC_TOOLS, toolSpecs, type ImageMode, type ToolSpec } from "./tools.ts";
import * as refs from "./refs.ts";
import { buildPrompt, cutoutWorkflow, redrawWorkflow, withBackgroundRemoval, withImages, withMarkRemoval, withWebpSave, type Workflow } from "./workflow.ts";

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

  /** An image argument's bytes when they are at hand without a download (a stored id, a local
   * file), else null. Read for the metadata only (redraw's model): never throws for a bad one. */
  async imageBytes(_arg: string): Promise<Uint8Array | null> {
    return null;
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

/** What a GPU's ComfyUI can do beyond a plain generation, named as a PC agent's hello says them. A PC
 * agent from before a feature doesn't say it (and before v1.16.0 ran the user's own ComfyUI); Modal
 * and the MCPB have every one. The step is left out, or the call answers that the agent needs an
 * update. */
export const FEATURES = [
  "remove_marks", // our extension's mark-removal node: the remove_marks setting can apply
  "remove_background", // the background_removal model folder (v1.16.0)
  "redraw", // our extension's redraw nodes (v1.17.0)
  "cutout", // our extension's cut-out cleanup node (v1.17.3)
  "redraw_area", // its redraw node crops, for prompt_scope "area" (v1.20.0)
  "inpaint_control", // the inpainting control node, kohya's LLLite (v1.21.0); without it a redraw runs uncontrolled
  "redraw_extend", // its redraw nodes grow the canvas, for extend (v1.21.0)
  "anima_ref", // the Anima Reference Adapter's node, for generate_from_reference (v2.7.0)
  "reference_strength", // that node weakens the reference and crops it to its head: reference_strength, new_outfit (v2.8.0)
] as const;
export type Feature = (typeof FEATURES)[number];

/** *features*: what this GPU's ComfyUI can do (FEATURES); none by default. */
export type BrainOptions = { hooks?: Hooks; waitS?: number; features?: Iterable<Feature> };

export const BACKGROUND_UNAVAILABLE =
  "Background removal needs a newer Comfy-Gen agent on this PC. The agent updates itself when it restarts; try again after that, or without remove_background.";

export const REDRAW_UNAVAILABLE =
  "Redrawing needs a newer Comfy-Gen agent on this PC. The agent updates itself when it restarts; try again after that.";

export const REDRAW_AREA_UNAVAILABLE =
  "prompt_scope \"area\" needs a newer Comfy-Gen agent on this PC. The agent updates itself when it restarts; try again after that, or without prompt_scope.";

export const REFERENCE_UNAVAILABLE =
  "Drawing from a reference needs a newer Comfy-Gen agent on this PC. The agent updates itself when it restarts; try again after that.";

export const REFERENCE_STRENGTH_UNAVAILABLE =
  "reference_strength and new_outfit need a newer Comfy-Gen agent on this PC. The agent updates itself when it restarts; try again after that, or without them.";

export const REDRAW_EXTEND_UNAVAILABLE =
  "extend needs a newer Comfy-Gen agent on this PC. The agent updates itself when it restarts; try again after that.";

// Redraw's strength: the sampler's denoise. 0.9 changed expressions clearly and kept identity in
// the spikes (0.8 barely changed them); below 0.3 nothing visible changes.
const REDRAW_STRENGTH = 0.9;
const MIN_STRENGTH = 0.3;
const MIN_BOX_SIDE = 0.01;

/** A call's image argument, in either mode's spelling (models sometimes use the other one). */
const imageArg = (args: Record<string, any>): string => String(args.image_path || args.image || "").trim();

/** *pack*'s resolution budget in pixels (a megapixel unless it says). */
const budgetOf = (pack: Pack): number => pack.max_pixels ?? 1_048_576;

export class Brain {
  readonly cfg: Config;
  readonly specs: ToolSpec[];
  private client: ComfyUIClient;
  private hooks: Hooks;
  private waitS: number;
  private features: Set<Feature>;
  private packs: Pack[];
  // Raw selected packs by tool. They are prepared (LoRAs, budget) only when called, so a request
  // pays for one pack, not all of them.
  private selected: Record<string, Pack>;

  constructor(packs: Pack[], cfg: unknown, client: ComfyUIClient, imageMode: ImageMode, opts: BrainOptions = {}) {
    this.cfg = normalize(cfg);
    this.client = client;
    this.hooks = opts.hooks ?? new Hooks();
    this.waitS = opts.waitS ?? DEFAULT_WAIT_S;
    this.features = new Set(opts.features ?? []);
    this.packs = packs;
    this.specs = toolSpecs(packs, this.cfg, imageMode);
    this.selected = Object.fromEntries(select(groupByTool(packs), this.cfg.pack_selections).map((p) => [p.tool_name, p]));
  }

  private can(feature: Feature): boolean {
    return this.features.has(feature);
  }

  /** A call's remove_background: whether it asked for one, or why this GPU can't. */
  private background(args: Record<string, any>): boolean | Failed {
    const wanted = args.remove_background === true;
    return wanted && !this.can("remove_background") ? new Failed(BACKGROUND_UNAVAILABLE) : wanted;
  }

  /** Run one tool call. Throws UnknownTool for a tool this brain doesn't serve. A ComfyUIError on
   * the way (a GPU not ready, an upload refused, ComfyUI failing) is the call's answer. */
  async call(name: string, args: Record<string, any>): Promise<Outcome> {
    this.client.stopBy = this.client.time() + this.waitS; // cold starts, uploads and the wait share it
    try {
      return await this.dispatch(name, args);
    } catch (e) {
      if (e instanceof ComfyUIError) return new Failed(e.message, e.retryable);
      throw e;
    }
  }

  private async dispatch(name: string, args: Record<string, any>): Promise<Outcome> {
    if (name === "fetch_result") return this.fetch(args);
    if (name === "edit_image" && "edit_image" in this.selected) return this.edit(args);
    if (name === "redraw" && this.packs.some(canRedraw)) return this.redraw(args); // listed or not (show_redraw)
    if (name === "remove_background") return this.removeBackground(args); // hidden: scripted callers
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
    const seed = callSeed(args.seed);
    if (seed instanceof Failed) return seed;
    const removeBackground = this.background(args);
    if (removeBackground instanceof Failed) return removeBackground;
    // A reference tool's image, named in either mode's spelling (as edit_image's).
    const isReference = TOOLS[rawPack.tool_name]?.reference === true;
    const reference = String(args.reference_image_path || args.reference_image || "").trim();
    let look: ReferenceLook | Failed = {};
    if (isReference) {
      if (!reference) return new Failed("reference_image is required: the image of the character to draw.");
      if (!this.can("anima_ref")) return new Failed(REFERENCE_UNAVAILABLE);
      look = referenceLook(rawPack, args);
      if (look instanceof Failed) return look;
      if (Object.keys(look).length && !this.can("reference_strength")) return new Failed(REFERENCE_STRENGTH_UNAVAILABLE);
    }
    const pack = prepare(rawPack, this.cfg, { removeMarks: await this.marksReady(), removeBackground, cutout: this.can("cutout") });
    const extra = [...(look.head_only ? [FACE_MODELS] : []), ...(removeBackground ? [BG_MODELS] : [])];
    const workflow = isReference ? await this.loadImages(pack, extra, [reference]) : pack.workflow;
    const wf = buildPrompt(workflow, prompt, {
      seed,
      aspectRatio: aspect,
      maxPixels: budgetOf(pack),
      loraToggles: pack.lora_toggles,
      negative: String(args.negative ?? ""), negativeFixed: pack.negative_fixed,
      reference: look,
    });
    return this.run(pack, wf, isReference ? null : extra); // loadImages made the pack ready
  }

  /** *pack*'s workflow with *images* (call arguments: ids, paths or URLs) uploaded into its image
   * nodes, the pack and *extra* made ready first: a local ComfyUI may not be running before. */
  private async loadImages(pack: Pack, extra: Pack[], images: string[]): Promise<Workflow> {
    await this.ensureAll(pack, extra);
    const resolved: ResolvedImage[] = [];
    for (const image of images) resolved.push(await this.hooks.resolveImage(image));
    return editWorkflow(pack, resolved);
  }

  private async fetch(args: Record<string, any>): Promise<Outcome> {
    const token = String(args.request_token || "").trim();
    if (!token) return new Failed("request_token is required.");
    return this.wait(token);
  }

  private async edit(args: Record<string, any>): Promise<Outcome> {
    const prompt = String(args.prompt || "").trim();
    // Accept either mode's argument names: models sometimes use the other spelling.
    const first = imageArg(args);
    const second = String(args.second_image_path || args.second_image || "").trim();
    if (!prompt || !first) return new Failed("prompt and an image are required.");
    const seed = callSeed(args.seed);
    if (seed instanceof Failed) return seed;
    const removeBackground = this.background(args);
    if (removeBackground instanceof Failed) return removeBackground;
    const pack = prepare(this.selected.edit_image, this.cfg, { removeMarks: await this.marksReady(), removeBackground, cutout: this.can("cutout") });
    const wf = await this.loadImages(pack, removeBackground ? [BG_MODELS] : [], second ? [first, second] : [first]);
    // LoRAs gated on their triggers here too (an edit pack in a LoRA group).
    return this.run(pack, buildPrompt(wf, prompt, { seed, loraToggles: pack.lora_toggles }), null);
  }

  private async redraw(args: Record<string, any>): Promise<Outcome> {
    const prompt = String(args.prompt || "").trim();
    const image = imageArg(args);
    if (!prompt || !image) return new Failed("prompt and an image are required.");
    const box = redrawBox(args.box);
    if (box instanceof Failed) return box;
    const strength = numberArg(args.strength, "strength", MIN_STRENGTH, 1) ?? REDRAW_STRENGTH;
    if (strength instanceof Failed) return strength;
    const scope = args.prompt_scope === undefined || args.prompt_scope === null || args.prompt_scope === "" ? "image" : args.prompt_scope;
    if (scope !== "image" && scope !== "area") return new Failed('prompt_scope must be "image" (the default) or "area".');
    const extend = redrawExtend(args.extend);
    if (extend instanceof Failed) return extend;
    const seed = callSeed(args.seed);
    if (seed instanceof Failed) return seed;
    if (extend && box) return new Failed("extend and box can't be combined: extend redraws the new border. Fix a part of the image with a second redraw.");
    if (extend && scope === "area") return new Failed('extend can\'t be combined with prompt_scope "area".');
    if (!this.can("redraw")) return new Failed(REDRAW_UNAVAILABLE);
    if (scope === "area" && !this.can("redraw_area")) return new Failed(REDRAW_AREA_UNAVAILABLE);
    if (extend && !this.can("redraw_extend")) return new Failed(REDRAW_EXTEND_UNAVAILABLE);
    const removeBackground = this.background(args);
    if (removeBackground instanceof Failed) return removeBackground;
    // Unnamed, the model that drew the image when its metadata says (mixing models doesn't work).
    const model = args.model || redrawPackFor(await this.hooks.imageBytes(image).catch(() => null), this.packs);
    const rawPack = redrawPack(this.packs, model);
    if (typeof rawPack === "string") return new Failed(rawPack);
    const pack = prepare(rawPack, this.cfg);
    // An extend paints new borders, where the models paint signatures (one in a corner, live on the
    // PC, 2026-10-17): cleaned as a generation is. A redraw inside the image keeps none (§3).
    const removeMarks = extend ? await this.marksReady() : false;
    // before the upload, as for edits
    await this.ensureAll(pack, [...(box || extend ? [] : [FACE_MODELS]), ...(removeBackground ? [BG_MODELS] : [])]);
    const [loadValue] = await this.hooks.resolveImage(image);
    const wf = redrawWorkflow(pack.workflow, loadValue, {
      box, strength, maxPixels: budgetOf(pack), keepAlpha: !removeBackground, areaOnly: scope === "area", extend,
      control: this.can("inpaint_control") ? pack.inpaint_control : undefined,
    });
    // The marks (an extend's) and then the background, from the pasted result, as on the generate
    // tools; not before: a redraw reaching into an already transparent part samples the colours left
    // under it and gets the old edge pasted back.
    if (removeMarks) withMarkRemoval(wf);
    if (removeBackground) withBackgroundRemoval(wf, { cutout: this.can("cutout") });
    return this.run(pack, buildPrompt(wf, prompt, { seed, loraToggles: pack.lora_toggles, negative: String(args.negative ?? ""), negativeFixed: pack.negative_fixed }), null);
  }

  /** The hidden remove_background tool: *image* as stored, its background cut out, nothing repainted. */
  private async removeBackground(args: Record<string, any>): Promise<Outcome> {
    const image = imageArg(args);
    if (!image) return new Failed("an image is required.");
    if (!this.can("remove_background")) return new Failed(BACKGROUND_UNAVAILABLE);
    await this.ensureAll(BG_MODELS, []); // before the upload, as for edits
    const [loadValue] = await this.hooks.resolveImage(image);
    return this.run(BG_MODELS, cutoutWorkflow(loadValue, { cutout: this.can("cutout") }), null);
  }

  /** Make *pack* ready, after the model sets the call also needs (*extra*): a call that asked for a
   * background removal waits for its model like for the pack's, never going out without it. */
  private async ensureAll(pack: Pack, extra: Pack[]): Promise<void> {
    for (const models of extra) await this.hooks.ensure(models);
    await this.hooks.ensure(pack);
  }

  /** Whether this call's images get their signatures and watermarks removed: the setting is on, the
   * GPU can (remove_marks), and its models are there. They are fetched like a pack's (ensure);
   * while they download, images go out as they come rather than waiting for them. */
  private async marksReady(): Promise<boolean> {
    if (!this.can("remove_marks") || !this.cfg.remove_marks) return false;
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
    if (extra) await this.ensureAll(pack, extra);
    return this.wait(await this.client.submit(withWebpSave(wf)));
  }

  private async wait(promptId: string): Promise<Outcome> {
    const stopBy = this.client.stopBy;
    const images = await this.client.wait(promptId, stopBy === null ? this.waitS : Math.max(0, stopBy - this.client.time()));
    if (images === null) {
      return new Pending(promptId, await this.client.statusMessage(promptId));
    }
    return new Done(images, promptId);
  }
}

/** A redraw call's extend for the node: "left,top,right,bottom" shares of the image's sides, "" for
 * none; a Failed saying what is wrong with it. Takes {left, top, right, bottom} (missing sides 0). */
export function redrawExtend(extend: unknown): string | Failed {
  if (extend === undefined || extend === null || extend === "") return "";
  if (typeof extend !== "object" || Array.isArray(extend)) return new Failed("extend must be {left, top, right, bottom}: shares of the image's width and height to add on each side.");
  const e = extend as Record<string, unknown>;
  const sides = ["left", "top", "right", "bottom"].map((k) => (e[k] === undefined || e[k] === null ? 0 : e[k]));
  if (sides.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) {
    return new Failed("extend's sides are shares of the image's width and height, from 0 to 1, not pixels (0.25 adds a quarter).");
  }
  const [l, t, r, b] = sides as number[];
  if (l + r > 1 || t + b > 1) return new Failed("extend can at most double the width and the height in one call (left + right and top + bottom up to 1): extend again for more.");
  if (Math.max(l, t, r, b) < MIN_BOX_SIDE) return new Failed("extend adds nothing: give at least one side a share above 0.");
  return [l, t, r, b].map((v) => String(roundHalfEven(v * 1e4) / 1e4)).join(",");
}

/** A call's hidden `seed` (scripted callers' repeatable runs): a whole number from 0 to 2^53 - 1
 * (exact as a JSON number, within ComfyUI's range), or one as a string; null for a random one. */
export function callSeed(seed: unknown): number | null | Failed {
  if (seed === undefined || seed === null || seed === "") return null;
  const n = typeof seed === "string" && /^\s*\d+\s*$/.test(seed) ? Number(seed) : seed;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    return new Failed(`seed must be a whole number from 0 to ${Number.MAX_SAFE_INTEGER}, or left out for a random one.`);
  }
  return n;
}

/** A call's number from *min* to *max*; null left out, a Failed for anything else. */
function numberArg(value: unknown, name: string, min: number, max: number): number | null | Failed {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return n >= min && n <= max ? n : new Failed(`${name} must be a number from ${min} to ${max}.`);
}

/** What a call sets on its pack's cg:reference node. */
type ReferenceLook = { ref_cutoff?: number; blend?: number; head_only?: true };

/** A reference call's reference_strength and new_outfit on *pack*'s node; a Failed saying what is
 * wrong. Nothing at their defaults: the call runs as before them, on older agents too. */
function referenceLook(pack: Pack, args: Record<string, any>): ReferenceLook | Failed {
  const { input, new_outfit } = pack.reference_strength!;
  const strength = numberArg(args.reference_strength, "reference_strength", 0, 1);
  if (strength instanceof Failed) return strength;
  const newOutfit = args.new_outfit === true;
  const value = strength !== null ? referenceInput(pack, strength) : newOutfit ? new_outfit ?? 1 : 1;
  return { ...(value < 1 ? { [input]: value } : {}), ...(newOutfit ? { head_only: true } : {}) };
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
  const budget: number = budgetOf(pack);
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
