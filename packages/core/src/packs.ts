// Model packs: load, validate, pick one per tool, apply the user's customizations.
//
// A pack is a JSON document: a workflow, the nodes to patch (prompt, seeds, dimensions), the model
// files it needs, and the tool it backs. Several packs can back one tool (Anima and Anima Turbo both
// back generate_illustrated_image); the user's config picks one. The tool itself (its title and the
// description's shared parts) is defined once, in packs/tools.json; a pack adds its prompt_guide.

import { PACK_FILES, TOOL_FILE } from "../packs/index.ts";
import { isPlainObject } from "./bytes.ts";
import { SETTINGS_SCHEMA, tagLoras, type Config, type LoraEntry } from "./config.ts";
import { injectLoras, nodesTitled, redrawSampler, TITLES, withBackgroundRemoval, withMarkRemoval } from "./workflow.ts";

export type Pack = Record<string, any> & {
  name: string;
  display_name: string;
  tool_name: string;
  /** How to prompt this model, in the tool's description; else the tool's default_guide. */
  prompt_guide?: string;
  /** Packs of one family share their settings (artists, LoRAs, resolution): Anima and Anima Turbo. */
  family?: string;
  /** The LoRA group the pack takes LoRAs from (a LoRA fits the models it was trained for: Anima and
   * Anima Turbo share "anima"); none: no LoRAs. */
  lora_group?: string;
  models: { url: string; subfolder: string; filename: string; size_bytes?: number; sha256?: string }[];
  /** ComfyUI API format; the nodes we fill in are found by title (workflow.ts TITLES). */
  workflow: Record<string, any>;
};

export const REQUIRED_FIELDS = ["name", "display_name", "tool_name", "models", "workflow"];

export type Tool = { title: string; description?: string; default_guide?: string };

const TOOL_DEFS = TOOL_FILE as {
  tools: Record<string, Tool>;
  lora_groups: Record<string, string>;
  remove_marks: Pick<Pack, "name" | "display_name" | "models">;
  remove_background: Pick<Pack, "name" | "display_name" | "models">;
  detect_faces: Pick<Pack, "name" | "display_name" | "models">;
};

/** The tools packs back, by name (packs/tools.json). */
export const TOOLS = TOOL_DEFS.tools;

/** The LoRA groups, id → the settings page's tab name, in order. The first is where a LoRA without
 * a group goes (tagLoras). */
export const LORA_GROUPS = TOOL_DEFS.lora_groups;
export const DEFAULT_LORA_GROUP = Object.keys(LORA_GROUPS)[0];

/** The models the signature and watermark removal needs (packs/tools.json), downloaded like a pack
 * of their own: the remove_marks setting adds them to what each GPU gets. */
export const MARK_MODELS: Pack = { tool_name: "", workflow: {}, ...TOOL_DEFS.remove_marks };

/** The model background removal needs (packs/tools.json), downloaded like a pack the first time a
 * call asks for it. */
export const BG_MODELS: Pack = { tool_name: "", workflow: {}, ...TOOL_DEFS.remove_background };

/** The face detector redraw finds a face with when the caller gives no box (packs/tools.json). */
export const FACE_MODELS: Pack = { tool_name: "", workflow: {}, ...TOOL_DEFS.detect_faces };

/** The model sets: downloaded in the background, never listed. */
export const MODEL_SETS = [MARK_MODELS, BG_MODELS, FACE_MODELS];
export const isModelSet = (pack: Pack) => MODEL_SETS.some((p) => p.name === pack.name);

/** The model sets a GPU keeps in place with *cfg*: background removal's and the face detector always
 * (any call may need them), the watermark removal's while it is on. */
export function wantedModelSets(cfg: Config): Pack[] {
  return cfg.remove_marks ? [MARK_MODELS, BG_MODELS, FACE_MODELS] : [BG_MODELS, FACE_MODELS];
}

/** *packLoras* with every one of *names* in a group: *group* when it is a LoRA group (the one an
 * upload was made for), else the default. Null if every name had one. See config.ts tagLoras. */
export function tagLooseLoras(packLoras: Record<string, LoraEntry[]>, names: Iterable<string>, group?: unknown): Record<string, LoraEntry[]> | null {
  return tagLoras(packLoras, names, typeof group === "string" && group in LORA_GROUPS ? group : DEFAULT_LORA_GROUP);
}

/** Check a pack has the required fields. Returns it; throws otherwise. */
export function validate(pack: unknown, source = "pack"): Pack {
  if (!isPlainObject(pack)) throw new Error(`${source}: not a JSON object`);
  const missing = REQUIRED_FIELDS.filter((f) => !(f in pack));
  if (missing.length) throw new Error(`${source}: missing required fields ${JSON.stringify(missing)}`);
  if (!(String(pack.tool_name) in TOOLS)) throw new Error(`${source}: unknown tool ${pack.tool_name} (packs/tools.json)`);
  if (pack.lora_group !== undefined && !(String(pack.lora_group) in LORA_GROUPS)) {
    throw new Error(`${source}: unknown LoRA group ${pack.lora_group} (packs/tools.json)`);
  }
  // The nodes we fill in, by title: one prompt, at least one seed; a model loader for LoRAs.
  const wf = isPlainObject(pack.workflow) ? (pack.workflow as Record<string, any>) : {};
  const count = (title: string) => nodesTitled(wf, title).length;
  if (count(TITLES.prompt) !== 1) throw new Error(`${source}: needs one node titled ${TITLES.prompt}`);
  if (!count(TITLES.seed)) throw new Error(`${source}: needs a node titled ${TITLES.seed}`);
  if (pack.lora_group !== undefined && count(TITLES.model) !== 1) throw new Error(`${source}: a pack with LoRAs needs one node titled ${TITLES.model}`);
  return pack as Pack;
}

/** The packs shipped with core, in file-name order. Bad ones are logged and skipped. */
export function builtinPacks(): Pack[] {
  const packs: Pack[] = [];
  for (const [file, data] of PACK_FILES) {
    try {
      packs.push(validate(structuredClone(data), file));
    } catch (e) {
      console.error(`Skipping pack ${file}: ${(e as Error).message}`);
    }
  }
  return packs;
}

/** The config bucket a pack reads its settings from (pack_settings, pack_loras): its family, else
 * its name. These are the keys stored in users' configs: a pack's family must not change. */
export function family(pack: Pack): string {
  return pack.family ?? pack.name;
}

export function groupByTool(packs: Pack[]): Record<string, Pack[]> {
  const groups: Record<string, Pack[]> = {};
  for (const pack of packs) (groups[pack.tool_name] ??= []).push(pack);
  return groups;
}

/** One pack per tool: the configured one, else the is_default one, else the first. */
export function select(groups: Record<string, Pack[]>, selections: Record<string, string>): Pack[] {
  return Object.values(groups).map((group) => {
    const wanted = selections[group[0].tool_name];
    return group.find((p) => p.name === wanted) ?? group.find((p) => p.is_default) ?? group[0];
  });
}

/** The pack a generate call runs: *selected*, or the one a scripted caller names in the hidden
 * `model` argument, which must back the same tool (design §3, Scripted callers). A string is the
 * error to answer with. */
export function packFor(packs: Pack[], selected: Pack, model: unknown): Pack | string {
  const name = typeof model === "string" ? model.trim() : "";
  if (!name) return selected;
  const choices = packs.filter((p) => p.tool_name === selected.tool_name);
  return (
    choices.find((p) => p.name === name) ??
    `Unknown model "${name}" for ${selected.tool_name}. Valid models: ${choices.map((p) => p.name).join(", ")}.`
  );
}

/** The tool whose packs redraw: illustrations only (the user's call, 2026-10-15). A photo has no art
 * style to drift, so edit_image serves it. */
export const REDRAW_TOOL = "generate_illustrated_image";

/** The pack redraw runs unless a scripted caller names another, whatever the settings select (the
 * user's call, 2026-10-15): Anima Turbo, about 11 s against base Anima's 72. Its family downloads
 * whole, so it is there wherever Anima is. */
export const REDRAW_DEFAULT = "anima_turbo";

/** Whether redraw can run on *pack*: an illustration pack whose sampler is a KSampler (it has a
 * denoise) fed by the pack's empty latent (workflow.ts redrawSampler). */
export function canRedraw(pack: Pack): boolean {
  return pack.tool_name === REDRAW_TOOL && redrawSampler(pack.workflow) !== null;
}

/** The pack a redraw call runs: the one a scripted caller names in the hidden `model`, else
 * REDRAW_DEFAULT. A string is the error to answer with. */
export function redrawPack(packs: Pack[], model: unknown): Pack | string {
  const able = packs.filter(canRedraw);
  const name = typeof model === "string" ? model.trim() : "";
  if (name) return able.find((p) => p.name === name) ?? `Unknown model "${name}" for redraw. Valid models: ${able.map((p) => p.name).join(", ")}.`;
  return able.find((p) => p.name === REDRAW_DEFAULT) ?? able[0] ?? "No model here can redraw.";
}

/** *selected* and every other pack of their families, in *packs* order: a family downloads whole,
 * so a call naming a family member finds it ready (design §3, Brain). */
export function withFamilies(selected: Pack[], packs: Pack[]): Pack[] {
  const families = new Set(selected.map(family));
  return packs.filter((p) => families.has(family(p)));
}

/** Whether the pack takes the user's LoRAs: it has a LoRA group. */
export function supportsLoras(pack: Pack): boolean {
  return Boolean(pack.lora_group);
}

/** The pack's switched-on LoRAs, from its group's list in a normalized config (config.ts cleans
 * the entries). */
export function packLoras(pack: Pack, cfg: Config): LoraEntry[] {
  if (!pack.lora_group) return [];
  return ((cfg.pack_loras?.[pack.lora_group] ?? []) as LoraEntry[]).filter((e) => e.enabled !== false);
}


/** The user's resolution budget, clamped to the model's limit. null when unset or invalid. */
function maxPixels(pack: Pack, cfg: Config): number | null {
  const limit = pack.max_pixels_limit;
  if (!limit) return null;
  const value = cfg.pack_settings?.[family(pack)]?.max_pixels;
  if (!Number.isInteger(value) || (value as number) <= 0) return null;
  return Math.min(value as number, limit);
}

/** A copy of *pack* with the user's LoRAs spliced in and resolution budget applied; with
 * *removeMarks* its images cleaned of signatures and watermarks before they are saved, and with
 * *removeBackground* saved with a transparent background. LoRA failures are logged and the pack
 * served without them rather than taking the tool down. */
export function prepare(pack: Pack, cfg: Config, { removeMarks = false, removeBackground = false } = {}): Pack {
  const out = structuredClone(pack);
  const ls = packLoras(out, cfg);
  if (ls.length) {
    try {
      out.lora_toggles = injectLoras(out.workflow, ls);
    } catch (e) {
      console.error(`Pack '${out.name}': LoRA injection failed (${(e as Error).message}), serving it unmodified`);
    }
  }
  const budget = maxPixels(out, cfg);
  if (budget !== null) out.max_pixels = budget;
  if (removeMarks) withMarkRemoval(out.workflow);
  if (removeBackground) withBackgroundRemoval(out.workflow);
  return out;
}

/** What a machine needs to make *pack* ready (the agent's ensure and download): its name, models and
 * node packages. */
export function packNeeds(pack: Pack) {
  return { name: pack.name, display_name: pack.display_name ?? pack.name, models: pack.models ?? [], required_nodes: pack.required_nodes ?? {} };
}

/** Total bytes of the pack's model files, for the settings UI. */
export function downloadSize(pack: Pack): number {
  return (pack.models ?? []).reduce((n, m) => n + (Number(m.size_bytes) || 0), 0);
}

/** What every settings page renders the settings from: the global fields' schema, the pack choices
 * per tool, and the LoRA groups ([{id, title}], the first the default). */
export function settingsMetadata(packs: Pack[]) {
  return { schema: SETTINGS_SCHEMA, packs: packMetadata(packs), lora_groups: Object.entries(LORA_GROUPS).map(([id, title]) => ({ id, title })) };
}

/** A pack's row in a /models answer (each frontend adds where its models are). */
export const packRow = (p: Pack) => ({ name: p.name, display_name: p.display_name ?? p.name, tool_name: p.tool_name, size: downloadSize(p) });

function packMetadata(packs: Pack[]) {
  return Object.entries(groupByTool(packs)).map(([tool, group]) => ({
    tool_name: tool,
    title: TOOLS[tool]?.title ?? tool,
    packs: group.map((p) => ({
      name: p.name,
      display_name: p.display_name ?? p.name,
      description: p.description ?? "",
      download_size: downloadSize(p),
      is_default: Boolean(p.is_default),
      family: family(p),
      max_pixels: p.max_pixels ?? null,
      max_pixels_limit: p.max_pixels_limit ?? null,
      default_artist_list: p.default_artist_list ?? null,
      supports_loras: supportsLoras(p),
      lora_group: p.lora_group ?? null,
    })),
  }));
}
