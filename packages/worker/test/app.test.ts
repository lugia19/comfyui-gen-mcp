import { describe, expect, it } from "vitest";
import { fromBase64, fromHex, OutputImage, refs, utf8 } from "@comfy-gen/core";
import { png } from "../../core/test/fake-comfy.ts";
import { REQUEST_BUDGET, type App } from "../src/app.ts";
import { cacheEntry } from "../src/store.ts";
import * as updates from "../src/updates.ts";
import { ADMIN, COMFY, HOST, TOKEN, request, world } from "./world.ts";

const secretsOf = (app: App) => app.store.secrets();

async function mcp(app: App, method: string, params: unknown = {}, id = 1): Promise<[number, any]> {
  const s = await secretsOf(app);
  const resp = await app.handle(request("POST", `/mcp/${s.mcp_secret}`, { jsonrpc: "2.0", id, method, params }));
  const text = await resp.text();
  return [resp.status, text ? JSON.parse(text) : null];
}

const withGenerator = (app: App) => app.store.updateSecrets({ generator: { kind: "url", base_url: COMFY, headers: { "X-Test": "1" } } });
const withModal = (app: App) =>
  app.store.updateSecrets({ generator: { kind: "modal", base_url: COMFY, admin_url: ADMIN, headers: { "Modal-Key": "wk", "Modal-Secret": "ws" } } });

async function login(app: App): Promise<Record<string, string>> {
  const resp = await app.handle(request("POST", "/api/login", { token: TOKEN }));
  expect(resp.status).toBe(200);
  return { cookie: resp.headers.get("set-cookie")!.split(";")[0] };
}

const body = async (resp: Response) => JSON.parse(await resp.text());

describe("MCP", () => {
  it("needs the secret path and POST", async () => {
    const { app } = world();
    expect((await app.handle(request("POST", "/mcp/wrong", {}))).status).toBe(404);
    const s = await secretsOf(app);
    expect((await app.handle(request("GET", `/mcp/${s.mcp_secret}`))).status).toBe(405);
  });

  it("tools/list is in refs mode", async () => {
    const { app } = world();
    const [, r] = await mcp(app, "tools/list");
    const names = r.result.tools.map((t: any) => t.name);
    expect(names).toContain("request_upload");
    expect(names).toContain("edit_image");
    expect("image" in r.result.tools.find((t: any) => t.name === "edit_image").inputSchema.properties).toBe(true);
  });

  it("calls before setup explain what to do", async () => {
    const { app } = world();
    let [, r] = await mcp(app, "tools/call", { name: "generate_realistic_image", arguments: { prompt: "x" } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("not set up");
    [, r] = await mcp(app, "tools/call", { name: "no_such_tool" });
    expect(r.error.code).toBe(-32602);
  });

  it("generate returns inline WebP and an image id", async () => {
    const { app, net, comfy } = world();
    await withGenerator(app);
    const [, r] = await mcp(app, "tools/call", { name: "generate_realistic_image", arguments: { prompt: "a harbor" } });
    const [image, info] = r.result.content;
    expect([image.type, image.mimeType]).toEqual(["image", "image/webp"]);
    expect(fromBase64(image.data)).toEqual(comfy.viewBody);
    expect(comfy.calls.find((c) => c[1] === "/view")![2]!.preview).toBe("webp;90");
    const ref = info.text.split("image_id: ")[1].split("\n")[0];
    expect((await refs.verify(ref, fromHex((await secretsOf(app)).hmac_key))).filename).toBe("comfy-gen_00001_.png");
    expect(info.text).toContain("/img/" + ref);
    const comfyCalls = net.calls.filter((c) => c[1].startsWith(COMFY));
    expect(comfyCalls.every((c) => c[2]["X-Test"] === "1")).toBe(true); // generator headers on every call
    expect(comfyCalls.length).toBeLessThanOrEqual(REQUEST_BUDGET);
  });

  it("large results are re-requested smaller", async () => {
    const { app, comfy } = world();
    await withGenerator(app);
    comfy.viewBody = new Uint8Array([...utf8("RIFF\x00\x00\x00\x00WEBP"), ...new Uint8Array(800_000)]);
    await mcp(app, "tools/call", { name: "generate_realistic_image", arguments: { prompt: "x" } });
    expect(comfy.calls.filter((c) => c[1] === "/view").map((c) => c[2]!.preview)).toEqual(["webp;90", "webp;75"]);
  });

  it("upload round trip, then edit by id", async () => {
    const { app, clock, comfy } = world();
    await withGenerator(app);
    let [, r] = await mcp(app, "tools/call", { name: "request_upload", arguments: { filename: "cat.png" } });
    const snippet: string = r.result.content[0].text;
    expect(snippet).toContain("comfy-gen-upload"); // its own User-Agent
    const token = snippet.split("/upload/")[1].split("'")[0];
    const up = await app.handle(request("POST", `/upload/${token}`, png(640, 480)));
    expect(up.status).toBe(200);
    const imageId = (await body(up)).image_id;
    [, r] = await mcp(app, "tools/call", { name: "edit_image", arguments: { prompt: "add a hat", image: imageId } });
    expect(r.result.isError).toBe(false);
    const loads = Object.values<any>(comfy.prompts.at(-1)!).filter((n) => n.class_type === "LoadImage").map((n) => n.inputs.image);
    expect(loads[0]).toMatch(/^comfy-gen-uploads\/upload-.*\.png$/);

    clock.t += 3600; // the link expires
    expect((await app.handle(request("POST", `/upload/${token}`, png()))).status).toBe(403);
  });

  it("edit by URL downloads and sizes the input", async () => {
    const { app, comfy } = world();
    await withGenerator(app);
    let [, r] = await mcp(app, "tools/call", { name: "edit_image", arguments: { prompt: "x", image: "https://images.example/a.png" } });
    expect(r.result.isError).toBe(false);
    expect(comfy.uploads.length).toBeGreaterThan(0); // the URL's bytes went to ComfyUI
    [, r] = await mcp(app, "tools/call", { name: "edit_image", arguments: { prompt: "x", image: "forged.id" } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("image_id");
  });

  it("the image route streams full resolution", async () => {
    const { app, comfy } = world();
    await withGenerator(app);
    const ref = await refs.sign(new OutputImage("comfy-gen_00001_.png"), fromHex((await secretsOf(app)).hmac_key));
    const resp = await app.handle(request("GET", `/img/${ref}`));
    expect(resp.status).toBe(200);
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(comfy.viewBody);
    expect(comfy.calls.at(-1)![2]).not.toHaveProperty("preview");
    expect((await app.handle(request("GET", "/img/bogus"))).status).toBe(404);
  });

  it("fetch_result resumes", async () => {
    const { app, comfy } = world();
    await withGenerator(app);
    comfy.history = Array(200).fill("running"); // longer than one invocation's budget
    let [, r] = await mcp(app, "tools/call", { name: "generate_realistic_image", arguments: { prompt: "x" } });
    const txt: string = r.result.content[0].text;
    expect(txt).toContain("fetch_result");
    const token = txt.split("request_token '")[1].split("'")[0];
    comfy.history = [];
    [, r] = await mcp(app, "tools/call", { name: "fetch_result", arguments: { request_token: token } });
    expect(r.result.content[0].type).toBe("image");
  });
});

describe("settings API", () => {
  it("login with a token that sees this Worker", async () => {
    const { app, net } = world();
    expect((await app.handle(request("GET", "/api/state"))).status).toBe(401);
    const cookie = await login(app);
    const s = await secretsOf(app);
    expect([s.cf_account_id, s.cf_script, s.cf_branch, s.cf_trigger, s.cf_token]).toEqual(["acct1", "comfy-gen", "main", "trig1", TOKEN]);
    expect(net.calls.every((c) => c[2]["User-Agent"] === "comfy-gen-worker")).toBe(true); // every outbound call
    const state = await body(await app.handle(request("GET", "/api/state", undefined, cookie)));
    expect(state.generator).toBeNull();
    expect(state.cloudflare.script).toBe("comfy-gen");
    expect(state.connector_url.startsWith("https://comfy-gen.someone.workers.dev/mcp/")).toBe(true);
    expect(state.packs.some((g: any) => g.tool_name === "generate_illustrated_image")).toBe(true);
  });

  it("config is normalized on save", async () => {
    const { app } = world();
    const cookie = await login(app);
    const cfg = (await body(await app.handle(request("PUT", "/api/config", { config: { keep_warm_minutes: -3, extra: 1 } }, cookie)))).config;
    expect([cfg.keep_warm_minutes, cfg.extra]).toEqual([5, 1]);
  });

  it("settings pages read past the isolate cache", async () => {
    const { app, clock } = world();
    const before = { ...(await secretsOf(app)) }; // what another isolate may still have cached
    const cookie = await login(app);
    cacheEntry("secrets", [clock.t, before]);
    const state = await body(await app.handle(request("GET", "/api/state", undefined, cookie)));
    expect(state.cloudflare.script).toBe("comfy-gen");
  });

  it("login refuses other tokens", async () => {
    const { app, net } = world();
    expect((await app.handle(request("POST", "/api/login", {}))).status).toBe(400);
    net.scripts = { "someone-elses-worker": "tag9" }; // a token for another account
    let bad = await app.handle(request("POST", "/api/login", { token: "cfut_stranger" }));
    expect(bad.status).toBe(401);
    expect((await body(bad)).error).toContain("cannot see a Worker named comfy-gen");
    net.tokenStatus = "revoked";
    bad = await app.handle(request("POST", "/api/login", { token: "acct_token" }));
    expect(bad.status).toBe(401);
    expect((await body(bad)).error).toContain("My Profile");
    expect(bad.headers.get("set-cookie")).toBeNull();
    expect("cf_token" in (await secretsOf(app))).toBe(false);
  });

  it("dev login checks the named Worker", async () => {
    const { app, env } = world();
    env.DEV_WORKER_HOST = "comfy-gen.someone.workers.dev";
    const resp = await app.handle(request("POST", "/api/login", { token: TOKEN }, {}, "http://127.0.0.1:8788"));
    expect(resp.status).toBe(200);
  });

  it("a direct generator is probed before saving", async () => {
    const { app } = world();
    const cookie = await login(app);
    const bad = await app.handle(request("POST", "/api/setup/generator", { base_url: "https://nothing.example" }, cookie));
    expect(bad.status).toBe(502);
    expect((await secretsOf(app)).generator).toBeUndefined();
    const ok = await app.handle(request("POST", "/api/setup/generator", { base_url: COMFY + "/" }, cookie));
    expect((await body(ok)).system.comfyui_version).toBe("0.37.0");
    expect((await secretsOf(app)).generator).toEqual({ kind: "url", base_url: COMFY, headers: {} });
  });

  it("build and callback", async () => {
    const { app, net } = world();
    const cookie = await login(app);
    const resp = await app.handle(request("POST", "/api/setup/build", { modal_token_id: "ak-1", modal_token_secret: "as-1" }, cookie));
    expect(await body(resp)).toEqual({ build: "build1" });
    expect(net.buildVars.MODAL_TOKEN_SECRET).toEqual({ value: "as-1", is_secret: true });
    expect(net.buildVars.COMFY_GEN_CALLBACK.value).toBe("https://comfy-gen.someone.workers.dev/build-callback");
    const nonce = net.buildVars.COMFY_GEN_NONCE.value;

    const status = await body(await app.handle(request("GET", "/api/setup/build", undefined, cookie)));
    expect([status.lines, status.status]).toEqual([["hello", "world"], "running"]);

    expect((await app.handle(request("POST", "/build-callback", { nonce: "wrong" }))).status).toBe(403);
    const ok = await app.handle(
      request("POST", "/build-callback", {
        nonce, stage: "after-deploy", version: "v1.0.0",
        modal: { server_url: "https://m.modal.run", admin_url: ADMIN, proxy_token_id: "wk-1", proxy_token_secret: "ws-1" },
      }),
    );
    expect(ok.status).toBe(200);
    expect((await body(ok)).warnings).toEqual([]);
    const gen = (await secretsOf(app)).generator;
    expect([gen.kind, gen.headers, gen.admin_url]).toEqual(["modal", { "Modal-Key": "wk-1", "Modal-Secret": "ws-1" }, ADMIN]);
    // A deploy resets keep-warm, and a fresh install has no models: both are applied right away.
    expect(net.adminCalls).toContainEqual(["POST", "/idle", { seconds: 300 }]);
    const seeds = net.adminCalls.filter((c) => c[1] === "/seed");
    expect(seeds.map((c) => c[2].pack).sort()).toEqual(["anima_turbo", "flux2klein_edit", "z_image_turbo"]);
    expect(seeds.every((c) => c[2].models.length)).toBe(true);
  });
});

describe("Modal models", () => {
  it("the callback survives a cold admin API", async () => {
    const { app, net } = world();
    await app.store.updateSetup({ build_nonce: "n" });
    net.adminUp = false;
    const ok = await app.handle(request("POST", "/build-callback", { nonce: "n", modal: { server_url: "https://m", admin_url: ADMIN } }));
    expect(ok.status).toBe(200);
    expect((await body(ok)).warnings.length).toBe(4); // keep-warm + three packs
    expect((await secretsOf(app)).generator.kind).toBe("modal");
  });

  it("the models page reports and remembers ready packs", async () => {
    const { app, net } = world();
    await withModal(app);
    const cookie = await login(app);
    net.seedState = { anima_turbo: { state: "done", done: 9, total: 9 }, z_image_turbo: { state: "downloading", done: 1, total: 4 } };
    const list = (await body(await app.handle(request("GET", "/api/models", undefined, cookie)))).packs;
    const packs = Object.fromEntries(list.map((p: any) => [p.name, p]));
    expect([packs.anima_turbo.state, packs.z_image_turbo.done, packs.flux2klein_edit.state]).toEqual(["done", 1, "missing"]);
    expect(packs.anima_turbo.size).toBeGreaterThan(5e9);
    net.adminCalls = [];
    await app.handle(request("GET", "/api/models", undefined, cookie));
    expect(net.adminCalls.map((c) => c[1]).sort()).toEqual(["/seed/flux2klein_edit", "/seed/z_image_turbo"]); // anima is recorded
    const retry = await app.handle(request("POST", "/api/models/seed", { pack: "flux2klein_edit" }, cookie));
    expect((await body(retry)).started).toBe(true);
    const diag = await body(await app.handle(request("GET", "/api/modal/diagnostics", undefined, cookie)));
    expect(diag).toEqual({ status: { reload: { ok: true } }, files: { "vae/ae.safetensors": 3 } });
  });

  it("saving settings seeds new packs and applies keep-warm", async () => {
    const { app, net } = world();
    await withModal(app);
    const cookie = await login(app);
    await app.store.updateSetup({ seeded: ["anima_turbo", "z_image_turbo", "flux2klein_edit"] });
    const cfg = (await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).config;
    const resp = await app.handle(request("PUT", "/api/config", { config: cfg }, cookie));
    expect((await body(resp)).warnings).toEqual([]);
    expect(net.adminCalls).toEqual([]); // nothing changed
    cfg.pack_selections = { generate_realistic_image: "flux2klein_9b" };
    cfg.keep_warm_minutes = 15;
    await app.handle(request("PUT", "/api/config", { config: cfg }, cookie));
    expect(net.adminCalls).toContainEqual(["POST", "/idle", { seconds: 900 }]);
    expect(net.adminCalls.filter((c) => c[1] === "/seed").map((c) => c[2].pack)).toEqual(["flux2klein_9b"]);
  });

  it("a generation waits for its models", async () => {
    const { app, net, comfy } = world();
    await withModal(app);
    const args = { name: "generate_illustrated_image", arguments: { prompt: "x" } };
    let [, r] = await mcp(app, "tools/call", args);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("being downloaded");
    expect(r.result.content[0].text).toContain("https://comfy-gen.someone.workers.dev/");
    expect(net.seedState.anima_turbo.state).toBe("queued"); // the call started the download
    net.seedState.anima_turbo = { state: "downloading", done: 3, total: 4 };
    [, r] = await mcp(app, "tools/call", args);
    expect(r.result.content[0].text).toContain("(75%)");
    expect(comfy.prompts).toEqual([]);
    net.seedState.anima_turbo = { state: "done" };
    [, r] = await mcp(app, "tools/call", args);
    expect(r.result.content[0].type).toBe("image");
    net.adminCalls = [];
    await mcp(app, "tools/call", args);
    expect(net.adminCalls).toEqual([]); // ready packs cost no admin call
  });

  it("other generators never touch the admin API", async () => {
    const { app, net } = world();
    await withGenerator(app);
    const [, r] = await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "x" } });
    expect(r.result.content[0].type).toBe("image");
    expect(net.adminCalls).toEqual([]);
  });
});

describe("LoRAs", () => {
  const withUploads = (app: App) =>
    app.store.updateSecrets({
      generator: { kind: "modal", base_url: COMFY, admin_url: ADMIN, upload_url: "https://up.example/", headers: { "Modal-Key": "wk", "Modal-Secret": "ws" } },
    });

  it("the settings page lists, uploads through a session, and deletes LoRAs", async () => {
    const { app, net } = world();
    await withUploads(app);
    const cookie = await login(app);
    net.loras = { "old.safetensors": 5 };
    expect(await body(await app.handle(request("GET", "/api/loras", undefined, cookie)))).toEqual({ loras: { "old.safetensors": 5 } });

    const created = await body(await app.handle(request("POST", "/api/loras/uploads", { filename: "style.safetensors", size: 40 }, cookie)));
    expect(created).toEqual({ id: "u".repeat(43), chunk_size: 16, chunks: 3, upload_url: `https://up.example/u/${"u".repeat(43)}` });
    expect(net.adminCalls.at(-1)).toEqual(["POST", "/loras/uploads", { filename: "style.safetensors", size: 40, origin: `https://${HOST}` }]);
    const finish = await app.handle(request("POST", `/api/loras/uploads/${created.id}/finish`, undefined, cookie));
    expect(await body(finish)).toEqual({ state: "assembling" });
    expect(await body(await app.handle(request("GET", `/api/loras/uploads/${created.id}`, undefined, cookie)))).toEqual({ state: "assembling" });

    const bad = await app.handle(request("POST", "/api/loras/uploads", { filename: "x.ckpt", size: 1 }, cookie));
    expect([bad.status, (await body(bad)).error]).toEqual([400, "LoRA files must be .safetensors"]); // the admin API's message
    const gone = await app.handle(request("GET", "/api/loras/uploads/nope", undefined, cookie));
    expect(gone.status).toBe(404);

    const del = await app.handle(request("DELETE", "/api/loras/old.safetensors", undefined, cookie));
    expect(await body(del)).toEqual({ deleted: "old.safetensors" });
    expect((await app.handle(request("DELETE", "/api/loras/old.safetensors", undefined, cookie))).status).toBe(404);
    expect((await app.handle(request("GET", "/api/loras"))).status).toBe(401); // cookie required
  });

  it("uploads need a Modal app that has the upload endpoint", async () => {
    const { app } = world();
    await withModal(app); // deployed before M4: no upload_url
    const cookie = await login(app);
    const r = await app.handle(request("POST", "/api/loras/uploads", { filename: "a.safetensors", size: 1 }, cookie));
    expect(r.status).toBe(409);
    await withGenerator(app);
    expect((await app.handle(request("GET", "/api/loras", undefined, cookie))).status).toBe(400);
  });

  it("saving warns about LoRAs that are not uploaded", async () => {
    const { app, net } = world();
    await withUploads(app);
    const cookie = await login(app);
    await app.store.updateSetup({ seeded: ["anima_turbo", "z_image_turbo", "flux2klein_edit"] });
    net.loras = { "here.safetensors": 1 };
    const cfg = (await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).config;
    cfg.pack_loras = { anima: [{ name: "here.safetensors", trigger: "@a" }, { name: "gone.safetensors" }] };
    const resp = await body(await app.handle(request("PUT", "/api/config", { config: cfg }, cookie)));
    expect(resp.warnings).toEqual(["The LoRA gone.safetensors is not uploaded: generations will fail until it is."]);
    expect(resp.config.pack_loras.anima[0]).toEqual({ name: "here.safetensors", strength: 1, trigger: "@a", hidden: false });
    net.adminCalls = [];
    cfg.pack_loras = {};
    await app.handle(request("PUT", "/api/config", { config: cfg }, cookie));
    expect(net.adminCalls.some((c) => c[1] === "/loras")).toBe(false); // no LoRAs, no check
  });

  it("the settings page learns which packs take LoRAs", async () => {
    const { app } = world();
    const cookie = await login(app);
    const packs = (await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).packs.flatMap((g: any) => g.packs);
    expect(packs.filter((p: any) => p.supports_loras).map((p: any) => p.name).sort()).toEqual(["anima", "anima_turbo"]);
  });
});

describe("custom workflows", () => {
  const workflow = { "1": { class_type: "EmptyImage", inputs: {}, _meta: { title: "Prompt" } }, "2": { class_type: "SaveImage", inputs: {} } };

  it("are offered for a generator with the user's own nodes, not on Modal", async () => {
    const { app } = world();
    await app.store.saveConfig({ custom_workflow: { workflow, prompt_node_title: "Prompt" } });
    await withGenerator(app);
    const names = async () => (await mcp(app, "tools/list"))[1].result.tools.map((t: any) => t.name);
    expect(await names()).toContain("generate_custom_image");
    await withModal(app);
    expect(await names()).not.toContain("generate_custom_image");
    expect((await app.store.config()).custom_workflow).not.toBeNull(); // kept for the PC path
  });
});

describe("updates", () => {
  it("update check", async () => {
    const { app, net } = world();
    expect(await updates.check(net.fetch, app.store, "v0.9.0")).toContain("no Cloudflare token");
    await login(app);
    expect(await updates.check(net.fetch, app.store, "v1.0.0")).toContain("up to date");
    expect(await updates.check(net.fetch, app.store, "v0.9.0")).toContain("updating v0.9.0 -> v1.0.0");
    expect(await updates.check(net.fetch, app.store, "v0.9.0")).toContain("already tried");
    expect(net.buildsStarted.length).toBe(1);
    net.latestRelease = null; // no release yet: github.com redirects to the releases list
    expect(await updates.check(net.fetch, app.store, "v0.9.0")).toBe("no release found");
    expect(net.calls.at(-1)?.[1]).toBe("https://github.com/lugia19/comfyui-gen-mcp/releases/latest");
  });

  it("parseVersion", () => {
    expect(updates.parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(updates.parseVersion("dev")).toBeNull();
  });
});
