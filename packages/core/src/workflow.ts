// Workflow building: prompt injection, seeds, dimensions, LoRA splicing, an edit's extra images.
// Pure functions over ComfyUI API-format workflow objects. No I/O, so it runs anywhere.
//
// A pack's workflow marks the nodes we fill in by their title (_meta.title, which ComfyUI's API
// export keeps and its runtime ignores), set by renaming the node in ComfyUI before exporting:
//   cg:prompt        the prompt's text encoder: its `text`
//   cg:negative      the negative prompt's text encoder: its `text`, when a call passes one
//   cg:seed          each node with a seed: its `seed` or `noise_seed`
//   cg:size          a node with `width` and `height` (an empty latent)
//   cg:width/height  number nodes: their `value`
//   cg:model         the model loader LoRAs attach to (output 0)
//   cg:image…        an edit's nodes for its first image (see withImages)
// Save nodes need no title: any node with a `filename_prefix` gets this call's own (outputName).
// A node this code adds is titled too: cg:remove marks (withMarkRemoval).
//
// Node order: JS objects list integer-like keys ("3", "19") first, ascending, whatever order the
// JSON had. ComfyUI node ids are such keys, so "the first KSampler" is the one with the lowest id.

import { isPlainObject, randomSeed, roundHalfEven, tokenHex } from "./bytes.ts";

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
// A "WxH" with both sides at least this is a size; smaller ("16x9") is only a shape.
const MIN_EXACT_SIDE = 256;

export const TITLES = {
  prompt: "cg:prompt",
  negative: "cg:negative",
  seed: "cg:seed",
  size: "cg:size",
  width: "cg:width",
  height: "cg:height",
  model: "cg:model",
  image: "cg:image",
  imageScale: "cg:image scale",
  imageChain: "cg:image chain",
  removeMarks: "cg:remove marks",
  backgroundModel: "cg:background model",
  background: "cg:remove background",
  backgroundAlpha: "cg:background alpha",
  backgroundJoin: "cg:background join",
} as const;
const IMAGE_GROUP = "cg:image"; // every node whose title starts so is part of one image's chain

/** The ids of the nodes titled *title*, in the workflow's key order. */
export function nodesTitled(workflow: Workflow, title: string): string[] {
  return Object.keys(workflow).filter((id) => workflow[id]._meta?.title === title);
}

/**
 * Width and height for an aspect ratio name (or "WxH") within a pixel budget. A named ratio fills
 * the budget. "WxH" is that size when it fits the budget (sides of MIN_EXACT_SIDE or more), and
 * otherwise sets only the shape. Unknown values fall back to square. Rounds to multiples of 64
 * (latent alignment).
 */
export function calcDimensions(aspect: string, maxPixels: number): [number, number] {
  let ratio = ASPECT_RATIOS[aspect];
  if (!ratio) {
    const m = WH_RE.exec(aspect || "");
    ratio = m && +m[1] > 0 && +m[2] > 0 ? [+m[1], +m[2]] : [1, 1];
    if (m && ratio[0] >= MIN_EXACT_SIDE && ratio[1] >= MIN_EXACT_SIDE) {
      const [w, h] = ratio.map((n) => roundHalfEven(n / 64) * 64);
      if (w * h <= maxPixels) return [w, h];
    }
  }
  const [wr, hr] = ratio;
  const scale = Math.sqrt(maxPixels / (wr * hr));
  const w = roundHalfEven((wr * scale) / 64) * 64;
  const h = roundHalfEven((hr * scale) / 64) * 64;
  return [Math.max(w, 64), Math.max(h, 64)];
}

export type BuildOptions = {
  aspectRatio?: string;
  maxPixels?: number;
  loraToggles?: LoraToggle[] | null;
  rng?: Rng;
  outputName?: string; // the save nodes' filename_prefix; a new one per call by default
  negative?: string; // replaces the cg:negative node's text when not blank (a hidden argument, like "WxH")
};

/** A call's own output name, `comfy-gen/<12 hex>`: ComfyUI saves it as output/comfy-gen/<hex>_00001_.png.
 * Two ComfyUIs sharing an output folder (Modal containers on one Volume, as during a redeploy)
 * each count from 00001 per prefix, so a shared prefix would let one overwrite the other's image
 * before it is read. */
export const outputName = (): string => `comfy-gen/${tokenHex(6)}`;

/** Copy a workflow, inject the prompt, randomize seeds, set dimensions (where it has size nodes: an
 * edit's follow its first image), gate LoRAs on their triggers (one whose trigger is not in the
 * prompt is taken out of the chain: ComfyUI checks every loader's file, so a LoRA left in at
 * strength 0 fails the call when its file is missing). Nodes are found by title (TITLES). */
export function buildPrompt(workflow: Workflow, promptText: string, opts: BuildOptions = {}): Workflow {
  const rng = opts.rng ?? randomSeed;
  const wf: Workflow = structuredClone(workflow);
  const [promptNode] = nodesTitled(wf, TITLES.prompt);
  if (!promptNode) throw new Error(`the workflow has no node titled ${TITLES.prompt}`);
  wf[promptNode].inputs.text = promptText;
  const negative = opts.negative?.trim();
  if (negative) for (const id of nodesTitled(wf, TITLES.negative)) wf[id].inputs.text = negative;

  const name = opts.outputName ?? outputName();
  for (const node of Object.values(wf)) {
    if (typeof node.inputs?.filename_prefix === "string") node.inputs.filename_prefix = name;
  }

  for (const id of nodesTitled(wf, TITLES.seed)) {
    const field = "noise_seed" in wf[id].inputs ? "noise_seed" : "seed";
    wf[id].inputs[field] = rng();
  }

  const sizeNodes = nodesTitled(wf, TITLES.size);
  const widthNodes = nodesTitled(wf, TITLES.width);
  const heightNodes = nodesTitled(wf, TITLES.height);
  if (sizeNodes.length || widthNodes.length || heightNodes.length) {
    const [w, h] = calcDimensions(opts.aspectRatio ?? "square", opts.maxPixels ?? 1_048_576);
    for (const id of sizeNodes) Object.assign(wf[id].inputs, { width: w, height: h });
    for (const id of widthNodes) wf[id].inputs.value = w;
    for (const id of heightNodes) wf[id].inputs.value = h;
  }

  if (opts.loraToggles?.length) {
    const lowered = promptText.toLowerCase();
    for (const tog of opts.loraToggles) {
      const nid = String(tog.node_id);
      if (!(nid in wf)) continue;
      const trigger = tog.trigger || "";
      if (!trigger || lowered.includes(trigger.toLowerCase())) {
        wf[nid].inputs.strength_model = Number(tog.strength);
        continue;
      }
      const source = wf[nid].inputs.model;
      for (const [consumer, key] of consumersOf(wf, [nid, 0])) wf[consumer].inputs[key] = source;
      delete wf[nid];
    }
  }
  return wf;
}

/** The next free integer node id (ids like "169:100", from ComfyUI's subgraphs, are not counted). */
export function nextNodeId(workflow: Workflow): number {
  let highest = 0;
  for (const key of Object.keys(workflow)) {
    if (/^\s*[+-]?\d+\s*$/.test(key)) highest = Math.max(highest, parseInt(key, 10));
  }
  return highest + 1;
}

/** Every [nodeId, inputKey] whose input link is exactly *source*. */
export function consumersOf(workflow: Workflow, source: [string, number]): [string, string][] {
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
 * Splice a chain of LoraLoaderModelOnly nodes after the model loader (titled cg:model), in place,
 * and rewire every downstream MODEL consumer to the end of the chain. Returns toggles for the
 * trigger-gated LoRAs. Throws if there is no cg:model node.
 */
export function injectLoras(workflow: Workflow, loras: Lora[]): LoraToggle[] {
  if (!loras.length) return [];
  const [loader] = nodesTitled(workflow, TITLES.model);
  if (!loader) throw new Error(`no node titled ${TITLES.model} to attach LoRAs to`);
  const modelSrc: [string, number] = [loader, 0];
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

/** Our ComfyUI extension's node (comfy_gen_modal/comfy_node) that finds signatures and watermarks in
 * an image and fills them. */
export const REMOVE_MARKS_NODE = "ComfyGenRemoveMarks";
// What the detector must be sure of. Marks scored 0.24 (one cut off by the image's top edge) to 0.81;
// nothing else in 44 test images scored over 0.14, and the node drops boxes too big to be marks.
const MARK_THRESHOLD = 0.2;

/** Feed every SaveImage of *workflow* through REMOVE_MARKS_NODE, so images are saved cleaned. */
export function withMarkRemoval(workflow: Workflow): void {
  let nextId = nextNodeId(workflow);
  for (const node of Object.values(workflow)) {
    if (node.class_type !== "SaveImage" || !Array.isArray(node.inputs?.images)) continue;
    const nodeId = String(nextId++);
    workflow[nodeId] = {
      inputs: { images: node.inputs.images, threshold: MARK_THRESHOLD },
      class_type: REMOVE_MARKS_NODE,
      _meta: { title: TITLES.removeMarks },
    };
    node.inputs.images = [nodeId, 0];
  }
}

// The background removal model (core packs.ts BG_MODELS): Lucida, BiRefNet tuned on illustrations.
export const BACKGROUND_MODEL = "lucida.safetensors";

/** Make every SaveImage of *workflow* save its image with the background transparent, with ComfyUI's
 * own nodes: the model finds the subject (a mask, 1 = subject), inverted it is the part to clear,
 * and JoinImageWithAlpha makes it transparent (an RGBA image, which SaveImage keeps). After
 * withMarkRemoval, so the marks are filled first. */
export function withBackgroundRemoval(workflow: Workflow): void {
  let nextId = nextNodeId(workflow);
  for (const node of Object.values(workflow)) {
    if (node.class_type !== "SaveImage" || !Array.isArray(node.inputs?.images)) continue;
    const [model, remove, invert, join] = [nextId++, nextId++, nextId++, nextId++].map(String);
    const image = node.inputs.images;
    workflow[model] = { inputs: { bg_removal_name: BACKGROUND_MODEL }, class_type: "LoadBackgroundRemovalModel", _meta: { title: TITLES.backgroundModel } };
    workflow[remove] = { inputs: { bg_removal_model: [model, 0], image }, class_type: "RemoveBackground", _meta: { title: TITLES.background } };
    workflow[invert] = { inputs: { mask: [remove, 0] }, class_type: "InvertMask", _meta: { title: TITLES.backgroundAlpha } };
    workflow[join] = { inputs: { image, alpha: [invert, 0] }, class_type: "JoinImageWithAlpha", _meta: { title: TITLES.backgroundJoin } };
    node.inputs.images = [join, 0];
  }
}

/**
 * *workflow* (an edit's, built for one image) with *count* images: [workflow, per image its
 * LoadImage and scale node ids]. The first image's nodes are the ones titled cg:image… (load,
 * scale, encode, the reference nodes); each further image copies them:
 * - links between copied nodes go to the copies, links to anything else stay;
 * - a copied cg:image chain node (a reference latent) takes its outside input (the conditioning)
 *   from the previous image's matching node, and what consumed that one consumes the copy, so the
 *   images chain in order;
 * - nodes outside the group (the output size, from the first image) stay as they are.
 */
export function withImages(workflow: Workflow, count: number): [Workflow, { load: string; scale: string | null }[]] {
  const wf: Workflow = structuredClone(workflow);
  const group = Object.keys(workflow).filter((id) => workflow[id]._meta?.title?.startsWith(IMAGE_GROUP));
  const titled = (ids: Record<string, string>, title: string) => group.find((id) => workflow[id]._meta?.title === title && ids[id]) ?? null;
  const identity = Object.fromEntries(group.map((id) => [id, id]));
  const load = titled(identity, TITLES.image);
  if (!load) throw new Error(`the workflow has no node titled ${TITLES.image}`);
  const images = [{ load, scale: titled(identity, TITLES.imageScale) }];
  const copies = new Set(group);
  let prev = identity;
  for (let k = 1; k < count; k++) {
    let next = nextNodeId(wf);
    const ids = Object.fromEntries(group.map((id) => [id, String(next++)]));
    const chain = group.filter((id) => workflow[id]._meta?.title === TITLES.imageChain);
    // What consumed the previous image's chain nodes (outside every image's copies), to move over.
    const moving = chain.map((id) => [id, consumersOf(wf, [prev[id], 0]).filter(([c]) => !copies.has(c))] as const);
    for (const id of group) {
      const node = structuredClone(workflow[id]);
      for (const [key, val] of Object.entries(node.inputs)) {
        if (!Array.isArray(val) || val.length !== 2 || typeof val[0] !== "string" || !(val[0] in workflow)) continue;
        if (val[0] in ids) node.inputs[key] = [ids[val[0]], val[1]];
        else if (chain.includes(id)) node.inputs[key] = [prev[id], 0];
      }
      wf[ids[id]] = node;
      copies.add(ids[id]);
    }
    for (const [id, consumers] of moving) for (const [c, key] of consumers) wf[c].inputs[key] = [ids[id], 0];
    images.push({ load: ids[load], scale: images[0].scale && ids[images[0].scale] });
    prev = ids;
  }
  return [wf, images];
}
