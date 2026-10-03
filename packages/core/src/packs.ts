// Model packs: load, validate, pick one per tool, apply the user's customizations.
//
// A pack is a JSON document: a workflow, the nodes to patch (prompt, seeds, dimensions), the model
// files it needs, and the tool it backs. Several packs can back one tool (Anima and Anima Turbo both
// back generate_illustrated_image); the user's config picks one. The tool itself (its title and the
// description's shared parts) is defined once, in packs/tools.json; a pack adds its prompt_guide.

import { PACK_FILES, TOOL_FILE } from "../packs/index.ts";
import { isPlainObject } from "./bytes.ts";
import { tagLoras, type Config, type LoraEntry } from "./config.ts";
import { injectLoras } from "./workflow.ts";

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
  workflow: Record<string, any>;
  prompt_node_id: string;
  seed_nodes: { node_id: string; field: string }[];
};

export const REQUIRED_FIELDS = ["name", "display_name", "tool_name", "models", "workflow", "prompt_node_id", "seed_nodes"];

export type Tool = { title: string; description?: string; default_guide?: string };

const TOOL_DEFS = TOOL_FILE as { tools: Record<string, Tool>; lora_groups: Record<string, string> };

/** The tools packs back, by name (packs/tools.json). */
export const TOOLS = TOOL_DEFS.tools;

/** The LoRA groups, id → the settings page's tab name, in order. The first is where a LoRA without
 * a group goes (tagLoras). */
export const LORA_GROUPS = TOOL_DEFS.lora_groups;
export const DEFAULT_LORA_GROUP = Object.keys(LORA_GROUPS)[0];

/** *packLoras* with every one of *names* in a group: see config.ts tagLoras. */
export function tagLooseLoras(packLoras: Record<string, LoraEntry[]>, names: Iterable<string>): Record<string, LoraEntry[]> | null {
  return tagLoras(packLoras, names, DEFAULT_LORA_GROUP);
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

/** A copy of *pack* with the user's LoRAs spliced in and resolution budget applied. Failures are
 * logged and the pack served unmodified rather than taking the tool down. */
export function prepare(pack: Pack, cfg: Config): Pack {
  const out = structuredClone(pack);
  const ls = packLoras(out, cfg);
  if (ls.length) {
    try {
      out.lora_toggles = injectLoras(out.workflow, ls, out.lora_target);
    } catch (e) {
      console.error(`Pack '${out.name}': LoRA injection failed (${(e as Error).message}), serving it unmodified`);
    }
  }
  const budget = maxPixels(out, cfg);
  if (budget !== null) out.max_pixels = budget;
  return out;
}

/** Total bytes of the pack's model files, for the settings UI. */
export function downloadSize(pack: Pack): number {
  return (pack.models ?? []).reduce((n, m) => n + (Number(m.size_bytes) || 0), 0);
}

/** The LoRA groups for a settings page: [{id, title}], in order (the first is the default). */
export function loraGroupMetadata() {
  return Object.entries(LORA_GROUPS).map(([id, title]) => ({ id, title }));
}

/** What a settings page needs to render the pack choices, per tool. */
export function packMetadata(packs: Pack[]) {
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
