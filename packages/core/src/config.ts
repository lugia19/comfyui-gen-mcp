// The user config shared by every brain (the Worker's state, the MCPB's local JSON).
//
// Both read and write the same shape, so switching modes keeps settings. Pack-derived settings
// (pack choice, artists, LoRAs, resolution) are keyed by pack and built into the settings UI from
// the loaded packs; SETTINGS_SCHEMA covers only the global, statically known fields. Frontends may
// add their own keys (the MCPB's MCP port, for instance); normalize() keeps them.
//
//   pack_selections   {tool_name: pack_name}
//   pack_settings     {family: {artist_list: string, max_pixels: number}}
//   pack_loras        {lora group: [{name, strength, trigger, hidden, enabled}]}: a LoRA belongs to
//                     one group (the models it was trained for), and is on or off in it
//   keep_warm_minutes integer, how long an idle ComfyUI stays up (the extension's; on a Worker each
//                     GPU in its list has its own)
//   remove_marks      boolean, default on: clean the signatures and watermarks some artist styles
//                     paint into images (our ComfyUI extension's node, where the GPU has it)

import { isPlainObject } from "./bytes.ts";

export const DEFAULT_KEEP_WARM_MINUTES = 5;
const KEEP_WARM_MAX = 60;
export const LORA_STRENGTH_MAX = 5;

export type LoraEntry = { name: string; strength: number; trigger: string; hidden: boolean; enabled: boolean };

export type Config = {
  pack_selections: Record<string, string>;
  pack_settings: Record<string, { artist_list?: string; max_pixels?: number }>;
  pack_loras: Record<string, any[]>;
  keep_warm_minutes: number;
  remove_marks: boolean;
  [key: string]: any;
};

export const DEFAULTS: Config = {
  pack_selections: {},
  pack_settings: {},
  pack_loras: {},
  keep_warm_minutes: DEFAULT_KEEP_WARM_MINUTES,
  remove_marks: true,
};

// Each field: key, title, description, type ("int" | "bool" | "text"), default,
// min/max for ints, advanced for grouping, machine for the extension only (a Worker sets these per
// GPU). The settings app renders these.
export const SETTINGS_SCHEMA = [
  {
    key: "keep_warm_minutes",
    title: "Keep warm (minutes)",
    description:
      "How long ComfyUI keeps its model loaded after the last image, then stops to free the GPU. " +
      "Longer means fewer cold starts.",
    type: "int",
    default: DEFAULT_KEEP_WARM_MINUTES,
    min: 1,
    max: KEEP_WARM_MAX,
    machine: true,
  },
  {
    key: "remove_marks",
    title: "Remove signatures and watermarks",
    description:
      "Some artist styles come with the artist's signature, stamp or Patreon link painted in. " +
      "When one is found, it is filled in to match the image around it.",
    type: "bool",
    default: true,
  },
];

/** Fill in defaults and drop wrongly typed known values. Unknown keys are kept. Never throws. */
export function normalize(raw: unknown): Config {
  const cfg = structuredClone(DEFAULTS);
  if (!isPlainObject(raw)) return cfg;
  for (const [key, val] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) {
      cfg[key] = structuredClone(val); // a newer version's or a frontend's key: keep it
    } else if (key === "keep_warm_minutes") {
      if (Number.isInteger(val) && val > 0) cfg[key] = Math.min(val, KEEP_WARM_MAX);
    } else if (key === "remove_marks") {
      if (typeof val === "boolean") cfg[key] = val;
    } else if (key === "pack_loras") {
      if (isPlainObject(val)) cfg[key] = loraGroups(val);
    } else if (isPlainObject(val)) {
      cfg[key] = structuredClone(val);
    }
  }
  return cfg;
}

/** A strength: a number, or a numeric string (the MCPB's config.json is hand-editable); anything
 * else, missing or blank means 1. */
function strengthOf(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : 1;
  return Number.isFinite(n) ? n : 1;
}

/** Every LoRA file some pack is set up to use (switched on in its group). */
export const wantedLoras = (cfg: Config): string[] =>
  [...new Set(Object.values(cfg.pack_loras).flat().filter((l) => l.enabled !== false).map((l) => l.name as string))];

/** *pack_loras* without the LoRA *name* in any pack, or null if no pack had it. A deleted LoRA leaves
 * the config with its file, or every generation of that pack would ask ComfyUI for a missing file. */
export function withoutLora(packLoras: Record<string, LoraEntry[]>, name: string): Record<string, LoraEntry[]> | null {
  if (!Object.values(packLoras).some((list) => list.some((e) => e.name === name))) return null;
  return Object.fromEntries(Object.entries(packLoras).map(([key, list]) => [key, list.filter((e) => e.name !== name)]));
}

/** *pack_loras* with every LoRA *names* lists that is in no group added to *group*, switched off
 * (as a stored LoRA nobody ticked was before groups); null if every name already had a group. A
 * LoRA uploaded before groups, or pushed from a PC, gets one this way (2026-10-03: they all became
 * Anima LoRAs, the one family that took LoRAs). */
export function tagLoras(packLoras: Record<string, LoraEntry[]>, names: Iterable<string>, group: string): Record<string, LoraEntry[]> | null {
  const grouped = new Set(Object.values(packLoras).flatMap((list) => list.map((e) => e.name)));
  const loose = [...new Set(names)].filter((n) => !grouped.has(n)).sort();
  if (!loose.length) return null;
  const added = loose.map((name) => ({ name, strength: 1, trigger: "", hidden: false, enabled: false }));
  return { ...packLoras, [group]: [...(packLoras[group] ?? []), ...added] };
}

/** Every group's list cleaned, each LoRA in one group only: a name already listed in an earlier
 * group is dropped from later ones (only a hand-edited config has that). */
function loraGroups(val: Record<string, unknown>): Record<string, LoraEntry[]> {
  const seen = new Set<string>();
  return Object.fromEntries(
    Object.entries(val).map(([group, list]) => [
      group,
      loraEntries(list).filter((e) => !seen.has(e.name) && (seen.add(e.name), true)),
    ]),
  );
}

/** A group's LoRA list, cleaned: entries without a name are dropped; strength is clamped to
 * ±LORA_STRENGTH_MAX; an entry is on unless it says enabled: false. Everything downstream reads
 * this shape. */
function loraEntries(list: unknown): LoraEntry[] {
  if (!Array.isArray(list)) return [];
  const out: LoraEntry[] = [];
  for (const e of list) {
    if (!isPlainObject(e) || typeof e.name !== "string" || !e.name.trim()) continue;
    out.push({
      name: e.name.trim(),
      strength: Math.max(-LORA_STRENGTH_MAX, Math.min(LORA_STRENGTH_MAX, strengthOf(e.strength))),
      trigger: typeof e.trigger === "string" ? e.trigger.trim() : "",
      hidden: e.hidden === true,
      enabled: e.enabled !== false,
    });
  }
  return out;
}
