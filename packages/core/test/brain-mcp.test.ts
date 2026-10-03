import { describe, expect, it } from "vitest";
import { roundHalfEven } from "../src/bytes.ts";
import { Brain, DEFAULT_WAIT_S, Done, Failed, Hooks, Pending, type ResolvedImage } from "../src/brain.ts";
import { ComfyUIError, STILL_STARTING } from "../src/comfyui.ts";
import { McpHandler, PROTOCOL_VERSIONS, UnknownTool, type ToolCall } from "../src/mcp.ts";
import { builtinPacks, type Pack } from "../src/packs.ts";
import { toolSpecs } from "../src/tools.ts";
import { normalize } from "../src/config.ts";
import { FakeComfy, fastClient } from "./fake-comfy.ts";

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

function setup(opts: { cfg?: unknown; hooks?: Hooks; waitS?: number; budget?: number } = {}) {
  const comfy = new FakeComfy();
  const client = fastClient(comfy, { coldStartS: 60, requestBudget: opts.budget ?? null });
  const brain = (o: typeof opts = {}) =>
    new Brain(BUILTIN, o.cfg ?? opts.cfg ?? {}, client, "paths", {
      hooks: o.hooks ?? opts.hooks ?? new PathHooks(),
      waitS: o.waitS ?? opts.waitS,
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
    expect(client.time()).toBeLessThanOrEqual(DEFAULT_WAIT_S + 10);
  });
});

describe("brain", () => {
  it("generate returns Done", async () => {
    const { comfy, brain } = setup();
    const out = await brain().call("generate_realistic_image", { prompt: "a lighthouse", aspect_ratio: "wide" });
    expect(out).toBeInstanceOf(Done);
    expect((out as Done).promptId).toBe("p1");
    expect(Object.values<any>(comfy.prompts[0]).map((n) => n.inputs.text)).toContain("a lighthouse");
  });

  it("a timeout returns a stateless token, and fetch_result resumes", async () => {
    const { comfy, brain } = setup();
    comfy.history = Array(3).fill("running");
    // A ":lossless" from before results were WebP is ignored, on the aspect ratio and on the token.
    const out = await brain({ waitS: 0 }).call("generate_illustrated_image", { prompt: "x", aspect_ratio: "portrait:lossless" });
    expect(out).toBeInstanceOf(Pending);
    expect((out as Pending).token).toBe("p1");
    expect((out as Pending).text()).toContain("fetch_result");
    comfy.history = [];
    const again = await brain().call("fetch_result", { request_token: "p1:lossless" });
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

describe("mcp", () => {
  const TOOLS = [{ name: "echo", description: "d", inputSchema: { type: "object" } }];
  const call: ToolCall = async (name, args) => {
    if (name === "boom") throw new Error("kaput");
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
