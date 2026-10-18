// Which model family a LoRA was made for, from its safetensors header (the settings page reads the
// header of a file before uploading it, and files the LoRA under that family's group). The header
// is a little-endian u64 length, then that much JSON: {tensor name: {dtype, shape, data_offsets},
// __metadata__: {string: string}}.
//
// The trainer's metadata says it when present (ss_base_model_version: anima, zimage,
// flux2_klein_4b, flux2_klein_9b; modelspec.architecture: anima-preview/lora). Otherwise the tensor
// names give the layout and the most common input width the model (2026-10-18, real LoRAs from
// Hugging Face):
//   anima   blocks.N.cross_attn (kohya lora_unet_blocks_N_cross_attn), 2048
//   zimage  layers.N.attention, 3840 (Lumina 2 has the same names at 2304)
//   krea2   blocks.N.attn.wq/wk/gate, or text_fusion (diffusers), 6144
//   qwenimage21  transformer_blocks 0-31 with no single-stream blocks, 4096 (Qwen Image v1 has 60
//           blocks at 3072, with add_q_proj and txt_mlp)
//   flux2   double_blocks / single_blocks (diffusers transformer_blocks), 3072 for Klein 4B and 4096
//           for 9B; its MLPs are 3x the width where Flux 1's are 4x (also 3072 wide), and it has no
//           per-block modulation (img_mod)
// The groups (packs/tools.json lora_groups) say which base models and which layout and width are
// theirs, so a new model family needs only its entry, unless its layout is new.

/** What a LoRA group recognises (a lora_groups entry of packs/tools.json). */
export type LoraGroupMatch = { id: string; base_models?: string[]; match?: { layout: string; width: number } };

/** *group*: the group the LoRA belongs to, or null. *foreign*: made for a model none of the groups
 * is (SDXL, Flux 1, Krea…), so it won't work here. *trigger*: the trainer's trigger phrase, if any. */
export type LoraFamily = { group: string | null; foreign: boolean; base: string | null; trigger: string | null };

/** The header's length, from the file's first 8 bytes; null when it can't be a safetensors file. */
export function loraHeaderLength(first8: Uint8Array): number | null {
  if (first8.length < 8) return null;
  const n = new DataView(first8.buffer, first8.byteOffset, 8).getBigUint64(0, true);
  return n > 1n && n < 100_000_000n ? Number(n) : null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
// A LoRA's down weight in any trainer's naming (kohya, PEFT, diffusers, DiffSynth): its input width.
const DOWN = /(lora_down|lora_A|lora\.down)(\.default)?(\.weight)?$/;
/** Whether a trainer's base model name is *b* or a variant of it (krea2 for Krea-2, anima-preview for
 * anima), not another version (qwen_image_2512 is no qwen_image_2). */
const sameBase = (base: string, b: string) => {
  const [x, y] = [norm(base), norm(b)];
  return x === y || (x.startsWith(y) && !/^\d/.test(x.slice(y.length)));
};

/** The layout of a LoRA's tensor names, its most common input width, and what tells Flux 1 from 2. */
function shape(tensors: Record<string, any>): { layout: string | null; width: number | null } {
  const names = Object.keys(tensors);
  const has = (re: RegExp) => names.some((n) => re.test(n));
  const maxIndex = (block: string) => {
    let max = -1;
    const re = new RegExp(`(?:^|[._])${block}[._](\\d+)[._]`);
    for (const n of names) {
      const m = re.exec(n);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  };
  const widths = new Map<number, number>();
  for (const [n, t] of Object.entries(tensors)) {
    if (DOWN.test(n) && Array.isArray(t?.shape) && t.shape.length >= 2) widths.set(t.shape[1], (widths.get(t.shape[1]) ?? 0) + 1);
  }
  const width = [...widths].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const inWidth = (re: RegExp) =>
    Object.entries(tensors).find(([n, t]) => re.test(n) && DOWN.test(n) && Array.isArray(t?.shape))?.[1].shape[1] as number | undefined;

  if (has(/(?:^|[._])blocks[._]\d+[._]cross_attn/)) return { layout: "anima", width };
  if (has(/text_fusion|txtfusion|(?:^|[._])blocks[._]\d+[._]attn[._](wq|wk|wv|wo|gate)[._]/)) return { layout: "krea2", width };
  if (has(/(?:^|[._])layers[._]\d+[._]attention/)) return { layout: "zimage", width };
  // Qwen Image: one stream of transformer_blocks. 2.1 has 32 of them; v1 has 60, and add_q_proj and
  // txt_mlp. Flux 2's diffusers LoRAs share the names, but have 8 double blocks (and single ones).
  const single = has(/(?:^|[._])(single_blocks|single_transformer_blocks)[._]\d+/);
  if (!single && has(/(?:^|[._])transformer_blocks[._]\d+[._]/)) {
    const v1 = has(/add_q_proj|txt_mlp/) || maxIndex("transformer_blocks") > 31;
    if (v1) return { layout: "qwenimage1", width };
    if (has(/img_mlp|(?:^|[._])modulation[._]/) || maxIndex("transformer_blocks") > 7) return { layout: "qwenimage21", width };
  }
  const flux = has(/(?:^|[._])(double_blocks|single_blocks|single_transformer_blocks)[._]\d+/);
  const diffusers = !flux && has(/(?:^|[._])transformer_blocks[._]\d+[._]attn[._]to_[qkv]/);
  if (flux || diffusers) {
    // Flux 1: per-block modulation, 19 double and 38 single blocks, MLPs 4x the width.
    const flux1 =
      // (Flux 2's modulation is shared: double_stream_modulation_img, not in a block)
      has(/(?:double_blocks|single_blocks|transformer_blocks)[._]\d+[._](img_mod|txt_mod|modulation|norm1[._]linear)/) ||
      maxIndex(flux ? "double_blocks" : "transformer_blocks") > 7 ||
      maxIndex(flux ? "single_blocks" : "single_transformer_blocks") > 23 ||
      (width !== null && inWidth(/img_mlp[._]2/) === 4 * width) ||
      (width !== null && inWidth(/single_blocks[._]\d+[._]linear2/) === 5 * width);
    return { layout: flux1 ? "flux1" : "flux2", width };
  }
  if (has(/(?:^|[._])(input_blocks|down_blocks|output_blocks|up_blocks)[._]\d+/)) return { layout: "unet", width }; // SD 1.5, SDXL
  return { layout: null, width };
}

/** The family of the LoRA whose header (parsed JSON) this is, among *groups*. */
export function detectLora(header: Record<string, any>, groups: LoraGroupMatch[]): LoraFamily {
  const meta: Record<string, string> = header.__metadata__ ?? {};
  const trigger = String(meta["modelspec.trigger_phrase"] ?? "").trim() || null;
  const named = [
    meta.ss_base_model_version,
    meta["modelspec.architecture"]?.replace(/\/.*$/, ""), // "Krea-2/lora"
    meta.base_model?.replace(/^.*\//, ""), // "Qwen/Qwen-Image-2.1", "fal/krea-2"
  ].filter((s) => s && norm(s));
  for (const base of named) {
    const g = groups.find((g) => (g.base_models ?? []).some((b) => sameBase(base, b)));
    if (g) return { group: g.id, foreign: false, base, trigger };
  }
  const { __metadata__, ...tensors } = header;
  const { layout, width } = shape(tensors);
  const g = groups.find((g) => g.match && g.match.layout === layout && g.match.width === width);
  if (g) return { group: g.id, foreign: false, base: named[0] ?? null, trigger };
  // A named base model none of ours is, or a layout we know at a width none of ours has.
  const foreign = named.length > 0 || (layout !== null && (layout === "flux1" || layout === "unet" || width !== null));
  return { group: null, foreign, base: named[0] ?? layout, trigger };
}
