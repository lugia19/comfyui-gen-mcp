import { describe, expect, it } from "vitest";
import { detectLora, loraHeaderLength } from "../src/lora-detect.ts";
import { LORA_GROUPS, settingsMetadata, builtinPacks } from "../src/packs.ts";
import { describe as describeTool } from "../src/tools.ts";
import { normalize } from "../src/config.ts";

const groups = Object.values(LORA_GROUPS);

/** A header shaped like a real LoRA's (2026-10-18, from Hugging Face): *pairs* of [name, input
 * width] become lora_A (or lora_down) tensors, blocks 0..n-1 of each. */
function lora(pairs: [string, number, number?][], meta: Record<string, string> = {}, down = "lora_A") {
  const up = { lora_A: "lora_B", lora_down: "lora_up", "lora_A.default": "lora_B.default", "lora.down": "lora.up" }[down];
  const h: Record<string, any> = { __metadata__: meta };
  for (const [name, width, blocks = 1] of pairs) {
    for (let i = 0; i < blocks; i++) {
      const n = name.replace("N", String(i));
      h[`${n}.${down}.weight`] = { dtype: "BF16", shape: [16, width], data_offsets: [0, 1] };
      h[`${n}.${up}.weight`] = { dtype: "BF16", shape: [width, 16], data_offsets: [0, 1] };
    }
  }
  return h;
}

const klein = (w: number, doubles: number, singles: number, mlp = 3) =>
  lora([
    ["diffusion_model.double_blocks.N.img_attn.qkv", w, doubles], ["diffusion_model.double_blocks.N.img_attn.proj", w, doubles],
    ["diffusion_model.double_blocks.N.img_mlp.0", w, doubles], ["diffusion_model.double_blocks.N.img_mlp.2", mlp * w, doubles],
    ["diffusion_model.single_blocks.N.linear1", w, singles], ["diffusion_model.single_blocks.N.linear2", (mlp + 1) * w, singles],
  ]);
const zimage = (w = 3840) =>
  lora([["diffusion_model.layers.N.attention.to_k", w, 30], ["diffusion_model.layers.N.attention.to_q", w, 30], ["diffusion_model.layers.N.feed_forward.w2", 10240, 30]]);
const anima = () =>
  lora([["lora_unet_blocks_N_cross_attn_k_proj", 1024, 28], ["lora_unet_blocks_N_self_attn_q_proj", 2048, 28], ["lora_unet_blocks_N_mlp_layer1", 2048, 28]], {}, "lora_down");

const family = (h: Record<string, any>) => detectLora(h, groups);

describe("which model family a LoRA is for", () => {
  it("by the trainer's metadata first", () => {
    expect(family(lora([], { ss_base_model_version: "zimage" })).group).toBe("zimage");
    expect(family(lora([], { ss_base_model_version: "flux2_klein_9b" })).group).toBe("klein9b");
    expect(family(lora([], { "modelspec.architecture": "anima-preview/lora" })).group).toBe("anima");
    expect(family(lora([], { ss_base_model_version: "sdxl_base_v1-0" }))).toMatchObject({ group: null, foreign: true });
  });

  it("else by its tensors: layout and width", () => {
    expect(family(klein(3072, 5, 20)).group).toBe("klein4b");
    expect(family(klein(4096, 8, 24)).group).toBe("klein9b");
    // Flux 2's shared modulation (fal/flux-klein-9b-virtual-tryon-lora) is no Flux 1 per-block one
    expect(family({ ...klein(4096, 8, 24), ...lora([["diffusion_model.double_stream_modulation_img.lin", 4096]]) }).group).toBe("klein9b");
    expect(family({ ...klein(3072, 5, 20), ...lora([["diffusion_model.double_blocks.N.img_mod.lin", 3072, 5]]) }).foreign).toBe(true);
    expect(family(zimage()).group).toBe("zimage");
    expect(family(anima()).group).toBe("anima");
    // diffusers names, attention only (linoyts/Flux2-Klein-Delight-LoRA)
    expect(family(lora([["transformer.transformer_blocks.N.attn.to_k", 4096, 8], ["transformer.transformer_blocks.N.attn.to_q", 4096, 8]])).group).toBe("klein9b");
  });

  it("refuses look-alikes: Flux 1 (also 3072 wide), Lumina 2, SDXL", () => {
    expect(family(klein(3072, 19, 38, 4))).toMatchObject({ group: null, foreign: true }); // Flux 1: 19 + 38 blocks, MLPs 4x
    expect(family(klein(3072, 5, 20, 4))).toMatchObject({ group: null, foreign: true }); // MLPs 4x even on few blocks
    expect(family(zimage(2304))).toMatchObject({ group: null, foreign: true }); // Lumina 2's names, its width
    // nphSi/Z-Image-Lora's file says Krea-2, whatever its name
    expect(family(lora([["lora_unet_down_blocks_N_attentions_0_proj_in", 320, 2]], {}, "lora_down"))).toMatchObject({ group: null, foreign: true });
    expect(family(lora([["something_else.N.proj", 512, 2]]))).toMatchObject({ group: null, foreign: false }); // can't tell
  });

  it("Krea 2 and Qwen Image 2.1, in every trainer's naming (real LoRAs, 2026-10-18)", () => {
    // Krea 2: blocks.N.attn.wq/wk/gate (ComfyUI, ai-toolkit, kohya lora_unet_, PEFT base_model.model.) or diffusers with text_fusion
    for (const prefix of ["diffusion_model.blocks.N.attn", "base_model.model.blocks.N.attn"]) {
      expect(family(lora([[`${prefix}.wq`, 6144, 28], [`${prefix}.gate`, 6144, 28]])).group, prefix).toBe("krea2");
    }
    expect(family(lora([["lora_unet_blocks_N_attn_wk", 6144, 28]], {}, "lora_down")).group).toBe("krea2");
    expect(family(lora([["transformer.transformer_blocks.N.attn.to_q", 6144, 28], ["transformer.text_fusion.layerwise_blocks.N.attn.to_q", 2560, 2]])).group).toBe("krea2");
    // nphSi/Z-Image-Lora says Krea-2 in its file, whatever its name
    expect(family(lora([["diffusion_model.blocks.N.attn.gate", 6144, 28]], { "modelspec.architecture": "Krea-2/lora" })).group).toBe("krea2");
    // Qwen Image 2.1: transformer_blocks 0-31 at 4096 (DiffSynth's lora_A.default, lightx2v's lora.down)
    expect(family(lora([["transformer_blocks.N.attn.to_q", 4096, 32], ["transformer_blocks.N.img_mlp.gate_up", 4096, 32]], {}, "lora_A.default")).group).toBe("qwenimage21");
    expect(family(lora([["transformer.transformer_blocks.N.attn.to_q", 4096, 32]], {}, "lora.down")).group).toBe("qwenimage21");
    expect(family(lora([], { base_model: "Qwen/Qwen-Image-2.1" })).group).toBe("qwenimage21");
    expect(family(lora([], { base_model: "fal/krea-2" })).group).toBe("krea2");
  });

  it("refuses Qwen Image v1 (60 blocks at 3072) and other versions by name", () => {
    expect(family(lora([["transformer.transformer_blocks.N.attn.to_q", 3072, 60]], {}, "lora.down"))).toMatchObject({ group: null, foreign: true });
    expect(family(lora([["transformer_blocks.N.attn.add_q_proj", 3072, 60]], {}, "lora_down"))).toMatchObject({ group: null, foreign: true });
    expect(family(lora([], { ss_base_model_version: "qwen_image_2512" }))).toMatchObject({ group: null, foreign: true });
    // Klein 9B's diffusers LoRAs share Qwen's names: 8 blocks and no img_mlp keep them Klein
    expect(family(lora([["transformer.transformer_blocks.N.attn.to_q", 4096, 8]])).group).toBe("klein9b");
  });

  it("keeps the trainer's trigger phrase", () => {
    expect(family(lora([], { ss_base_model_version: "zimage", "modelspec.trigger_phrase": " pxl art " })).trigger).toBe("pxl art");
  });

  it("reads the header's length from the first 8 bytes", () => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, 1234n, true);
    expect(loraHeaderLength(b)).toBe(1234);
    expect(loraHeaderLength(new Uint8Array(4))).toBeNull();
    expect(loraHeaderLength(new TextEncoder().encode("<html><b"))).toBeNull(); // not a safetensors file
  });
});

describe("LoRA groups", () => {
  it("each has a title and is recognisable; the settings pages get them in order", () => {
    expect(settingsMetadata(builtinPacks()).lora_groups.map((g) => [g.id, g.title])).toEqual([
      ["anima", "Anima"], ["zimage", "Z-Image Turbo"], ["klein4b", "Flux 2 Klein 4B"], ["klein9b", "Flux 2 Klein 9B"],
      ["qwenimage21", "Qwen Image 2.1"], ["krea2", "Krea 2"],
    ]);
    for (const g of groups) expect(g.base_models?.length && g.match, g.id).toBeTruthy();
  });

  it("a tool lists its family's triggers, described as that family's are", () => {
    const on = (name: string, trigger: string) => ({ name, strength: 1, trigger, hidden: false, enabled: true });
    const cfg = normalize({ pack_loras: { anima: [on("a.safetensors", "@huke")], zimage: [on("z.safetensors", "pxlart")] } });
    const pack = (n: string) => builtinPacks().find((p) => p.name === n)!;
    expect(describeTool(pack("anima_turbo"), cfg)).toContain("prompt (these can be either artist styles, usually prefixed with @, or concept tags). These triggers must be used verbatim: @huke.");
    const z = describeTool(pack("z_image_turbo"), cfg);
    expect(z).toContain("applied to the prompt. These triggers must be used verbatim: pxlart.");
    expect(z).not.toContain("@huke");
    expect(describeTool(pack("flux2klein"), cfg)).not.toContain("trigger words");
  });
});
