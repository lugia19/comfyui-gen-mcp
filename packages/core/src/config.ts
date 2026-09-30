// The user config shared by every brain (the Worker's state, the MCPB's local JSON).
//
// Both read and write the same shape, so switching modes keeps settings. Pack-derived settings
// (pack choice, artists, LoRAs, resolution) are keyed by pack and built into the settings UI from
// the loaded packs; SETTINGS_SCHEMA covers only the global, statically known fields. Frontends may
// add their own keys (the MCPB's ComfyUI URL, for instance); normalize() keeps them.
//
//   pack_selections   {tool_name: pack_name}
//   pack_settings     {config_key: {artist_list: string, max_pixels: number}}
//   pack_loras        {config_key: [{name, strength, trigger, hidden}]}
//   keep_warm_minutes integer, how long an idle generator stays up
//   pc_keep_warm_minutes  the same for the Worker's paired PC, where idle time costs nothing

import { isPlainObject } from "./bytes.ts";

export const DEFAULT_KEEP_WARM_MINUTES = 5;
const KEEP_WARM_MAX = 60;
export const LORA_STRENGTH_MAX = 5;

export type LoraEntry = { name: string; strength: number; trigger: string; hidden: boolean };

export type Config = {
  pack_selections: Record<string, string>;
  pack_settings: Record<string, { artist_list?: string; max_pixels?: number }>;
  pack_loras: Record<string, any[]>;
  keep_warm_minutes: number;
  pc_keep_warm_minutes: number;
  [key: string]: any;
};

export const DEFAULTS: Config = {
  pack_selections: {},
  pack_settings: {},
  pack_loras: {},
  keep_warm_minutes: DEFAULT_KEEP_WARM_MINUTES,
  pc_keep_warm_minutes: DEFAULT_KEEP_WARM_MINUTES,
};

// Each field: key, title, description, type ("int" | "bool" | "text"), default,
// min/max for ints, advanced for grouping, pc for the Worker's paired PC only. The settings app
// renders these.
export const SETTINGS_SCHEMA = [
  {
    key: "keep_warm_minutes",
    title: "Keep warm (minutes)",
    description:
      "How long the GPU stays up after the last image. Longer means fewer cold starts; " +
      "on Modal it also means paying for idle time.",
    type: "int",
    default: DEFAULT_KEEP_WARM_MINUTES,
    min: 1,
    max: KEEP_WARM_MAX,
  },
  {
    key: "pc_keep_warm_minutes",
    title: "Keep warm on your PC (minutes)",
    description: "How long ComfyUI keeps the model loaded on your PC after the last image.",
    type: "int",
    default: DEFAULT_KEEP_WARM_MINUTES,
    min: 1,
    max: KEEP_WARM_MAX,
    pc: true,
  },
];

// Settings of removed features, dropped on read so the next save forgets them: custom_workflow
// (custom workflows, removed 2026-09-30).
const REMOVED = new Set(["custom_workflow"]);

/** Fill in defaults and drop wrongly typed known values. Unknown keys are kept. Never throws. */
export function normalize(raw: unknown): Config {
  const cfg = structuredClone(DEFAULTS);
  if (!isPlainObject(raw)) return cfg;
  for (const [key, val] of Object.entries(raw)) {
    if (REMOVED.has(key)) continue;
    if (!(key in DEFAULTS)) {
      cfg[key] = structuredClone(val); // a newer version's or a frontend's key: keep it
    } else if (key === "keep_warm_minutes" || key === "pc_keep_warm_minutes") {
      if (Number.isInteger(val) && val > 0) cfg[key] = Math.min(val, KEEP_WARM_MAX);
    } else if (key === "pack_loras") {
      if (isPlainObject(val)) cfg[key] = Object.fromEntries(Object.entries(val).map(([k, list]) => [k, loraEntries(list)]));
    } else if (isPlainObject(val)) {
      cfg[key] = structuredClone(val);
    }
  }
  return cfg;
}

/** A strength from hand-edited or older configs: missing or blank means 1, a boolean on/off, a
 * numeric string its number; anything else 1. */
function strengthOf(value: unknown): number {
  if (value === undefined || (typeof value === "string" && !value.trim())) return 1;
  if (typeof value === "boolean") return value ? 1 : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 1;
}

/** A pack's LoRA list, cleaned: a bare string is a file name; entries without a name are dropped;
 * strength is clamped to ±LORA_STRENGTH_MAX. Everything downstream reads this shape. */
function loraEntries(list: unknown): LoraEntry[] {
  if (!Array.isArray(list)) return [];
  const out: LoraEntry[] = [];
  for (const raw of list) {
    const e = typeof raw === "string" ? { name: raw } : raw;
    if (!isPlainObject(e) || typeof e.name !== "string" || !e.name.trim()) continue;
    out.push({
      name: e.name.trim(),
      strength: Math.max(-LORA_STRENGTH_MAX, Math.min(LORA_STRENGTH_MAX, strengthOf(e.strength))),
      trigger: typeof e.trigger === "string" ? e.trigger.trim() : "",
      hidden: e.hidden === true,
    });
  }
  return out;
}
