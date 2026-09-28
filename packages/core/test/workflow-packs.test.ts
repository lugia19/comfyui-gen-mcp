/// <reference types="node" />
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACK_FILES } from "../packs/index.ts";
import { DEFAULT_KEEP_WARM_MINUTES, DEFAULTS, normalize } from "../src/config.ts";
import { builtinPacks, configKey, groupByTool, prepare, select, validate } from "../src/packs.ts";
import { buildPrompt, calcDimensions, classTypes, injectLoras, parseCustomWorkflow, splitLossless, type Workflow } from "../src/workflow.ts";

const smallWorkflow = (): Workflow => ({
  "1": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" } },
  "2": { class_type: "KSampler", inputs: { seed: 0, model: ["1", 0], positive: ["3", 0] } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "" }, _meta: { title: "Positive" } },
  "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512 } },
  "5": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0] } },
});

describe("workflow", () => {
  it.each([
    ["portrait", "portrait", false],
    ["portrait:lossless", "portrait", true],
    ["C:/x.png:LOSSLESS", "C:/x.png", true],
    ["C:/x.png", "C:/x.png", false],
  ])("splitLossless(%s)", (value, rest, flag) => {
    expect(splitLossless(value)).toEqual([rest, flag]);
  });

  it("calcDimensions: named and custom", () => {
    expect(calcDimensions("square", 1_048_576)).toEqual([1024, 1024]);
    const [w, h] = calcDimensions("portrait", 1_048_576);
    expect(w % 64 === 0 && h % 64 === 0 && h > w).toBe(true);
    expect(calcDimensions("1600x900", 1_048_576)).toEqual(calcDimensions("wide", 1_048_576));
    expect(calcDimensions("nonsense", 1_048_576)).toEqual([1024, 1024]);
  });

  it("buildPrompt sets text, seeds and dimensions on a copy", () => {
    const wf = smallWorkflow();
    const out = buildPrompt(wf, "a cat", "3", [{ node_id: "2", field: "seed" }], {
      dimensionNodes: { width: [{ node_id: "4", field: "width" }], height: [{ node_id: "4", field: "height" }] },
      aspectRatio: "landscape",
      maxPixels: 1_048_576,
    });
    expect(out["3"].inputs.text).toBe("a cat");
    expect(out["2"].inputs.seed).not.toBe(0);
    expect(Number.isSafeInteger(out["2"].inputs.seed)).toBe(true);
    expect([out["4"].inputs.width, out["4"].inputs.height]).toEqual(calcDimensions("landscape", 1_048_576));
    expect(wf["3"].inputs.text).toBe(""); // the source is untouched
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

  it("LoRA toggles follow the prompt", () => {
    const wf = smallWorkflow();
    const toggles = injectLoras(wf, [{ name: "b.safetensors", trigger: "@B", strength: 0.7 }]);
    expect(buildPrompt(wf, "art by @b", "3", [], { loraToggles: toggles })["6"].inputs.strength_model).toBe(0.7);
    expect(buildPrompt(wf, "no trigger", "3", [], { loraToggles: toggles })["6"].inputs.strength_model).toBe(0.0);
  });

  it("injectLoras without a loader throws", () => {
    expect(() => injectLoras({ "1": { class_type: "KSampler", inputs: {} } }, [{ name: "a" }])).toThrow();
  });

  it("parseCustomWorkflow rejects the UI format", () => {
    expect(() => parseCustomWorkflow({ nodes: [], links: [] })).toThrow(/API format/);
  });

  it("parseCustomWorkflow finds the prompt node", () => {
    const wf = smallWorkflow();
    expect(parseCustomWorkflow(wf)).toEqual([wf, "3", ["2"]]); // traced from the KSampler's positive input
    expect(parseCustomWorkflow(wf, "positive")[1]).toBe("3"); // by title, case-insensitive
    wf["4"]._meta = { title: "Prompt" };
    expect(parseCustomWorkflow(wf)[1]).toBe("4"); // a node titled "prompt" wins over tracing
    expect(() => parseCustomWorkflow(wf, "missing")).toThrow(/No node titled/);
  });

  it("the first KSampler is the lowest node id, whatever the JSON order", () => {
    const wf = JSON.parse('{"10": {"class_type": "KSampler", "inputs": {"positive": ["20", 0]}}, "3": {"class_type": "KSampler", "inputs": {"positive": ["30", 0]}}}');
    expect(parseCustomWorkflow(wf)[1]).toBe("30");
  });

  it("classTypes", () => {
    expect(classTypes(smallWorkflow())).toEqual(new Set(["UNETLoader", "KSampler", "CLIPTextEncode", "EmptyLatentImage", "ModelSamplingAuraFlow"]));
  });
});

describe("packs and config", () => {
  const builtin = builtinPacks();

  it("every pack JSON file is listed, in file-name order", () => {
    const dir = new URL("../packs/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    expect(PACK_FILES.map(([f]) => f)).toEqual(files);
  });

  it("builtin packs load", () => {
    const names = new Set(builtin.map((p) => p.name));
    for (const n of ["anima", "anima_turbo", "flux2klein", "flux2klein_edit", "z_image_turbo"]) expect(names.has(n)).toBe(true);
    for (const p of builtin) expect(JSON.stringify(p.workflow)).not.toContain("comfy-dxt");
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
    const key = configKey(pack);
    expect(prepare(pack, normalize({ pack_settings: { [key]: { max_pixels: pack.max_pixels_limit * 10 } } })).max_pixels).toBe(pack.max_pixels_limit);
    expect(prepare(pack, normalize({ pack_settings: { [key]: { max_pixels: "big" } } })).max_pixels).toBe(pack.max_pixels);
  });

  it("normalize fills defaults and keeps unknown keys", () => {
    const cfg = normalize({ keep_warm_minutes: 0, pack_loras: "junk", comfyui_url: "http://x" });
    expect(cfg.keep_warm_minutes).toBe(DEFAULT_KEEP_WARM_MINUTES);
    expect(cfg.pack_loras).toEqual({});
    expect(cfg.comfyui_url).toBe("http://x");
    expect(normalize(null)).toEqual(DEFAULTS);
    const raw = { custom_workflow: { workflow: { "1": {} } } };
    const out = normalize(raw);
    (out.custom_workflow!.workflow["1"] as any).x = 1;
    expect(raw).toEqual({ custom_workflow: { workflow: { "1": {} } } }); // a deep copy
    expect(normalize({ custom_workflow: "nope" }).custom_workflow).toBeNull();
  });
});
