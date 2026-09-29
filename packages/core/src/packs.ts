// Model packs: load, validate, pick one per tool, apply the user's customizations.
//
// A pack is a JSON document: a workflow, the nodes to patch (prompt, seeds, dimensions), the model
// files it needs, and the tool it backs. Several packs can back one tool (Anima and Anima Turbo both
// back generate_illustrated_image); the user's config picks one.

import { PACK_FILES } from "../packs/index.ts";
import { isPlainObject } from "./bytes.ts";
import type { Config } from "./config.ts";
import { injectLoras, type Lora } from "./workflow.ts";

export type Pack = Record<string, any> & {
  name: string;
  display_name: string;
  tool_name: string;
  tool_description: string;
  models: { url: string; subfolder: string; filename: string; size_bytes?: number; sha256?: string }[];
  workflow: Record<string, any>;
  prompt_node_id: string;
  seed_nodes: { node_id: string; field: string }[];
};

export const REQUIRED_FIELDS = [
  "name", "display_name", "tool_name", "tool_description", "models", "workflow", "prompt_node_id", "seed_nodes",
];

/** Check a pack has the required fields. Returns it; throws otherwise. */
export function validate(pack: unknown, source = "pack"): Pack {
  if (!isPlainObject(pack)) throw new Error(`${source}: not a JSON object`);
  const missing = REQUIRED_FIELDS.filter((f) => !(f in pack));
  if (missing.length) throw new Error(`${source}: missing required fields ${JSON.stringify(missing)}`);
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

/** The config bucket a pack reads its settings from. Anima and Anima Turbo share one. */
export function configKey(pack: Pack): string {
  return pack.config_key ?? pack.name;
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

function strengthOf(value: unknown): number {
  if (value === undefined) return 1.0;
  if (typeof value === "boolean") return value ? 1.0 : 0.0;
  if (typeof value === "string" && !value.trim()) return 1.0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 1.0;
}

/** Whether the pack takes the user's LoRAs: the Anima family (the packs with an artist list), whose
 * plain UNET loader LoraLoaderModelOnly can follow. */
export function supportsLoras(pack: Pack): boolean {
  return Boolean(pack.default_artist_list);
}

function loras(pack: Pack, cfg: Config): Lora[] {
  const raw = cfg.pack_loras?.[configKey(pack)] || [];
  if (raw.length && !supportsLoras(pack)) {
    console.warn(`Pack '${pack.name}': LoRAs configured but not supported for this pack, ignoring`);
    return [];
  }
  const out: Lora[] = [];
  for (let entry of raw) {
    if (typeof entry === "string") entry = { name: entry };
    if (!isPlainObject(entry) || !entry.name) {
      console.warn(`Pack '${pack.name}': skipping malformed LoRA entry ${JSON.stringify(entry)}`);
      continue;
    }
    out.push({ name: String(entry.name), strength: strengthOf(entry.strength), trigger: String(entry.trigger || "").trim() });
  }
  return out;
}

/** The user's resolution budget, clamped to the model's limit. null when unset or invalid. */
function maxPixels(pack: Pack, cfg: Config): number | null {
  const limit = pack.max_pixels_limit;
  if (!limit) return null;
  const value = cfg.pack_settings?.[configKey(pack)]?.max_pixels;
  if (!Number.isInteger(value) || (value as number) <= 0) return null;
  return Math.min(value as number, limit);
}

/** A copy of *pack* with the user's LoRAs spliced in and resolution budget applied. Failures are
 * logged and the pack served unmodified rather than taking the tool down. */
export function prepare(pack: Pack, cfg: Config): Pack {
  const out = structuredClone(pack);
  const ls = loras(out, cfg);
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

/** Custom node classes the pack needs, mapped to the node package providing them. */
export function requiredNodes(pack: Pack): Record<string, string> {
  return { ...(pack.required_nodes ?? {}) };
}

/** Total bytes of the pack's model files, for the settings UI. */
export function downloadSize(pack: Pack): number {
  return (pack.models ?? []).reduce((n, m) => n + (Number(m.size_bytes) || 0), 0);
}
