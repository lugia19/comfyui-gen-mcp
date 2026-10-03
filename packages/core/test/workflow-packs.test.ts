/// <reference types="node" />
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACK_FILES } from "../packs/index.ts";
import { DEFAULT_KEEP_WARM_MINUTES, DEFAULTS, normalize, tagLoras } from "../src/config.ts";
import { builtinPacks, DEFAULT_LORA_GROUP, family, groupByTool, packLoras, prepare, select, supportsLoras, TOOLS, validate } from "../src/packs.ts";
import { describe as describeTool } from "../src/tools.ts";
import { buildPrompt, calcDimensions, injectLoras, stripLossless, withImages, type Workflow } from "../src/workflow.ts";

const smallWorkflow = (): Workflow => ({
  "1": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" }, _meta: { title: "cg:model" } },
  "2": { class_type: "KSampler", inputs: { seed: 0, model: ["1", 0], positive: ["3", 0] }, _meta: { title: "cg:seed" } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "" }, _meta: { title: "cg:prompt" } },
  "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512 }, _meta: { title: "cg:size" } },
  "5": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0] } },
});

describe("workflow", () => {
  it.each([
    ["portrait", "portrait"],
    ["portrait:lossless", "portrait"],
    ["C:/x.png:LOSSLESS", "C:/x.png"],
    ["C:/x.png", "C:/x.png"],
  ])("stripLossless(%s)", (value, rest) => {
    expect(stripLossless(value)).toBe(rest);
  });

  it("calcDimensions: named and custom", () => {
    expect(calcDimensions("square", 1_048_576)).toEqual([1024, 1024]);
    const [w, h] = calcDimensions("portrait", 1_048_576);
    expect(w % 64 === 0 && h % 64 === 0 && h > w).toBe(true);
    expect(calcDimensions("1600x900", 1_048_576)).toEqual(calcDimensions("wide", 1_048_576));
    expect(calcDimensions("nonsense", 1_048_576)).toEqual([1024, 1024]);
  });

  it("buildPrompt sets text, seeds and dimensions on a copy, finding the nodes by title", () => {
    const wf = smallWorkflow();
    const out = buildPrompt(wf, "a cat", { aspectRatio: "landscape", maxPixels: 1_048_576 });
    expect(out["3"].inputs.text).toBe("a cat");
    expect(out["2"].inputs.seed).not.toBe(0);
    expect(Number.isSafeInteger(out["2"].inputs.seed)).toBe(true);
    expect([out["4"].inputs.width, out["4"].inputs.height]).toEqual(calcDimensions("landscape", 1_048_576));
    expect(wf["3"].inputs.text).toBe(""); // the source is untouched
    // Width and height as number nodes (Flux), a noise_seed (RandomNoise).
    const flux: Workflow = {
      "1": { class_type: "CLIPTextEncode", inputs: { text: "" }, _meta: { title: "cg:prompt" } },
      "2": { class_type: "RandomNoise", inputs: { noise_seed: 0 }, _meta: { title: "cg:seed" } },
      "3": { class_type: "PrimitiveInt", inputs: { value: 1 }, _meta: { title: "cg:width" } },
      "4": { class_type: "PrimitiveInt", inputs: { value: 1 }, _meta: { title: "cg:height" } },
    };
    const f = buildPrompt(flux, "x", { aspectRatio: "tall", maxPixels: 1_048_576 });
    expect([f["3"].inputs.value, f["4"].inputs.value]).toEqual(calcDimensions("tall", 1_048_576));
    expect(f["2"].inputs.noise_seed).not.toBe(0);
    expect("seed" in f["2"].inputs).toBe(false);
    expect(() => buildPrompt({ "1": flux["2"] }, "x")).toThrow(/cg:prompt/);
  });

  it("withImages chains a second image after the first, which keeps setting the size", () => {
    const wf: Workflow = {
      "1": { class_type: "CLIPTextEncode", inputs: { text: "" }, _meta: { title: "cg:prompt" } },
      "2": { class_type: "LoadImage", inputs: { image: "" }, _meta: { title: "cg:image" } },
      "3": { class_type: "ImageScaleToTotalPixels", inputs: { image: ["2", 0], megapixels: 1 }, _meta: { title: "cg:image scale" } },
      "4": { class_type: "VAEEncode", inputs: { pixels: ["3", 0], vae: ["9", 0] }, _meta: { title: "cg:image encode" } },
      "5": { class_type: "ReferenceLatent", inputs: { conditioning: ["1", 0], latent: ["4", 0] }, _meta: { title: "cg:image chain" } },
      "6": { class_type: "GetImageSize", inputs: { image: ["3", 0] } },
      "7": { class_type: "CFGGuider", inputs: { positive: ["5", 0] } },
      "9": { class_type: "VAELoader", inputs: {} },
    };
    const [one, first] = withImages(wf, 1);
    expect(one).toEqual(wf);
    expect(first).toEqual([{ load: "2", scale: "3" }]);
    const [two, images] = withImages(wf, 2);
    expect(images).toEqual([{ load: "2", scale: "3" }, { load: "10", scale: "11" }]);
    expect(two["11"].inputs.image).toEqual(["10", 0]); // the copy's own chain
    expect(two["12"].inputs).toEqual({ pixels: ["11", 0], vae: ["9", 0] }); // shared nodes stay shared
    expect(two["13"].inputs).toEqual({ conditioning: ["5", 0], latent: ["12", 0] }); // after the first image
    expect(two["7"].inputs.positive).toEqual(["13", 0]); // the guider takes the end of the chain
    expect(two["6"].inputs.image).toEqual(["3", 0]); // the size still follows the first image
    expect(wf["7"].inputs.positive).toEqual(["5", 0]); // the source is untouched
  });

  it("injectLoras chains and rewires every model consumer", () => {
    const wf = smallWorkflow();
    const toggles = injectLoras(wf, [{ name: "a.safetensors", strength: 0.5 }, { name: "b.safetensors", trigger: "@b" }]);
    const chain = Object.keys(wf).filter((id) => wf[id].class_type === "LoraLoaderModelOnly");
    expect(chain).toEqual(["6", "7"]);
    expect(wf["6"].inputs.model).toEqual(["1", 0]);
    expect(wf["7"].inputs.model).toEqual(["6", 0]);
    expect(wf["2"].inputs.model).toEqual(["7", 0]);
    expect(wf["5"].inputs.model).toEqual(["7", 0]);
    expect(toggles).toEqual([{ node_id: "7", trigger: "@b", strength: 1.0 }]);
  });

  it("LoRA toggles follow the prompt: one not called for is taken out of the chain", () => {
    const wf = smallWorkflow();
    const toggles = injectLoras(wf, [{ name: "a.safetensors" }, { name: "b.safetensors", trigger: "@B", strength: 0.7 }, { name: "c.safetensors", trigger: "@c" }]);
    const on = buildPrompt(wf, "art by @b", { loraToggles: toggles });
    expect(on["7"].inputs.strength_model).toBe(0.7);
    expect("8" in on).toBe(false); // @c is not in the prompt: its file need not exist
    expect(on["2"].inputs.model).toEqual(["7", 0]);
    const off = buildPrompt(wf, "no trigger", { loraToggles: toggles });
    expect(["7", "8"].some((id) => id in off)).toBe(false);
    expect(off["2"].inputs.model).toEqual(["6", 0]); // straight from the always-on LoRA
    expect(off["5"].inputs.model).toEqual(["6", 0]);
    expect(wf["8"]).toBeDefined(); // the pack's workflow is untouched
  });

  it("injectLoras without a cg:model node throws", () => {
    expect(() => injectLoras({ "1": { class_type: "UNETLoader", inputs: {} } }, [{ name: "a" }])).toThrow(/cg:model/);
  });
});

describe("packs and config", () => {
  const builtin = builtinPacks();

  it("every pack JSON file is listed, in file-name order", () => {
    const dir = new URL("../packs/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "tools.json").sort();
    expect(PACK_FILES.map(([f]) => f)).toEqual(files);
  });

  it("every model file a workflow names is in its pack's models, to be downloaded", () => {
    for (const pack of builtin) {
      const listed = new Set(pack.models.map((m) => m.filename));
      const named = Object.values<any>(pack.workflow).flatMap((n) =>
        Object.values(n.inputs).filter((v): v is string => typeof v === "string" && /\.(safetensors|gguf|pt|pth|ckpt|bin)$/i.test(v)));
      expect(named.length).toBeGreaterThan(0);
      for (const file of named) expect(listed.has(file), `${pack.name}: ${file} is not in its models`).toBe(true);
    }
  });

  it("builtin packs load", () => {
    const names = new Set(builtin.map((p) => p.name));
    for (const n of ["anima", "anima_turbo", "flux2klein", "flux2klein_edit", "z_image_turbo"]) expect(names.has(n)).toBe(true);
    for (const p of builtin) expect(JSON.stringify(p.workflow)).not.toContain("comfy-dxt");
  });

  it("validate wants the titled nodes: one prompt, a seed, a model loader for LoRAs", () => {
    const anima = builtinPacks().find((p) => p.name === "anima")!;
    const retitled = (from: string, to: string) => {
      const wf = structuredClone(anima.workflow);
      for (const n of Object.values<any>(wf)) if (n._meta?.title === from) n._meta.title = to;
      return { ...anima, workflow: wf };
    };
    expect(() => validate(retitled("cg:prompt", "Prompt"))).toThrow(/cg:prompt/);
    expect(() => validate(retitled("cg:seed", "KSampler"))).toThrow(/cg:seed/);
    expect(() => validate(retitled("cg:model", "Loader"))).toThrow(/cg:model/);
    expect(() => validate({ ...retitled("cg:model", "Loader"), lora_group: undefined })).not.toThrow();
  });

  it("validate names missing fields", () => {
    expect(() => validate({ name: "x" })).toThrow(/missing required fields/);
  });

  it("select prefers configured, then default, then first", () => {
    const groups = groupByTool(builtin);
    const byTool = Object.fromEntries(select(groups, {}).map((p) => [p.tool_name, p.name]));
    for (const p of builtin.filter((x) => x.is_default)) expect(byTool[p.tool_name]).toBe(p.name);
    const other = groups.generate_illustrated_image.find((p) => p.name !== byTool.generate_illustrated_image)!.name;
    expect(select(groups, { generate_illustrated_image: other }).map((p) => p.name)).toContain(other);
  });

  it("prepare splices LoRAs only for Anima", () => {
    const anima = builtin.find((p) => p.name === "anima")!;
    const klein = builtin.find((p) => p.name === "flux2klein")!;
    const cfg = normalize({ pack_loras: { anima: [{ name: "style.safetensors", trigger: "@style" }], flux2klein: [{ name: "x.safetensors" }] } });
    const prepared = prepare(anima, cfg);
    expect(Object.values<any>(prepared.workflow).some((n) => n.class_type === "LoraLoaderModelOnly")).toBe(true);
    expect(prepared.lora_toggles[0].trigger).toBe("@style");
    expect(Object.values<any>(prepare(klein, cfg).workflow).some((n) => n.class_type === "LoraLoaderModelOnly")).toBe(false);
    expect("lora_toggles" in anima).toBe(false); // the builtin pack is untouched
  });

  it("prepare clamps max_pixels to the limit", () => {
    const pack = builtin.find((p) => p.max_pixels_limit)!;
    const key = family(pack);
    expect(prepare(pack, normalize({ pack_settings: { [key]: { max_pixels: pack.max_pixels_limit * 10 } } })).max_pixels).toBe(pack.max_pixels_limit);
    expect(prepare(pack, normalize({ pack_settings: { [key]: { max_pixels: "big" } } })).max_pixels).toBe(pack.max_pixels);
  });

  it("normalize fills defaults and keeps unknown keys", () => {
    const cfg = normalize({ keep_warm_minutes: 0, pack_loras: "junk", comfyui_url: "http://x" });
    expect(cfg.keep_warm_minutes).toBe(DEFAULT_KEEP_WARM_MINUTES);
    expect(cfg.pack_loras).toEqual({});
    expect(cfg.comfyui_url).toBe("http://x");
    expect(normalize(null)).toEqual(DEFAULTS);
    const raw = { pack_settings: { anima: { artist_list: "@a" } } };
    const out = normalize(raw);
    out.pack_settings.anima.artist_list = "changed";
    expect(raw.pack_settings.anima.artist_list).toBe("@a"); // a deep copy
    // A removed feature's setting is dropped, so the next save forgets it.
    expect("custom_workflow" in normalize({ custom_workflow: { workflow: { "1": {} } } })).toBe(false);
  });

  it("normalize cleans LoRA entries and caps keep-warm", () => {
    const cfg = normalize({
      keep_warm_minutes: 500,
      pc_keep_warm_minutes: 45,
      pack_loras: {
        anima: ["bare.safetensors", { name: " a.safetensors ", strength: 9, trigger: " @x ", hidden: 1 }, { name: "" }, 7,
          { name: "b.safetensors", strength: "0.5" }],
        other: "junk",
      },
    });
    expect(cfg.keep_warm_minutes).toBe(60);
    expect(normalize({ keep_warm_minutes: "x" }).keep_warm_minutes).toBe(DEFAULT_KEEP_WARM_MINUTES);
    expect("pc_keep_warm_minutes" in cfg).toBe(false); // keep-warm is per GPU on a Worker now
    expect(cfg.pack_loras).toEqual({
      anima: [
        { name: "bare.safetensors", strength: 1, trigger: "", hidden: false, enabled: true },
        { name: "a.safetensors", strength: 5, trigger: "@x", hidden: false, enabled: true },
        { name: "b.safetensors", strength: 0.5, trigger: "", hidden: false, enabled: true },
      ],
      other: [],
    });
    // A LoRA is in one group, and on or off there; a name already in an earlier group is dropped.
    const two = normalize({ pack_loras: { anima: [{ name: "x.safetensors", enabled: false }], klein: ["x.safetensors", "y.safetensors"] } });
    expect(two.pack_loras.anima).toEqual([{ name: "x.safetensors", strength: 1, trigger: "", hidden: false, enabled: false }]);
    expect(two.pack_loras.klein.map((e: any) => e.name)).toEqual(["y.safetensors"]);
  });

  it("a tool is described once: its routing line, the pack's guide (else the tool's), the shared tail", () => {
    for (const pack of builtin.filter((p) => p.tool_name !== "edit_image")) {
      const tool = TOOLS[pack.tool_name];
      const desc = describeTool(pack, normalize({}));
      expect(desc.startsWith(tool.description + "\n" + (pack.prompt_guide ?? tool.default_guide)!.split("{")[0])).toBe(true);
      expect(desc).toMatch(/aspect_ratio parameter[\s\S]*may not appear inline[\s\S]*image\.$/);
      expect(desc).not.toMatch(/\{artist_list\}|\{lora_triggers\}/);
    }
    for (const tool of new Set(builtin.map((p) => p.tool_name))) expect(TOOLS[tool]?.title).toBeTruthy();
    expect(() => validate({ ...builtin[0], tool_name: "nope" })).toThrow(/unknown tool/);
  });

  it("only the Anima family takes LoRAs", () => {
    expect(builtinPacks().filter(supportsLoras).map((p) => p.name).sort()).toEqual(["anima", "anima_turbo"]);
    // A family is the key users' settings are stored under: these must never change.
    expect(Object.fromEntries(builtinPacks().map((p) => [p.name, family(p)]))).toEqual({
      anima: "anima", anima_turbo: "anima", flux2klein: "flux2klein", flux2klein_9b: "flux2klein_9b",
      flux2klein_9b_edit: "flux2klein_9b_edit", flux2klein_edit: "flux2klein_edit", z_image_turbo: "z_image_turbo",
    });
    // The Anima packs' LoRA group is the key their LoRA lists were stored under before groups.
    expect(builtinPacks().filter(supportsLoras).map((p) => p.lora_group)).toEqual(["anima", "anima"]);
    expect(DEFAULT_LORA_GROUP).toBe("anima");
    expect(() => validate({ ...builtinPacks()[0], lora_group: "nope" })).toThrow(/unknown LoRA group/);
  });

  it("a LoRA without a group joins one, switched off; a switched-off LoRA is neither loaded nor advertised", () => {
    const on = { name: "on.safetensors", strength: 1, trigger: "@on", hidden: false, enabled: true };
    const lists = { anima: [on], klein: [{ ...on, name: "k.safetensors" }] };
    const tagged = tagLoras(lists, ["on.safetensors", "k.safetensors", "new.safetensors", "new.safetensors"], "anima")!;
    expect(tagged.anima).toEqual([on, { name: "new.safetensors", strength: 1, trigger: "", hidden: false, enabled: false }]);
    expect(tagged.klein).toBe(lists.klein); // a LoRA already in a group stays there
    expect(tagLoras(tagged, ["new.safetensors", "on.safetensors"], "anima")).toBeNull(); // nothing to do

    const anima = builtin.find((p) => p.name === "anima")!;
    const cfg = normalize({ pack_loras: { anima: [on, { name: "off.safetensors", trigger: "@off", enabled: false }] } });
    expect(packLoras(anima, cfg).map((e) => e.name)).toEqual(["on.safetensors"]);
    const loaders = Object.values<any>(prepare(anima, cfg).workflow).filter((n) => n.class_type === "LoraLoaderModelOnly");
    expect(loaders.map((n) => n.inputs.lora_name)).toEqual(["on.safetensors"]);
    const desc = describeTool(anima, cfg);
    expect(desc).toContain("@on");
    expect(desc).not.toContain("@off");
  });
});
