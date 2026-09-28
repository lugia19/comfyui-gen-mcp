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
//   custom_workflow   {workflow: {...API format...}, prompt_node_title: string} or null
//   keep_warm_minutes integer, how long an idle generator stays up

import { isPlainObject } from "./bytes.ts";

export const DEFAULT_KEEP_WARM_MINUTES = 5;

export type Config = {
  pack_selections: Record<string, string>;
  pack_settings: Record<string, { artist_list?: string; max_pixels?: number }>;
  pack_loras: Record<string, any[]>;
  custom_workflow: { workflow: Record<string, any>; prompt_node_title?: string } | null;
  keep_warm_minutes: number;
  [key: string]: any;
};

export const DEFAULTS: Config = {
  pack_selections: {},
  pack_settings: {},
  pack_loras: {},
  custom_workflow: null,
  keep_warm_minutes: DEFAULT_KEEP_WARM_MINUTES,
};

// Each field: key, title, description, type ("int" | "bool" | "text" | "workflow"), default,
// min/max for ints, advanced for grouping. The settings app renders these.
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
    max: 60,
  },
  {
    key: "custom_workflow",
    title: "Custom workflow",
    description: "A ComfyUI workflow exported in API format. When set, it backs the generate_custom_image tool.",
    type: "workflow",
    default: null,
    advanced: true,
  },
];

/** Fill in defaults and drop wrongly typed known values. Unknown keys are kept. Never throws. */
export function normalize(raw: unknown): Config {
  const cfg = structuredClone(DEFAULTS);
  if (!isPlainObject(raw)) return cfg;
  for (const [key, val] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) {
      cfg[key] = structuredClone(val); // a newer version's or a frontend's key: keep it
    } else if (key === "custom_workflow") {
      if (val === null || (isPlainObject(val) && isPlainObject(val.workflow))) cfg[key] = structuredClone(val);
    } else if (key === "keep_warm_minutes") {
      if (Number.isInteger(val) && val > 0) cfg[key] = val;
    } else if (isPlainObject(val)) {
      cfg[key] = structuredClone(val);
    }
  }
  return cfg;
}
