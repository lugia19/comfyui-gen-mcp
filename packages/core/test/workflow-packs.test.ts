/// <reference types="node" />
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACK_FILES } from "../packs/index.ts";
import { DEFAULT_KEEP_WARM_MINUTES, DEFAULTS, normalize, tagLoras } from "../src/config.ts";
import { BG_MODELS, builtinPacks, canRedraw, DEFAULT_LORA_GROUP, FACE_MODELS, MARK_MODELS, redrawPack, wantedModelSets, family, groupByTool, packFor, packLoras, prepare, select, supportsLoras, TOOLS, validate, withFamilies } from "../src/packs.ts";
import { describe as describeTool } from "../src/tools.ts";
import { BACKGROUND_MODEL, buildPrompt, calcDimensions, injectLoras, redrawWorkflow, withBackgroundRemoval, REDRAW_PASTE_NODE, REDRAW_REGION_NODE, REMOVE_MARKS_NODE, withImages, type Workflow } from "../src/workflow.ts";

const smallWorkflow = (): Workflow => ({
  "1": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" }, _meta: { title: "cg:model" } },
  "2": { class_type: "KSampler", inputs: { seed: 0, model: ["1", 0], positive: ["3", 0] }, _meta: { title: "cg:seed" } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "" }, _meta: { title: "cg:prompt" } },
  "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512 }, _meta: { title: "cg:size" } },
  "5": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0] } },
});

describe("workflow", () => {
  it("calcDimensions: named and custom", () => {
    expect(calcDimensions("square", 1_048_576)).toEqual([1024, 1024]);
    const [w, h] = calcDimensions("portrait", 1_048_576);
    expect(w % 64 === 0 && h % 64 === 0 && h > w).toBe(true);
    // "WxH": that size when it fits the budget, rounded to multiples of 64.
    const ANIMA = 2_359_296;
    expect(calcDimensions("832x1216", ANIMA)).toEqual([832, 1216]);
    expect(calcDimensions("1344x768", ANIMA)).toEqual([1344, 768]);
    expect(calcDimensions("830x1210", ANIMA)).toEqual([832, 1216]);
    // Over the budget, or too small to be a size, it is only the shape.
    expect(calcDimensions("1600x900", 1_048_576)).toEqual(calcDimensions("wide", 1_048_576));
    expect(calcDimensions("16x9", 1_048_576)).toEqual(calcDimensions("wide", 1_048_576));
    expect(calcDimensions("3x4", ANIMA)).toEqual(calcDimensions("portrait", ANIMA));
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

  it("a negative replaces the cg:negative node's text; blank keeps the pack's own", () => {
    const anima = builtinPacks().find((p) => p.name === "anima")!;
    const own = anima.workflow["12"].inputs.text;
    expect(anima.workflow["12"]._meta.title).toBe("cg:negative");
    expect(buildPrompt(anima.workflow, "x", { negative: " lowres, extra fingers " })["12"].inputs.text).toBe("lowres, extra fingers");
    expect(buildPrompt(anima.workflow, "x", { negative: "  " })["12"].inputs.text).toBe(own);
    expect(buildPrompt(anima.workflow, "x")["12"].inputs.text).toBe(own);
    // A pack without the node ignores it.
    const flux = builtinPacks().find((p) => p.name === "flux2klein")!;
    const strip = (wf: Workflow) => JSON.stringify(Object.values(wf).map((n) => n.inputs.text));
    expect(strip(buildPrompt(flux.workflow, "x", { negative: "blurry", rng: () => 1 }))).toBe(strip(buildPrompt(flux.workflow, "x", { rng: () => 1 })));
  });

  it("each call saves under its own name, in every pack (two ComfyUIs on one Volume can't overwrite)", () => {
    for (const pack of builtinPacks()) {
      const prefixes = (wf: Workflow) => Object.values(wf).filter((n) => "filename_prefix" in n.inputs).map((n) => n.inputs.filename_prefix);
      expect(prefixes(pack.workflow).length, pack.name).toBeGreaterThan(0);
      const [a, b] = [buildPrompt(pack.workflow, "x"), buildPrompt(pack.workflow, "x")].map(prefixes);
      expect(a[0], pack.name).toMatch(/^comfy-gen\/[0-9a-f]{12}$/);
      expect(a[0]).not.toBe(b[0]);
      expect(prefixes(pack.workflow)).toEqual(["comfy-gen"]); // the pack itself is untouched
    }
    expect(Object.values(buildPrompt(smallWorkflow(), "x", { outputName: "comfy-gen/t" })).some((n) => "filename_prefix" in n.inputs)).toBe(false);
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

  it("a family downloads whole: each selected pack brings the rest of its family", () => {
    const byName = (n: string) => builtin.find((p) => p.name === n)!;
    const names = (ps: { name: string }[]) => ps.map((p) => p.name);
    expect(names(withFamilies([byName("anima"), byName("z_image_turbo")], builtin))).toEqual(["anima", "anima_turbo", "z_image_turbo"]);
    expect(names(withFamilies([byName("flux2klein")], builtin))).toEqual(["flux2klein"]);
    expect(packFor(builtin, byName("anima"), undefined)).toBe(byName("anima"));
    expect(packFor(builtin, byName("anima"), "anima_turbo")).toBe(byName("anima_turbo"));
    expect(packFor(builtin, byName("z_image_turbo"), "anima")).toBe('Unknown model "anima" for generate_realistic_image. Valid models: flux2klein, flux2klein_9b, z_image_turbo.');
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
    const cfg = normalize({ keep_warm_minutes: 0, pack_loras: "junk", someday: "kept" });
    expect(cfg.keep_warm_minutes).toBe(DEFAULT_KEEP_WARM_MINUTES);
    expect(cfg.pack_loras).toEqual({});
    expect(cfg.someday).toBe("kept");
    expect(normalize(null)).toEqual(DEFAULTS);
    const raw = { pack_settings: { anima: { artist_list: "@a" } } };
    const out = normalize(raw);
    out.pack_settings.anima.artist_list = "changed";
    expect(raw.pack_settings.anima.artist_list).toBe("@a"); // a deep copy
  });

  it("signature and watermark removal is on unless switched off", () => {
    expect(normalize({}).remove_marks).toBe(true);
    expect(normalize({ remove_marks: false }).remove_marks).toBe(false);
    expect(normalize({ remove_marks: "no" }).remove_marks).toBe(true);
  });

  it("with removal, every pack's images pass through our node on the way to being saved", () => {
    for (const pack of builtin) {
      const plain = prepare(pack, normalize({}));
      expect(JSON.stringify(plain.workflow)).not.toContain(REMOVE_MARKS_NODE);
      const wf = prepare(pack, normalize({}), { removeMarks: true }).workflow;
      const saves = Object.values<any>(wf).filter((n) => n.class_type === "SaveImage");
      expect(saves.length).toBe(1);
      const [id, out] = saves[0].inputs.images;
      expect([wf[id].class_type, wf[id]._meta.title, out]).toEqual([REMOVE_MARKS_NODE, "cg:remove marks", 0]);
      const before = Object.values<any>(pack.workflow).find((n) => n.class_type === "SaveImage").inputs.images;
      expect(wf[id].inputs.images).toEqual(before); // the decoded image, as the save had it
      expect(saves[0].inputs.filename_prefix).toBeDefined(); // the save is still the one buildPrompt names
    }
    expect(MARK_MODELS.models.map((m) => [m.subfolder, m.filename])).toEqual([["comfy_gen", "mimilens_y26l.pt"], ["comfy_gen", "big-lama.pt"]]);
  });

  it("with background removal, the save gets an RGBA image: the marks cleaned first, then the background", () => {
    for (const pack of builtin) {
      const wf = prepare(pack, normalize({}), { removeMarks: true, removeBackground: true }).workflow;
      const save = Object.values<any>(wf).find((n) => n.class_type === "SaveImage");
      const node = (ref: [string, number]) => wf[ref[0]];
      const join = node(save.inputs.images);
      expect(join.class_type).toBe("JoinImageWithAlpha");
      const marks = node(join.inputs.image);
      expect(marks.class_type).toBe(REMOVE_MARKS_NODE); // the image the alpha is joined to: cleaned
      const invert = node(join.inputs.alpha);
      expect(invert.class_type).toBe("InvertMask"); // RemoveBackground's mask is the subject; the alpha clears the rest
      const remove = node(invert.inputs.mask);
      expect([remove.class_type, remove.inputs.image]).toEqual(["RemoveBackground", join.inputs.image]);
      expect(node(remove.inputs.bg_removal_model).inputs).toEqual({ bg_removal_name: BACKGROUND_MODEL });
      expect(JSON.stringify(prepare(pack, normalize({})).workflow)).not.toContain("RemoveBackground");
    }
    expect(BG_MODELS.models.map((m) => [m.subfolder, m.filename])).toEqual([["background_removal", BACKGROUND_MODEL]]);
  });

  it("normalize cleans LoRA entries and caps keep-warm", () => {
    const cfg = normalize({
      keep_warm_minutes: 500,
      pack_loras: {
        anima: ["bare.safetensors", { name: " a.safetensors ", strength: 9, trigger: " @x ", hidden: 1 }, { name: "" }, 7,
          { name: "b.safetensors", strength: "0.5" }, { name: "c.safetensors", strength: "" }],
        other: "junk",
      },
    });
    expect(cfg.keep_warm_minutes).toBe(60);
    expect(normalize({ keep_warm_minutes: "x" }).keep_warm_minutes).toBe(DEFAULT_KEEP_WARM_MINUTES);
    expect(cfg.pack_loras).toEqual({
      anima: [
        { name: "a.safetensors", strength: 5, trigger: "@x", hidden: false, enabled: true },
        { name: "b.safetensors", strength: 0.5, trigger: "", hidden: false, enabled: true }, // config.json is hand-editable
        { name: "c.safetensors", strength: 1, trigger: "", hidden: false, enabled: true },
      ],
      other: [],
    });
    // A LoRA is in one group, and on or off there; a name already in an earlier group is dropped.
    const two = normalize({ pack_loras: { anima: [{ name: "x.safetensors", enabled: false }], klein: [{ name: "x.safetensors" }, { name: "y.safetensors" }] } });
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

describe("redraw", () => {
  const builtin = builtinPacks();
  const pack = (name: string) => builtin.find((p) => p.name === name)!;

  it("runs on the illustration packs whose sampler has a denoise", () => {
    expect(builtin.filter(canRedraw).map((p) => p.name).sort()).toEqual(["anima", "anima_turbo"]); // illustrations only
  });

  it("repaints the loaded image through a mask instead of drawing from an empty latent", () => {
    const cfg = normalize({ pack_loras: { anima: [{ name: "style.safetensors", trigger: "@style" }] } });
    const prepared = prepare(pack("anima_turbo"), cfg);
    const wf = redrawWorkflow(prepared.workflow, "sprite.png [input]", { box: "0.3,0.7,0.4,0.9", strength: 0.9, maxPixels: 2359296 });
    const node = (ref: [string, number]) => wf[ref[0]];
    const byClass = (c: string) => Object.values<any>(wf).filter((n) => n.class_type === c);
    expect(byClass("EmptyLatentImage")).toEqual([]); // the empty latent is gone
    expect(JSON.stringify(prepared.workflow)).toContain("EmptyLatentImage"); // the pack itself untouched
    const [sampler] = byClass("KSampler");
    expect(sampler.inputs.denoise).toBe(0.9);
    const mask = node(sampler.inputs.latent_image);
    expect(mask.class_type).toBe("SetLatentNoiseMask");
    const encode = node(mask.inputs.samples);
    const region = node(encode.inputs.pixels);
    expect([region.class_type, mask.inputs.mask[0], mask.inputs.mask[1]]).toEqual([REDRAW_REGION_NODE, encode.inputs.pixels[0], 1]);
    expect(region.inputs).toEqual({ image: region.inputs.image, box: "0.3,0.7,0.4,0.9", max_pixels: 2359296 });
    const load = node(region.inputs.image);
    expect([load.class_type, load.inputs.image]).toEqual(["LoadImage", "sprite.png [input]"]);
    expect(encode.inputs.vae).toEqual(byClass("VAEDecode")[0].inputs.vae);
    const diff = node(sampler.inputs.model);
    expect(diff.class_type).toBe("DifferentialDiffusion");
    expect(node(diff.inputs.model).class_type).toBe("LoraLoaderModelOnly"); // after the LoRAs
    const [save] = byClass("SaveImage");
    const paste = node(save.inputs.images);
    expect(paste.class_type).toBe(REDRAW_PASTE_NODE);
    expect(node(paste.inputs.redrawn).class_type).toBe("VAEDecode");
    expect([paste.inputs.original, paste.inputs.alpha, paste.inputs.region]).toEqual([region.inputs.image, [region.inputs.image[0], 1], [encode.inputs.pixels[0], 2]]);
    // buildPrompt fills it like a generation, with no size to set
    const built = buildPrompt(wf, "smile", { loraToggles: prepared.lora_toggles });
    expect(Object.values<any>(built).find((n) => n._meta?.title === "cg:prompt").inputs.text).toBe("smile");
  });

  it("with the background cut, the cut comes after the paste, from a fresh alpha", () => {
    const pack = prepare(builtin.find((p) => p.name === "anima_turbo")!, normalize({}));
    const wf = redrawWorkflow(pack.workflow, "a.png", { box: "", strength: 0.9, maxPixels: 2359296, keepAlpha: false });
    withBackgroundRemoval(wf);
    const node = (ref: [string, number]) => wf[ref[0]];
    const save = Object.values<any>(wf).find((n) => n.class_type === "SaveImage");
    const join = node(save.inputs.images);
    expect(join.class_type).toBe("JoinImageWithAlpha");
    const paste = node(join.inputs.image);
    expect(paste.class_type).toBe(REDRAW_PASTE_NODE);
    expect(paste.inputs.alpha).toBeUndefined(); // the source's alpha is not put back
    expect(node(node(join.inputs.alpha).inputs.mask).inputs.image).toEqual(join.inputs.image); // RemoveBackground sees the paste
    const plain = redrawWorkflow(pack.workflow, "a.png", { box: "", strength: 0.9, maxPixels: 2359296 });
    expect(Object.values<any>(plain).find((n) => n.class_type === REDRAW_PASTE_NODE).inputs.alpha).toBeDefined();
  });

  it("won't build on a pack that can't", () => {
    expect(() => redrawWorkflow(pack("flux2klein").workflow, "a.png", { box: "", strength: 1, maxPixels: 1 })).toThrow(/can't redraw/);
  });

  it("runs Anima Turbo, or the Anima pack a caller names", () => {
    expect((redrawPack(builtin, undefined) as any).name).toBe("anima_turbo");
    expect((redrawPack(builtin, "anima") as any).name).toBe("anima");
    expect(redrawPack(builtin, "z_image_turbo")).toBe('Unknown model "z_image_turbo" for redraw. Valid models: anima, anima_turbo.');
  });

  it("the face detector is a model set every GPU keeps", () => {
    expect(FACE_MODELS.models.map((m) => [m.subfolder, m.filename])).toEqual([["comfy_gen", "face_detect_v1.4_s.onnx"]]);
    expect(wantedModelSets(normalize({ remove_marks: false })).map((p) => p.name)).toEqual(["remove-background", "detect-faces"]);
    expect(wantedModelSets(normalize({})).map((p) => p.name)).toContain("detect-faces");
  });
});
