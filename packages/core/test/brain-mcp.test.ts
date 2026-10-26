import { describe, expect, it } from "vitest";
import { roundHalfEven } from "../src/bytes.ts";
import { BACKGROUND_UNAVAILABLE, Brain, DEFAULT_WAIT_S, Done, Failed, Hooks, Pending, REDRAW_AREA_UNAVAILABLE, REDRAW_UNAVAILABLE, redrawBox, type ResolvedImage, REDRAW_EXTEND_UNAVAILABLE, redrawExtend } from "../src/brain.ts";
import { ComfyUIError, STILL_STARTING } from "../src/comfyui.ts";
import { McpHandler, PROTOCOL_VERSIONS, RESULT_META, UnknownTool, type ToolCall } from "../src/mcp.ts";
import { builtinPacks, type Pack } from "../src/packs.ts";
import { toolSpecs } from "../src/tools.ts";
import { normalize } from "../src/config.ts";
import { FakeComfy, fastClient, png } from "./fake-comfy.ts";
import { withPrompt } from "./metadata-fixtures.ts";
import { failResult, renderOutcome } from "../src/results.ts";

const BUILTIN = builtinPacks();
const names = (specs: { name: string }[]) => specs.map((s) => s.name);

describe("tools", () => {
  it("tool lists per mode", () => {
    const paths = toolSpecs(BUILTIN, normalize({}), "paths");
    const refs = toolSpecs(BUILTIN, normalize({}), "refs");
    expect(names(paths)).not.toContain("request_upload");
    expect(names(refs)).toContain("request_upload");
    expect(paths.find((s) => s.name === "edit_image")!.inputSchema.required).toEqual(["prompt", "image_path"]);
    expect(refs.find((s) => s.name === "edit_image")!.inputSchema.required).toEqual(["prompt", "image"]);
    // Custom workflows were removed: a stored custom_workflow no longer adds a tool.
    expect(names(toolSpecs(BUILTIN, normalize({ custom_workflow: { workflow: {} } }), "paths"))).toEqual(names(paths));
    expect(names(paths).at(-1)).toBe("fetch_result");
  });

  it("descriptions fill artists and visible LoRA triggers", () => {
    const cfg = normalize({
      pack_settings: { anima: { artist_list: "@one, @two" } },
      pack_loras: { anima: [{ name: "a.safetensors", trigger: "@shown" }, { name: "b.safetensors", trigger: "@secret", hidden: true }] },
    });
    const desc = toolSpecs(BUILTIN, cfg, "refs").find((s) => s.name === "generate_illustrated_image")!.description;
    expect(desc).toContain("preferred default: @one, others available: @two");
    expect(desc).toContain("@shown");
    expect(desc).not.toContain("@secret");
    expect(desc).not.toContain("{artist_list}");
    expect(desc).not.toContain("{lora_triggers}");
  });
});

class PathHooks extends Hooks {
  ensured: string[] = [];
  async ensure(pack: Pack) {
    this.ensured.push(pack.name);
  }
  async resolveImage(arg: string): Promise<ResolvedImage> {
    return [`${arg} [output]`, arg.includes("small") ? [512, 512] : [4096, 4096]];
  }
}

function setup(opts: { cfg?: unknown; hooks?: Hooks; waitS?: number; budget?: number; canRemoveMarks?: boolean; canRemoveBackground?: boolean; canRedraw?: boolean; canCutout?: boolean; canRedrawArea?: boolean; canInpaintControl?: boolean; canRedrawExtend?: boolean } = {}) {
  const comfy = new FakeComfy();
  const client = fastClient(comfy, { coldStartS: 60, requestBudget: opts.budget ?? null });
  const brain = (o: typeof opts = {}) =>
    new Brain(BUILTIN, o.cfg ?? opts.cfg ?? {}, client, "paths", {
      hooks: o.hooks ?? opts.hooks ?? new PathHooks(),
      waitS: o.waitS ?? opts.waitS,
      canRemoveMarks: o.canRemoveMarks ?? opts.canRemoveMarks,
      canRemoveBackground: o.canRemoveBackground ?? opts.canRemoveBackground,
      canRedraw: o.canRedraw ?? opts.canRedraw,
      canCutout: o.canCutout ?? opts.canCutout,
      canRedrawArea: o.canRedrawArea ?? opts.canRedrawArea,
      canInpaintControl: o.canInpaintControl ?? opts.canInpaintControl,
      canRedrawExtend: o.canRedrawExtend ?? opts.canRedrawExtend,
    });
  return { comfy, client, brain };
}

describe("one time budget per tool call", () => {
  // Clients give up after 3 to 5 minutes. A cold start plus a full wait after it used to run past that.
  const coldSetup = () => {
    const comfy = new FakeComfy();
    const client = fastClient(comfy, { coldStartS: 300 });
    const brain = new Brain(BUILTIN, {}, client, "paths", { hooks: new PathHooks() });
    return { comfy, client, brain };
  };

  it("a slow cold start still answers within the budget, with a token to fetch later", async () => {
    const { comfy, client, brain } = coldSetup();
    comfy.bootFails = 20; // 100 s of booting, 5 s per retry
    comfy.history = Array(200).fill("running"); // then a long first load
    const out = await brain.call("generate_realistic_image", { prompt: "a lighthouse" });
    expect(out).toBeInstanceOf(Pending);
    expect(client.time()).toBeLessThanOrEqual(DEFAULT_WAIT_S + 15); // not 100 + 150
    comfy.history = [];
    expect(await brain.call("fetch_result", { request_token: (out as Pending).token })).toBeInstanceOf(Done);
  });

  it("a boot longer than the budget says to call again, before the client gives up", async () => {
    const { comfy, client, brain } = coldSetup();
    comfy.bootFails = 1000;
    const out = await brain.call("generate_realistic_image", { prompt: "a lighthouse" });
    expect(out).toBeInstanceOf(Failed);
    expect((out as Failed).message).toBe(STILL_STARTING);
    expect((out as Failed).retryable).toBe(true);
    expect(client.time()).toBeLessThanOrEqual(DEFAULT_WAIT_S + 10);
  });
});

describe("brain", () => {
  it("generate returns Done", async () => {
    const { comfy, brain } = setup();
    const out = await brain().call("generate_realistic_image", { prompt: "a lighthouse", aspect_ratio: "wide" });
    expect(out).toBeInstanceOf(Done);
    expect((out as Done).promptId).toBe("p1");
    expect(Object.values<any>(comfy.prompts[0]).map((n) => n.inputs.text ?? n.inputs.prompt)).toContain("a lighthouse"); // Qwen's encoder takes `prompt`
  });

  it("a hidden negative reaches the illustrated pack, and the tool schemas don't show it", async () => {
    const { comfy, brain } = setup();
    await brain().call("generate_illustrated_image", { prompt: "x", negative: "lowres" });
    // the pack's always-on tags first, the caller's after them
    const anima = BUILTIN.find((p) => p.name === "anima_turbo")!;
    expect(Object.values<any>(comfy.prompts[0]).find((n) => n._meta?.title === "cg:negative").inputs.text).toBe(`${anima.negative_fixed}, lowres`);
    for (const mode of ["refs", "paths"] as const) {
      expect(JSON.stringify(toolSpecs(BUILTIN, normalize({}), mode))).not.toContain("negative");
      // Nor the hidden model: no tool takes a property of that name.
      for (const spec of toolSpecs(BUILTIN, normalize({}), mode)) expect(spec.inputSchema.properties).not.toHaveProperty("model");
    }
  });

  it("a hidden seed makes a call repeatable, on every tool that samples; none is random", async () => {
    const { comfy, brain } = setup({ canRedraw: true, cfg: { remove_marks: false } });
    const hooks = new PathHooks();
    const seeds = () => Object.values<any>(comfy.prompts.at(-1)!).filter((n) => n._meta?.title === "cg:seed").map((n) => n.inputs.seed ?? n.inputs.noise_seed);
    for (const [tool, args] of [
      ["generate_illustrated_image", { prompt: "x" }],
      ["generate_realistic_image", { prompt: "x" }],
      ["edit_image", { prompt: "x", image_path: "a.png" }],
      ["redraw", { prompt: "x", image_path: "a.png", box: [0.1, 0.1, 0.5, 0.5] }],
    ] as const) {
      expect(await brain({ hooks }).call(tool, { ...args, seed: 1234 }), tool).toBeInstanceOf(Done);
      expect(seeds().length, tool).toBeGreaterThan(0);
      expect(new Set(seeds()), tool).toEqual(new Set([1234]));
      await brain({ hooks }).call(tool, { ...args, seed: "1234" }); // a string of digits too
      expect(new Set(seeds()), tool).toEqual(new Set([1234]));
      await brain({ hooks }).call(tool, args);
      expect(seeds(), tool).not.toContain(1234);
    }
    expect(await brain().call("generate_illustrated_image", { prompt: "x", seed: 0 })).toBeInstanceOf(Done);
    expect(seeds()).toEqual([0]);
    expect(await brain().call("generate_illustrated_image", { prompt: "x", seed: Number.MAX_SAFE_INTEGER })).toBeInstanceOf(Done);
    const before = comfy.prompts.length;
    for (const seed of [-1, 1.5, 2 ** 53, "12abc", true, {}]) {
      const out = await brain().call("generate_illustrated_image", { prompt: "x", seed });
      expect((out as Failed).message, String(seed)).toMatch(/^seed must be a whole number/);
      expect((out as Failed).retryable).toBe(false);
    }
    expect(comfy.prompts.length).toBe(before); // nothing ran
    for (const mode of ["refs", "paths"] as const) {
      for (const spec of toolSpecs(BUILTIN, normalize({}), mode)) expect(spec.inputSchema.properties, spec.name).not.toHaveProperty("seed");
    }
  });

  it("remove_background is offered on every image tool, in both modes", () => {
    for (const mode of ["refs", "paths"] as const) {
      const specs = toolSpecs(BUILTIN, normalize({}), mode).filter((s) => s.name.startsWith("generate_") || s.name === "edit_image");
      expect(specs.length).toBe(3);
      for (const spec of specs) expect(spec.inputSchema.properties.remove_background).toMatchObject({ type: "boolean", default: false });
    }
  });

  it("a hidden model runs that pack of the tool, with its group's LoRAs", async () => {
    const cfg = {
      pack_selections: { generate_illustrated_image: "anima" },
      pack_loras: { anima: [{ name: "style.safetensors", strength: 0.5 }] },
    };
    const hooks = new PathHooks();
    const { comfy, brain } = setup({ cfg, hooks });
    const unet = (i: number) => Object.values<any>(comfy.prompts[i]).find((n) => n.class_type === "UNETLoader").inputs.unet_name;
    await brain().call("generate_illustrated_image", { prompt: "x", model: "anima_turbo" });
    await brain().call("generate_illustrated_image", { prompt: "x", model: " " });
    expect([unet(0), unet(1)]).toEqual(["anima-turbo-v1.0.safetensors", "anima-base-v1.0.safetensors"]);
    expect(hooks.ensured).toEqual(["anima_turbo", "anima"]);
    const lora = Object.values<any>(comfy.prompts[0]).find((n) => n.class_type === "LoraLoaderModelOnly");
    expect(lora.inputs).toMatchObject({ lora_name: "style.safetensors", strength_model: 0.5 });
  });

  it("each pack of a LoRA group takes its own strength, else the shared one", async () => {
    const cfg = {
      pack_loras: {
        anima: [
          { name: "style.safetensors", strength: 0.5, strengths: { anima_turbo: 0.8 } },
          { name: "ink.safetensors", trigger: "@ink", strength: 1, strengths: { anima: 0.3 } },
        ],
      },
    };
    const { comfy, brain } = setup({ cfg });
    const strengths = (i: number) => Object.fromEntries(Object.values<any>(comfy.prompts[i]).filter((n) => n.class_type === "LoraLoaderModelOnly").map((n) => [n.inputs.lora_name, n.inputs.strength_model]));
    await brain().call("generate_illustrated_image", { prompt: "@ink x", model: "anima_turbo" });
    await brain().call("generate_illustrated_image", { prompt: "@ink x", model: "anima" });
    expect(strengths(0)).toEqual({ "style.safetensors": 0.8, "ink.safetensors": 1 }); // the trigger's too
    expect(strengths(1)).toEqual({ "style.safetensors": 0.5, "ink.safetensors": 0.3 });
  });

  it("a model of another tool, or none, is a plain error naming the valid ones", async () => {
    const { comfy, brain } = setup();
    for (const model of ["z_image_turbo", "nope"]) {
      const out = await brain().call("generate_illustrated_image", { prompt: "x", model });
      expect(out).toEqual(new Failed(`Unknown model "${model}" for generate_illustrated_image. Valid models: anima, anima_turbo.`));
    }
    expect(comfy.prompts).toEqual([]);
  });

  it("removes signatures and watermarks where the GPU can, once its models are there", async () => {
    const marked = (comfy: FakeComfy) => JSON.stringify(comfy.prompts.at(-1)).includes("ComfyGenRemoveMarks");
    const { comfy, brain } = setup({ canRemoveMarks: true });
    const hooks = new PathHooks();
    await brain({ hooks }).call("generate_illustrated_image", { prompt: "x" });
    expect(hooks.ensured).toEqual(["remove-marks", "anima_turbo"]); // its models first, like a pack's
    expect(marked(comfy)).toBe(true);
    await brain({ hooks }).call("edit_image", { prompt: "x", image_path: "a.png" });
    expect(marked(comfy)).toBe(true); // edits too

    // Still downloading: the image goes out as it comes, not waiting for them.
    class Downloading extends PathHooks {
      async ensure(pack: Pack) {
        if (pack.name === "remove-marks") throw new ComfyUIError("The Watermark removal model is being downloaded.", { retryable: true });
        return super.ensure(pack);
      }
    }
    expect(await brain({ hooks: new Downloading() }).call("generate_illustrated_image", { prompt: "x" })).toBeInstanceOf(Done);
    expect(marked(comfy)).toBe(false);

    // Switched off, or a GPU without our extension (a ComfyUI of the user's own): never asked for.
    for (const o of [{ cfg: { remove_marks: false } }, { canRemoveMarks: false }]) {
      const h = new PathHooks();
      await brain({ hooks: h, ...o }).call("generate_illustrated_image", { prompt: "x" });
      expect([h.ensured, marked(comfy)]).toEqual([["anima_turbo"], false]);
    }
  });

  it("removes the background when a call asks, waiting for its model like a pack's", async () => {
    const cleared = (comfy: FakeComfy) => JSON.stringify(comfy.prompts.at(-1)).includes("JoinImageWithAlpha");
    const { comfy, brain } = setup({ canRemoveBackground: true, cfg: { remove_marks: false } });
    let hooks = new PathHooks();
    await brain({ hooks }).call("generate_illustrated_image", { prompt: "x" });
    expect([hooks.ensured, cleared(comfy)]).toEqual([["anima_turbo"], false]); // not asked: untouched
    hooks = new PathHooks();
    await brain({ hooks }).call("generate_illustrated_image", { prompt: "x", remove_background: true });
    expect([hooks.ensured, cleared(comfy)]).toEqual([["remove-background", "anima_turbo"], true]);
    hooks = new PathHooks();
    await brain({ hooks }).call("edit_image", { prompt: "x", image_path: "a.png", remove_background: true });
    expect([hooks.ensured, cleared(comfy)]).toEqual([["remove-background", "qwen_image_21_edit"], true]); // edits too

    // Still downloading: a retryable answer, never an image that kept its background.
    class Downloading extends PathHooks {
      async ensure(pack: Pack) {
        if (pack.name === "remove-background") throw new ComfyUIError("The Background removal model is being downloaded.", { retryable: true });
        return super.ensure(pack);
      }
    }
    const before = comfy.prompts.length;
    const r = await brain({ hooks: new Downloading() }).call("generate_illustrated_image", { prompt: "x", remove_background: true });
    expect(r).toMatchObject({ message: "The Background removal model is being downloaded.", retryable: true });
    expect(comfy.prompts.length).toBe(before);

    // A GPU that can't (a PC agent from before it): a plain answer, nothing run.
    for (const tool of ["generate_illustrated_image", "edit_image"]) {
      const out = await brain({ canRemoveBackground: false }).call(tool, { prompt: "x", image_path: "a.png", remove_background: true });
      expect([out instanceof Failed, (out as Failed).message]).toEqual([true, BACKGROUND_UNAVAILABLE]);
    }
    expect(comfy.prompts.length).toBe(before);
  });

  it("a timeout returns a stateless token, and fetch_result resumes", async () => {
    const { comfy, brain } = setup();
    comfy.history = Array(3).fill("running");
    const out = await brain({ waitS: 0 }).call("generate_illustrated_image", { prompt: "x", aspect_ratio: "portrait" });
    expect(out).toBeInstanceOf(Pending);
    expect((out as Pending).token).toBe("p1");
    expect((out as Pending).text()).toContain("fetch_result");
    comfy.history = [];
    const again = await brain().call("fetch_result", { request_token: "p1" });
    expect(again).toBeInstanceOf(Done);
  });

  it("errors become Failed, not exceptions", async () => {
    const { comfy, brain } = setup();
    comfy.history = ["error"];
    const out = await brain().call("generate_realistic_image", { prompt: "x" });
    expect(out).toBeInstanceOf(Failed);
    expect((out as Failed).text()).toContain("out of memory");
    expect(await brain().call("generate_realistic_image", {})).toBeInstanceOf(Failed);
  });

  it("an ensure failure is reported", async () => {
    class Broken extends Hooks {
      async ensure() {
        throw new ComfyUIError("Models are downloading.");
      }
    }
    const { brain } = setup();
    const out = await brain({ hooks: new Broken() }).call("generate_realistic_image", { prompt: "x" });
    expect(out).toEqual(new Failed("Models are downloading."));
    expect((out as Failed).retryable).toBe(false); // only when the error says so
  });

  it("edit, single and multi", async () => {
    const hooks = new PathHooks();
    const { comfy, brain } = setup({ hooks });
    const b = brain();
    const edit = BUILTIN.find((p) => p.tool_name === "edit_image" && p.is_default)!;
    expect(await b.call("edit_image", { prompt: "make it night", image_path: "small.png" })).toBeInstanceOf(Done);
    // Each loaded image, in order, with its scale node's megapixels.
    const loaded = (wf: Record<string, any>) =>
      Object.keys(wf).filter((id) => wf[id].class_type === "LoadImage").map((id) => {
        const scale = Object.values<any>(wf).find((n) => n.class_type === "ImageScaleToTotalPixels" && n.inputs.image[0] === id);
        return [wf[id].inputs.image, scale.inputs.megapixels];
      });
    expect(loaded(comfy.prompts[0])).toEqual([["small.png [output]", roundHalfEven(((512 * 512) / 1_048_576) * 1e4) / 1e4]]);

    await b.call("edit_image", { prompt: "combine", image_path: "big.png", second_image_path: "small.png" });
    const budget = roundHalfEven((edit.max_pixels / 1_048_576) * 1e4) / 1e4;
    expect(loaded(comfy.prompts[1])).toEqual([["big.png [output]", budget], ["small.png [output]", 0.25]]);
    expect(hooks.ensured).toEqual([edit.name, edit.name]);
  });

  it("unknown tools throw UnknownTool", async () => {
    const { brain } = setup();
    await expect(brain().call("no_such_tool", {})).rejects.toBeInstanceOf(UnknownTool);
    await expect(brain({ cfg: { custom_workflow: { workflow: {} } } }).call("generate_custom_image", { prompt: "x" })).rejects.toBeInstanceOf(UnknownTool); // removed
  });

  it("an exhausted request budget becomes a token", async () => {
    const { comfy, client, brain } = setup({ budget: 8 });
    comfy.history = Array(100).fill("running");
    const out = await brain({ waitS: 3600 }).call("generate_realistic_image", { prompt: "x" });
    expect(out).toBeInstanceOf(Pending);
    expect((out as Pending).token).toBe("p1");
    expect(client.requestsMade).toBeLessThanOrEqual(8);
  });
});

describe("tool results (every frontend)", () => {
  it("images with the frontend's text and fields, then pending and failed", async () => {
    const { comfy, client, brain } = setup();
    comfy.viewBody = png(64, 48);
    const after = async (bytes: Uint8Array) => ({ text: `saved: ${bytes.length}`, meta: { id: "a" } });
    const [content, isError, meta] = await renderOutcome(await brain().call("generate_realistic_image", { prompt: "x" }), client, after);
    expect([content.map((c) => c.type), content[1].text, isError]).toEqual([["image", "text"], `saved: ${comfy.viewBody.length}`, false]);
    expect(meta).toEqual({ status: "done", images: [{ id: "a", width: 64, height: 48 }] });
    expect((await renderOutcome(new Pending("gpu:p1", "queued"), client, after))[2]).toEqual({ status: "pending", request_token: "gpu:p1" });
    expect(await renderOutcome(new Failed(STILL_STARTING, true), client, after)).toEqual(failResult(STILL_STARTING, true));
    expect(failResult("no")).toEqual([[{ type: "text", text: "Error: no" }], true, { status: "error", message: "no", retryable: false }]);
  });
});

describe("mcp", () => {
  const TOOLS = [{ name: "echo", description: "d", inputSchema: { type: "object" } }];
  const call: ToolCall = async (name, args) => {
    if (name === "boom") throw new Error("kaput");
    if (name === "structured") return [[{ type: "text", text: "t" }], false, { status: "done" }];
    if (name !== "echo") throw new UnknownTool(name);
    return [[{ type: "text", text: args.x ?? "" }], false];
  };
  const handler = () => new McpHandler("test", "1.0", TOOLS, call, "be nice");
  async function rpc(method: string, params?: unknown, id: unknown = 1) {
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (id !== null) msg.id = id;
    if (params !== undefined) msg.params = params;
    const [status, body] = await handler().handle(JSON.stringify(msg));
    return [status, body === null ? null : JSON.parse(body)] as const;
  }

  it("initialize negotiates the version", async () => {
    let [, r] = await rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.serverInfo).toEqual({ name: "test", version: "1.0" });
    expect(r.result.instructions).toBe("be nice");
    [, r] = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(r.result.protocolVersion).toBe(PROTOCOL_VERSIONS.at(-1));
  });

  it("notifications get 202 and no body", async () => {
    expect(await rpc("notifications/initialized", undefined, null)).toEqual([202, null]);
  });

  it("tools/list and tools/call", async () => {
    let [, r] = await rpc("tools/list", undefined, "a");
    expect(r.id).toBe("a");
    expect(r.result.tools).toEqual(TOOLS);
    [, r] = await rpc("tools/call", { name: "echo", arguments: { x: "hi" } });
    expect(r.result).toEqual({ content: [{ type: "text", text: "hi" }], isError: false });
    // A scripted caller's result rides in _meta when the tool gives one, and only then.
    [, r] = await rpc("tools/call", { name: "structured" });
    expect(r.result).toEqual({ content: [{ type: "text", text: "t" }], isError: false, _meta: { [RESULT_META]: { status: "done" } } });
  });

  it("an unknown tool is a protocol error, a crash is a tool error", async () => {
    let [, r] = await rpc("tools/call", { name: "nope" });
    expect(r.error.code).toBe(-32602);
    [, r] = await rpc("tools/call", { name: "boom" });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("kaput");
  });

  it("bad input", async () => {
    expect((await handler().handle("{not json"))[0]).toBe(400);
    expect((await handler().handle("[]"))[0]).toBe(400);
    let [, r] = await rpc("resources/list");
    expect(r.error.code).toBe(-32601);
    [, r] = await rpc("ping");
    expect(r.result).toEqual({});
  });
});

describe("redraw", () => {
  const nodeOf = (prompt: Record<string, any>, cls: string) => Object.values<any>(prompt).find((n) => n.class_type === cls);

  it("is listed in both modes with that mode's image argument", () => {
    const paths = toolSpecs(BUILTIN, normalize({}), "paths").find((s) => s.name === "redraw")!;
    const refs = toolSpecs(BUILTIN, normalize({}), "refs").find((s) => s.name === "redraw")!;
    expect(paths.inputSchema.required).toEqual(["prompt", "image_path"]);
    expect(refs.inputSchema.required).toEqual(["prompt", "image"]);
    for (const spec of [paths, refs]) {
      expect(spec.description).toContain("fractions");
    }
  });

  it("runs Anima Turbo whatever the settings select for illustrations", async () => {
    const { comfy, brain } = setup({ canRedraw: true, cfg: { remove_marks: false, pack_selections: { generate_illustrated_image: "anima" } } });
    const hooks = new PathHooks();
    await brain({ hooks }).call("redraw", { prompt: "x", image_path: "a.png", box: [0.1, 0.1, 0.5, 0.5] });
    expect(hooks.ensured).toEqual(["anima_turbo"]);
    expect(comfy.prompts.length).toBe(1);
  });

  it("runs the model that drew the image when its metadata says, unless one is named", async () => {
    const { comfy, brain } = setup({ canRedraw: true, cfg: { remove_marks: false } });
    class Drawn extends PathHooks {
      async imageBytes(arg: string) {
        return arg.startsWith("base") ? withPrompt("webpAnima") : arg.startsWith("edit") ? withPrompt("webpKlein") : null;
      }
    }
    const run = async (args: Record<string, unknown>) => {
      const hooks = new Drawn();
      await brain({ hooks }).call("redraw", { prompt: "x", box: [0.1, 0.1, 0.5, 0.5], ...args });
      return [hooks.ensured.at(-1), nodeOf(comfy.prompts.at(-1)!, "UNETLoader").inputs.unet_name];
    };
    expect(await run({ image_path: "base.webp" })).toEqual(["anima", "anima-base-v1.0.safetensors"]);
    expect(await run({ image_path: "base.webp", model: "anima_turbo" })).toEqual(["anima_turbo", "anima-turbo-v1.0.safetensors"]);
    expect(await run({ image_path: "edit.webp" })).toEqual(["anima_turbo", "anima-turbo-v1.0.safetensors"]); // an edit model's image
    expect(await run({ image_path: "upload.png" })).toEqual(["anima_turbo", "anima-turbo-v1.0.safetensors"]); // no metadata
  });

  it("prompt_scope \"area\" crops where the GPU can; any other value is an error", async () => {
    const { comfy, brain } = setup({ canRedraw: true, cfg: { remove_marks: false } });
    const region = () => Object.values<any>(comfy.prompts.at(-1)!).find((n) => n.class_type === "ComfyGenRedrawRegion").inputs;
    const args = { prompt: "a hand", image_path: "a.png", box: [0.4, 0.6, 0.5, 0.7] };
    expect(await brain().call("redraw", { ...args, prompt_scope: "area" })).toEqual(new Failed(REDRAW_AREA_UNAVAILABLE));
    expect(comfy.prompts.length).toBe(0);
    await brain({ canRedrawArea: true }).call("redraw", { ...args, prompt_scope: "area" });
    expect(region().area_only).toBe(true);
    await brain({ canRedrawArea: true }).call("redraw", args); // the default: the whole image, the graph as before
    expect(region()).not.toHaveProperty("area_only");
    expect(await brain().call("redraw", { ...args, prompt_scope: "crop" })).toEqual(new Failed('prompt_scope must be "image" (the default) or "area".'));
    const spec = toolSpecs(BUILTIN, normalize({}), "refs").find((s) => s.name === "redraw")!;
    expect(spec.inputSchema.properties.prompt_scope).toMatchObject({ enum: ["image", "area"], default: "image" });
  });

  it("repaints a box, or the largest face with the detector made ready", async () => {
    const { comfy, brain } = setup({ canRedraw: true, cfg: { remove_marks: false } });
    let hooks = new PathHooks();
    let out = await brain({ hooks }).call("redraw", { prompt: "knight, gauntlets", image_path: "a.png", box: [0.3, 0.7, 0.4, 0.9] });
    expect(out).toBeInstanceOf(Done);
    expect(hooks.ensured).toEqual(["anima_turbo"]);
    let prompt = comfy.prompts.at(-1)!;
    expect(nodeOf(prompt, "ComfyGenRedrawRegion").inputs).toMatchObject({ box: "0.3,0.7,0.4,0.9", max_pixels: 2359296 });
    expect(nodeOf(prompt, "KSampler").inputs.denoise).toBe(0.9);
    expect(nodeOf(prompt, "LoadImage").inputs.image).toBe("a.png [output]");
    expect(JSON.stringify(prompt)).not.toContain("ComfyGenRemoveMarks"); // the rest of the image stays as it was

    hooks = new PathHooks();
    out = await brain({ hooks }).call("redraw", { prompt: "1girl, smile", image_path: "a.png", strength: 1, model: "anima" });
    expect(hooks.ensured).toEqual(["detect-faces", "anima"]);
    prompt = comfy.prompts.at(-1)!;
    expect(nodeOf(prompt, "ComfyGenRedrawRegion").inputs).toMatchObject({ box: "" });
    expect(nodeOf(prompt, "KSampler").inputs.denoise).toBe(1);
  });

  it("cuts the background after the redraw when asked, waiting for its model", async () => {
    const { comfy, brain } = setup({ canRedraw: true, canRemoveBackground: true, cfg: { remove_marks: false } });
    const hooks = new PathHooks();
    await brain({ hooks }).call("redraw", { prompt: "x", image_path: "a.png", remove_background: true });
    expect(hooks.ensured).toEqual(["detect-faces", "remove-background", "anima_turbo"]);
    const prompt = comfy.prompts.at(-1)!;
    expect(nodeOf(prompt, "JoinImageWithAlpha")).toBeDefined();
    expect(nodeOf(prompt, "ComfyGenRedrawPaste").inputs.alpha).toBeUndefined();
    await brain({ hooks: new PathHooks(), canCutout: true }).call("redraw", { prompt: "x", image_path: "a.png", remove_background: true });
    const cut = nodeOf(comfy.prompts.at(-1)!, "ComfyGenCutout");
    expect(comfy.prompts.at(-1)![cut.inputs.image[0]].class_type).toBe("ComfyGenRedrawPaste"); // cut after the paste
    const out = await brain({ canRemoveBackground: false }).call("redraw", { prompt: "x", image_path: "a.png", remove_background: true });
    expect((out as Failed).message).toBe(BACKGROUND_UNAVAILABLE);
    expect(comfy.prompts.length).toBe(2);
    expect(toolSpecs(BUILTIN, normalize({}), "refs").find((s) => s.name === "redraw")!.inputSchema.properties.remove_background.type).toBe("boolean");
  });

  it("answers a bad call before any GPU time", async () => {
    const { comfy, brain } = setup({ canRedraw: true });
    const fail = async (args: Record<string, any>, b = brain()) => ((await b.call("redraw", { prompt: "x", image_path: "a.png", ...args })) as Failed).message;
    expect(await fail({ box: [10, 20, 300, 400] })).toMatch(/fractions .* not pixels/);
    expect(await fail({ box: [0.5, 0.5, 0.4, 0.6] })).toMatch(/box is empty/);
    expect(await fail({ box: [0.1, 0.2] })).toMatch(/four numbers/);
    expect(await fail({ strength: 0.1 })).toMatch(/strength must be/);
    expect(await fail({ model: "z_image_turbo" })).toMatch(/Unknown model "z_image_turbo" for redraw/); // illustrations only
    expect(await fail({}, brain({ canRedraw: false }))).toBe(REDRAW_UNAVAILABLE);
    expect(((await brain().call("redraw", { prompt: "", image_path: "a.png" })) as Failed).message).toMatch(/required/);
    expect(comfy.prompts).toEqual([]);
  });

  it("puts the pack's inpainting control on the model where the GPU has it; without, the old graph", async () => {
    const { comfy, brain } = setup({ canRedraw: true, cfg: { remove_marks: false } });
    const args = { prompt: "x", image_path: "a.png", box: [0.3, 0.7, 0.4, 0.9] };
    await brain({ canInpaintControl: true }).call("redraw", args);
    const control = nodeOf(comfy.prompts.at(-1)!, "ComfyGenInpaintControl");
    expect(control.inputs).toMatchObject({ control_name: "anima-lllite-inpainting-v2.safetensors", strength: 1 });
    expect(nodeOf(comfy.prompts.at(-1)!, "DifferentialDiffusion").inputs.model[0]).toBe(Object.entries(comfy.prompts.at(-1)!).find(([, n]: any) => n.class_type === "ComfyGenInpaintControl")![0]);
    expect(await brain().call("redraw", args)).toBeInstanceOf(Done); // a PC agent from before v1.21.0
    expect(JSON.stringify(comfy.prompts.at(-1))).not.toContain("ComfyGenInpaintControl");
  });

  it("extend grows the canvas where the GPU can, denoised fully, without the face detector", async () => {
    const { comfy, brain } = setup({ canRedraw: true, cfg: { remove_marks: false } });
    const hooks = new PathHooks();
    const args = { prompt: "x", image_path: "a.png", extend: { left: 0.25, right: 0.25 } };
    expect(await brain().call("redraw", args)).toEqual(new Failed(REDRAW_EXTEND_UNAVAILABLE));
    expect(comfy.prompts.length).toBe(0);
    await brain({ hooks, canRedrawExtend: true }).call("redraw", { ...args, strength: 0.5 });
    expect(hooks.ensured).toEqual(["anima_turbo"]); // no face to find
    const prompt = comfy.prompts.at(-1)!;
    expect(nodeOf(prompt, "ComfyGenRedrawRegion").inputs).toMatchObject({ box: "", extend: "0.25,0,0.25,0" });
    expect(nodeOf(prompt, "KSampler").inputs.denoise).toBe(1); // strength doesn't apply
    const fail = async (more: Record<string, any>) => ((await brain({ canRedrawExtend: true, canRedrawArea: true }).call("redraw", { ...args, ...more })) as Failed).message;
    expect(await fail({ box: [0.1, 0.1, 0.5, 0.5] })).toMatch(/extend and box can't be combined/);
    expect(await fail({ prompt_scope: "area" })).toMatch(/prompt_scope "area"/);
    expect(await fail({ extend: { left: 0.75, right: 0.5 } })).toMatch(/at most double/);
    expect(comfy.prompts.length).toBe(1);
    expect(toolSpecs(BUILTIN, normalize({}), "refs").find((s) => s.name === "redraw")!.inputSchema.properties.extend.type).toBe("object");
  });

  it("an extend's new border gets the signature removal, after the paste; a redraw inside the image doesn't", async () => {
    const { comfy, brain } = setup({ canRedraw: true, canRedrawExtend: true, canRemoveMarks: true, canRemoveBackground: true });
    const hooks = new PathHooks();
    await brain({ hooks }).call("redraw", { prompt: "x", image_path: "a.png", extend: { bottom: 0.5 }, remove_background: true });
    expect(hooks.ensured).toContain("remove-marks");
    const prompt = comfy.prompts.at(-1)!;
    const id = (cls: string) => Object.keys(prompt).find((k) => prompt[k].class_type === cls)!;
    // paste → marks → background, as on the generate tools
    expect(prompt[id("ComfyGenRemoveMarks")].inputs.images).toEqual([id("ComfyGenRedrawPaste"), 0]);
    expect(prompt[id("RemoveBackground")].inputs.image).toEqual([id("ComfyGenRemoveMarks"), 0]);
    await brain({ hooks }).call("redraw", { prompt: "x", image_path: "a.png", box: [0.1, 0.1, 0.5, 0.5] });
    expect(JSON.stringify(comfy.prompts.at(-1))).not.toContain("ComfyGenRemoveMarks");
    const off = new PathHooks();
    await brain({ hooks: off, cfg: { remove_marks: false } }).call("redraw", { prompt: "x", image_path: "a.png", extend: { bottom: 0.5 } });
    expect([off.ensured.includes("remove-marks"), JSON.stringify(comfy.prompts.at(-1)).includes("ComfyGenRemoveMarks")]).toEqual([false, false]);
  });

  it("takes extend as shares per side, missing sides 0", () => {
    expect(redrawExtend(undefined)).toBe("");
    expect(redrawExtend({ bottom: 0.5 })).toBe("0,0,0,0.5");
    expect(redrawExtend({ left: 0.333333, right: 0.25, top: null })).toBe("0.3333,0,0.25,0");
    expect((redrawExtend({ left: 256 }) as Failed).message).toMatch(/not pixels/);
    expect((redrawExtend({}) as Failed).message).toMatch(/adds nothing/);
    expect((redrawExtend([0.1, 0, 0.1, 0]) as Failed).message).toMatch(/\{left, top, right, bottom\}/);
  });

  it("takes the box as numbers or a string of them", () => {
    expect(redrawBox(undefined)).toBe("");
    expect(redrawBox("[0.25, 0.5, 0.75, 1]")).toBe("0.25,0.5,0.75,1");
    expect(redrawBox([-0.02, 0.1, 1.03, 0.333333])).toBe("0,0.1,1,0.3333"); // a little past an edge: clipped
  });

  it("a face the detector can't find comes back as the node's message", async () => {
    const { comfy, brain } = setup({ canRedraw: true });
    comfy.history = ["noface"];
    const out = await brain().call("redraw", { prompt: "x", image_path: "a.png" });
    expect((out as Failed).message).toContain("No face found in this image: pass a box around it instead.");
  });
});

describe("the hidden remove_background tool", () => {
  const classes = (prompt: Record<string, any>) => Object.values<any>(prompt).map((n) => n.class_type);

  it("cuts the stored image's background out, nothing repainted, and is never listed", async () => {
    const { comfy, brain } = setup({ canRemoveBackground: true, canCutout: true });
    const hooks = new PathHooks();
    const out = await brain({ hooks }).call("remove_background", { image_path: "a.png" });
    expect(out).toBeInstanceOf(Done);
    expect(hooks.ensured).toEqual(["remove-background"]);
    const prompt = comfy.prompts.at(-1)!;
    expect(classes(prompt).sort()).toEqual(["ComfyGenCutout", "LoadBackgroundRemovalModel", "LoadImage", "RemoveBackground", "SaveAnimatedWEBP"]);
    expect(Object.values<any>(prompt).find((n) => n.class_type === "LoadImage").inputs.image).toBe("a.png [output]");
    // without our node: ComfyUI's plain join
    await brain({ hooks: new PathHooks(), canCutout: false }).call("remove_background", { image_path: "a.png" });
    expect(classes(comfy.prompts.at(-1)!)).toContain("JoinImageWithAlpha");
    for (const mode of ["paths", "refs"] as const) expect(names(toolSpecs(BUILTIN, normalize({}), mode))).not.toContain("remove_background");
  });

  it("answers a bad call or a GPU that can't before any GPU time", async () => {
    const { comfy, brain } = setup({ canRemoveBackground: true });
    expect(((await brain().call("remove_background", {})) as Failed).message).toBe("an image is required.");
    expect(((await brain({ canRemoveBackground: false }).call("remove_background", { image: "x" })) as Failed).message).toBe(BACKGROUND_UNAVAILABLE);
    expect(comfy.prompts).toEqual([]);
  });
});
