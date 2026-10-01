// Workflow building: prompt injection, seeds, dimensions, LoRA splicing, custom workflows.
// Pure functions over ComfyUI API-format workflow objects. No I/O, so it runs anywhere.
//
// Node order: JS objects list integer-like keys ("3", "19") first, ascending, whatever order the
// JSON had. ComfyUI node ids are such keys, so "the first KSampler" is the one with the lowest id.

import { isPlainObject, randomSeed, roundHalfEven } from "./bytes.ts";

export type Node = { class_type: string; inputs: Record<string, any>; _meta?: { title?: string } };
export type Workflow = Record<string, Node>;
export type NodeField = { node_id: string | number; field: string };
export type LoraToggle = { node_id: string; trigger: string; strength: number };
export type Rng = () => number;

export const ASPECT_RATIOS: Record<string, [number, number]> = {
  square: [1, 1],
  portrait: [3, 4],
  landscape: [4, 3],
  tall: [9, 16],
  wide: [16, 9],
};

// "1024x768"-style aspect override; deliberately absent from the tool schemas and descriptions.
// It's for scripted callers, not the model.
const WH_RE = /^\s*(\d+)\s*[xX]\s*(\d+)\s*$/;

// A ":lossless" suffix once asked for a PNG (results were JPEG, which has no transparency). WebP
// has both, so it is only stripped now, in case an old habit or script still adds it.
const LOSSLESS_SUFFIX = ":lossless";

// Loaders whose output carries MODEL, and at which index. LoRAs go on the model path only.
export const MODEL_LOADERS: Record<string, number> = {
  UNETLoader: 0,
  UnetLoaderGGUF: 0,
  CheckpointLoaderSimple: 0,
  CheckpointLoader: 0,
};

/** Without a trailing ":lossless" (case-insensitive). Only a trailing match, so drive colons survive. */
export function stripLossless(value: string): string {
  const s = (value || "").trim();
  return s.toLowerCase().endsWith(LOSSLESS_SUFFIX) ? s.slice(0, -LOSSLESS_SUFFIX.length).trim() : value;
}

/**
 * Width and height for an aspect ratio name (or "WxH") within a pixel budget. "WxH" sets the shape,
 * not the size. Unknown values fall back to square. Rounds to multiples of 64 (latent alignment).
 */
export function calcDimensions(aspect: string, maxPixels: number): [number, number] {
  let ratio = ASPECT_RATIOS[aspect];
  if (!ratio) {
    const m = WH_RE.exec(aspect || "");
    ratio = m && +m[1] > 0 && +m[2] > 0 ? [+m[1], +m[2]] : [1, 1];
  }
  const [wr, hr] = ratio;
  const scale = Math.sqrt(maxPixels / (wr * hr));
  const w = roundHalfEven((wr * scale) / 64) * 64;
  const h = roundHalfEven((hr * scale) / 64) * 64;
  return [Math.max(w, 64), Math.max(h, 64)];
}

export type BuildOptions = {
  dimensionNodes?: { width?: NodeField[]; height?: NodeField[] } | null;
  aspectRatio?: string;
  maxPixels?: number;
  loraToggles?: LoraToggle[] | null;
  rng?: Rng;
};

/** Copy a workflow, inject the prompt, randomize seeds, set dimensions, gate LoRAs on their triggers. */
export function buildPrompt(
  workflow: Workflow,
  promptText: string,
  promptNodeId: string | number,
  seedNodes: NodeField[],
  opts: BuildOptions = {},
): Workflow {
  const rng = opts.rng ?? randomSeed;
  const wf: Workflow = structuredClone(workflow);
  wf[String(promptNodeId)].inputs.text = promptText;

  for (const sn of seedNodes) {
    const nid = String(sn.node_id);
    if (nid in wf) wf[nid].inputs[sn.field] = rng();
  }

  if (opts.dimensionNodes) {
    const [w, h] = calcDimensions(opts.aspectRatio ?? "square", opts.maxPixels ?? 1_048_576);
    for (const [axis, value] of [["width", w], ["height", h]] as const) {
      for (const patch of opts.dimensionNodes[axis] ?? []) {
        if (String(patch.node_id) in wf) wf[String(patch.node_id)].inputs[patch.field] = value;
      }
    }
  }

  if (opts.loraToggles?.length) {
    const lowered = promptText.toLowerCase();
    for (const tog of opts.loraToggles) {
      const nid = String(tog.node_id);
      if (!(nid in wf)) continue;
      const trigger = tog.trigger || "";
      const active = !trigger || lowered.includes(trigger.toLowerCase());
      wf[nid].inputs.strength_model = active ? Number(tog.strength) : 0.0;
    }
  }
  return wf;
}

function findLoaderSource(workflow: Workflow, loaders: Record<string, number>): [string, number] | null {
  for (const [nodeId, node] of Object.entries(workflow)) {
    const idx = loaders[node.class_type];
    if (idx !== undefined) return [nodeId, idx];
  }
  return null;
}

function nextNodeId(workflow: Workflow): number {
  let highest = 0;
  for (const key of Object.keys(workflow)) {
    if (/^\s*[+-]?\d+\s*$/.test(key)) highest = Math.max(highest, parseInt(key, 10));
  }
  return highest + 1;
}

/** Every [nodeId, inputKey] whose input link is exactly *source*. */
function consumersOf(workflow: Workflow, source: [string, number]): [string, string][] {
  const matches: [string, string][] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    for (const [key, val] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(val) && val.length === 2 && val[0] === source[0] && val[1] === source[1]) {
        matches.push([nodeId, key]);
      }
    }
  }
  return matches;
}

export type Lora = { name: string; strength?: number; trigger?: string };

/**
 * Splice a chain of LoraLoaderModelOnly nodes after the model loader, in place, and rewire every
 * downstream MODEL consumer to the end of the chain. Returns toggles for the trigger-gated LoRAs.
 * *target* overrides detection: {"model": [id, idx]}. Throws if there is no model loader.
 */
export function injectLoras(workflow: Workflow, loras: Lora[], target?: { model?: [string, number] } | null): LoraToggle[] {
  if (!loras.length) return [];
  const modelSrc = target?.model ?? findLoaderSource(workflow, MODEL_LOADERS);
  if (!modelSrc) {
    throw new Error(
      "Could not locate a model loader to attach LoRAs to. " +
        `Known loaders: ${JSON.stringify(Object.keys(MODEL_LOADERS).sort())}. ` +
        "Set a 'lora_target' override in the pack JSON if this workflow is non-standard.",
    );
  }
  const modelConsumers = consumersOf(workflow, modelSrc); // before splicing, so new nodes aren't rewired

  let nextId = nextNodeId(workflow);
  let modelHead: [string, number] = modelSrc;
  const toggles: LoraToggle[] = [];
  for (const lora of loras) {
    const strength = Number(lora.strength ?? 1.0);
    const trigger = String(lora.trigger || "").trim();
    const nodeId = String(nextId++);
    workflow[nodeId] = {
      inputs: { lora_name: lora.name, strength_model: strength, model: modelHead },
      class_type: "LoraLoaderModelOnly",
      _meta: { title: `Load LoRA (injected${trigger ? ", trigger=" + trigger : ""})` },
    };
    modelHead = [nodeId, 0];
    if (trigger) toggles.push({ node_id: nodeId, trigger, strength });
  }
  for (const [nodeId, key] of modelConsumers) workflow[nodeId].inputs[key] = modelHead;
  return toggles;
}
