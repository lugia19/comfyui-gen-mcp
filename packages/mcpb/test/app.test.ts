import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, ModelDownloads, paths, saveConfig, type LocalComfy } from "@comfy-gen/local";
import { LocalApp, type InstallState, type Services } from "../src/server/app.ts";

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
  const comfy = {
    state: "stopped", url: null, error: null, install: { dir: join(home, "comfyui"), python: "py", gpu: "cpu", version: "0.37.0" },
    refresh: async () => {}, restart: async () => {}, stop: async () => {},
    job: (fn: () => Promise<unknown>) => fn(),
  } as unknown as LocalComfy;
  const installState: InstallState = { state: "idle", gpu: null, lines: [], error: null };
  const services: Services = {
    paths: p, version: "1.2.3", port: PORT,
    config: () => loadConfig(p.config),
    saveConfig: (cfg) => (saveConfig(p.config, cfg), loadConfig(p.config)),
    comfy, downloads: new ModelDownloads(() => [models]), modelDirs: () => [models],
    install: { state: () => installState, start: (gpu) => installs.push(gpu) },
    detectedGpu: async () => "nvidia",
    web: (path) => (path === "/index.html" ? { body: new TextEncoder().encode("<html>app</html>"), type: "text/html" } : null),
    openFolder: (path) => opened.push(path),
    ...overrides,
  };
  const app = new LocalApp(services);
  const local = (path: string, init: RequestInit = {}, remote = "127.0.0.1") =>
    app.handle(new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { host: `127.0.0.1:${PORT}`, ...(init.headers as any) } }), remote);
  return { app, p, local, opened, installs, cfg: () => loadConfig(p.config) };
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

  it("offers the custom workflow tool when one is set", async () => {
    const w = world();
    saveConfig(w.p.config, { ...w.cfg(), custom_workflow: { workflow: { "1": { class_type: "EmptyImage", inputs: {}, _meta: { title: "Prompt" } } }, prompt_node_title: "Prompt" } });
    const listed = await (await w.local(w.cfg().mcp_path, rpc("tools/list"))).json();
    expect(listed.result.tools.map((t: any) => t.name)).toContain("generate_custom_image");
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
    expect((await put({ extra_models_dir: "/no/such/dir" })).status).toBe(400);
    expect((await put({ comfyui_url: "ftp://x" })).status).toBe(400);
  });

  it("lists LoRAs, opens folders, starts installs", async () => {
    const w = world();
    expect((await (await w.local("/api/loras")).json()).loras).toEqual({ "mine.safetensors": 5 });
    await w.local("/api/open", { method: "POST", body: JSON.stringify({ which: "loras" }) });
    expect(w.opened[0]).toMatch(/models[\\/]loras$/);
    expect((await w.local("/api/setup/install", { method: "POST", body: JSON.stringify({ gpu: "quantum" }) })).status).toBe(400);
    await w.local("/api/setup/install", { method: "POST", body: JSON.stringify({ gpu: "intel" }) });
    expect(w.installs).toEqual(["intel"]);
  });

  it("reports the selected packs' downloads", async () => {
    const w = world();
    const { packs } = await (await w.local("/api/models")).json();
    expect(packs.length).toBeGreaterThan(0);
    expect(packs[0]).toMatchObject({ state: "missing" });
  });
});
