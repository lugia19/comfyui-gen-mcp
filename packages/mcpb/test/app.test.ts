import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, Machine, ModelLocator, paths, saveConfig, type LocalComfy } from "@comfy-gen/local";
import { LocalApp, type Services } from "../src/server/app.ts";
import { LocalHooks, STILL_STARTING_HERE } from "../src/server/hooks.ts";
import { ComfyUIClient, type Pack, type Transport } from "@comfy-gen/core";

const PORT = 9247;

/** An app over a temporary home, a stub ComfyUI that is "stopped", and a web app of one page. */
function world(overrides: Partial<Services> = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcpb-"));
  const p = paths({ COMFY_GEN_HOME: home });
  const models = join(home, "comfyui", "models");
  mkdirSync(join(models, "loras"), { recursive: true });
  writeFileSync(join(models, "loras", "mine.safetensors"), "12345");
  const opened: string[] = [];
  const installs: string[] = [];
  let downloadsStarted = 0;
  // Discovery sees only this temporary home.
  const models_ = new ModelLocator(() => ({ models, comfy: join(home, "comfyui") }), () => "", { home, platform: "linux", env: {}, registry: join(home, "registry"), roots: [] });
  const comfy = {
    state: "stopped", url: null, error: null, install: { dir: join(home, "comfyui"), python: "py", gpu: "cpu", version: "0.37.0" }, models: models_,
    refresh: async () => {}, restart: async () => {}, stop: async () => {},
    nodeClasses: async () => new Set(["EmptyImage", "SaveImage"]),
    job: (fn: () => Promise<unknown>) => fn(),
  } as unknown as LocalComfy;
  const machine = new Machine({
    paths: p, settings: () => loadConfig(p.config), saveGpu: () => {}, waitExtension: "", comfy, openFolder: (path) => opened.push(path),
  });
  machine.startInstall = (gpu) => void installs.push(gpu);
  machine.detectedGpu = async () => "nvidia";
  const services: Services = {
    version: "1.2.3", port: PORT,
    config: () => loadConfig(p.config),
    saveConfig: (cfg) => (saveConfig(p.config, cfg), loadConfig(p.config)),
    machine, downloadSelected: () => void downloadsStarted++,
    web: (path) => (path === "/index.html" ? { body: new TextEncoder().encode("<html>app</html>"), type: "text/html" } : null),
    ...overrides,
  };
  const app = new LocalApp(services);
  const local = (path: string, init: RequestInit = {}, remote = "127.0.0.1") =>
    app.handle(new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { host: `127.0.0.1:${PORT}`, ...(init.headers as any) } }), remote);
  return { app, p, comfy, local, opened, installs, downloadsStarted: () => downloadsStarted, cfg: () => loadConfig(p.config) };
}

const rpc = (method: string, params: object = {}) => ({ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

describe("MCP route", () => {
  it("answers on the secret path only, from anywhere", async () => {
    const w = world();
    const secret = w.cfg().mcp_path;
    const listed = await (await w.local(secret, rpc("tools/list"), "192.168.1.20")).json();
    const names = listed.result.tools.map((t: any) => t.name);
    expect(names).toContain("generate_illustrated_image");
    expect(names).toContain("fetch_result");
    const edit = listed.result.tools.find((t: any) => t.name === "edit_image");
    expect(edit.inputSchema.required).toEqual(["prompt", "image_path"]); // paths mode
    expect((await w.local("/mcp/wrong", rpc("tools/list"))).status).toBe(404);
  });

  it("ignores a stored custom workflow (the feature was removed)", async () => {
    const w = world();
    saveConfig(w.p.config, { ...w.cfg(), custom_workflow: { workflow: { "1": { class_type: "EmptyImage", inputs: {} } } } });
    const listed = await (await w.local(w.cfg().mcp_path, rpc("tools/list"))).json();
    expect(listed.result.tools.map((t: any) => t.name)).not.toContain("generate_custom_image");
  });
});

describe("settings API", () => {
  it("answers only this machine's browser", async () => {
    const w = world();
    expect((await w.local("/api/state", {}, "192.168.1.20")).status).toBe(403);
    expect((await w.local("/", {}, "10.0.0.2")).status).toBe(403);
    // DNS rebinding: a loopback connection addressed to another name
    expect((await w.local("/api/state", { headers: { host: "evil.example:9247" } })).status).toBe(403);
    // a cross-site page posting to us
    expect((await w.local("/api/config", { method: "PUT", body: "{}", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await w.local("/api/state", { headers: { origin: `http://127.0.0.1:${PORT}` } })).status).toBe(200);
    expect(await (await w.local("/some/page")).text()).toBe("<html>app</html>");
  });

  it("reports local state", async () => {
    const w = world();
    const s = await (await w.local("/api/state")).json();
    expect(s.mode).toBe("local");
    expect(s.connector_url).toBe(`http://127.0.0.1:${PORT}${w.cfg().mcp_path}`);
    expect(s.comfyui).toMatchObject({ state: "stopped", gpu: "cpu", version: "0.37.0" });
    expect(s.detected_gpu).toBe("nvidia");
    expect(s.packs.length).toBeGreaterThan(0);
  });

  it("saves the config but not the secret path or port, and checks folders", async () => {
    const w = world();
    const before = w.cfg();
    const put = (config: object) => w.local("/api/config", { method: "PUT", body: JSON.stringify({ config }) });
    const r = await (await put({ keep_warm_minutes: 12, mcp_path: "/mcp/mine", mcp_port: 1, pack_loras: { anima: [{ name: "gone.safetensors" }] } })).json();
    expect(r.config.keep_warm_minutes).toBe(12);
    expect(r.config.mcp_path).toBe(before.mcp_path);
    expect(r.config.mcp_port).toBe(before.mcp_port);
    expect(r.warnings.join()).toContain("gone.safetensors");
    expect(w.downloadsStarted()).toBe(1); // saving starts the selected packs' downloads
    expect((await put({ extra_models_dir: "/no/such/dir" })).status).toBe(400);
    expect((await put({ comfyui_url: "ftp://x" })).status).toBe(400);
  });

  it("lists LoRAs, opens folders, starts installs", async () => {
    const w = world();
    // One way in: a LoRA dropped in the folder is not ours; an uploaded one is.
    expect((await (await w.local("/api/loras")).json()).loras).toEqual({});
    const up = await (await w.local("/api/loras/uploads", { method: "POST", body: JSON.stringify({ filename: "new.safetensors", size: 3 }) })).json();
    expect(up.upload_url).toBe(`/api/loras/uploads/${up.id}`);
    const sha = createHash("sha256").update("abc").digest("hex");
    expect((await w.local(`${up.upload_url}/0`, { method: "PUT", body: "abc", headers: { "X-Chunk-Sha256": sha } })).status).toBe(200);
    expect(await (await w.local(`${up.upload_url}/finish`, { method: "POST" })).json()).toEqual({ state: "done" });
    expect((await (await w.local("/api/loras")).json()).loras).toEqual({ "new.safetensors": 3 });
    expect((await w.local("/api/loras/mine.safetensors", { method: "DELETE" })).status).toBe(404); // not ours to delete
    expect((await w.local("/api/loras/new.safetensors", { method: "DELETE" })).status).toBe(200);
    await w.local("/api/open", { method: "POST", body: JSON.stringify({ which: "loras" }) });
    expect(w.opened[0]).toMatch(/models[\\/]loras$/);
    expect((await w.local("/api/setup/install", { method: "POST", body: JSON.stringify({ gpu: "quantum" }) })).status).toBe(400);
    await w.local("/api/setup/install", { method: "POST", body: JSON.stringify({ gpu: "intel" }) });
    expect(w.installs).toEqual(["intel"]);
  });

  it("lists LoRAs in use, also ones from before uploads; with your own ComfyUI they are typed in", async () => {
    const w = world();
    const put = (config: object) => w.local("/api/config", { method: "PUT", body: JSON.stringify({ config }) });
    // mine.safetensors sits in the LoRA folder; configured, it is in use, so ours.
    const r = await (await put({ pack_loras: { anima: [{ name: "mine.safetensors" }] } })).json();
    expect(r.warnings).toEqual([]);
    expect((await (await w.local("/api/loras")).json()).loras).toEqual({ "mine.safetensors": 5 });
    // Your own ComfyUI: its folders are not ours to see; no warnings, names are typed in.
    const own = await (await put({ comfyui_url: "http://127.0.0.1:8188", pack_loras: { anima: [{ name: "theirs.safetensors" }] } })).json();
    expect(own.warnings.join()).not.toContain("theirs.safetensors");
    expect(await (await w.local("/api/loras")).json()).toEqual({ loras: {}, external: true });
  });

  it("reports the selected packs' downloads", async () => {
    const w = world();
    const { packs } = await (await w.local("/api/models")).json();
    expect(packs.length).toBeGreaterThan(0);
    expect(packs[0]).toMatchObject({ state: "missing" });
  });
});

describe("start-up within the call's time", () => {
  const client = () => new ComfyUIClient({} as Transport);
  const hooks = (ensurePack: () => Promise<void>, c = client()) => new LocalHooks({ ensurePack } as unknown as Machine, c, "http://127.0.0.1:9247/");

  it("answers 'still starting' when ComfyUI's launch outlasts the call; the launch goes on", async () => {
    let done = false;
    const c = client();
    c.stopBy = c.time() + 0.05;
    const launch = () => new Promise<void>((r) => setTimeout(() => ((done = true), r()), 300));
    await expect(hooks(launch, c).ensure({} as Pack)).rejects.toThrow(STILL_STARTING_HERE);
    expect(done).toBe(false);
    await new Promise((r) => setTimeout(r, 350));
    expect(done).toBe(true);
  });

  it("waits for a launch that fits, and a failure after it stopped waiting goes unreported (no crash)", async () => {
    const c = client();
    c.stopBy = c.time() + 5;
    await hooks(() => new Promise((r) => setTimeout(r, 20)), c).ensure({} as Pack);
    c.stopBy = c.time() + 0.02;
    await expect(hooks(() => new Promise((_, no) => setTimeout(() => no(new Error("later")), 100)), c).ensure({} as Pack)).rejects.toThrow(STILL_STARTING_HERE);
    await new Promise((r) => setTimeout(r, 150)); // an unhandled rejection would fail the run
  });
});
