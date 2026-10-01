import { describe, expect, it } from "vitest";
import { fromBase64, fromHex, OutputImage, refs, utf8 } from "@comfy-gen/core";
import { png } from "../../core/test/fake-comfy.ts";
import { REQUEST_BUDGET, type App } from "../src/app.ts";
import { PC_OFFLINE } from "../src/hooks.ts";
import { cacheEntry } from "../src/store.ts";
import * as updates from "../src/updates.ts";
import golden from "../../core/test/golden.json" with { type: "json" };
import { makeSession, sessionOk } from "../src/auth.ts";
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

  it("setup's last step: Claude listing the tools marks it connected, until the URL changes", async () => {
    const { app } = world();
    const cookie = await login(app);
    const seen = async () => (await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).claude_seen;
    expect(await seen()).toBeNull();
    await mcp(app, "initialize", { protocolVersion: "2025-06-18" });
    expect(await seen()).toBeNull(); // only tools/list counts
    await mcp(app, "tools/list");
    const first = await seen();
    expect(first).toBeGreaterThan(0);
    await mcp(app, "tools/list");
    expect(await seen()).toBe(first);
    await app.handle(request("POST", "/api/setup/rotate-connector", undefined, cookie));
    expect(await seen()).toBeNull();
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
    expect(await refs.verify(ref, fromHex((await secretsOf(app)).hmac_key))).toMatchObject({ image: { filename: "comfy-gen_00001_.png" }, backend: "main" });
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
    // The input keeps its size: its pixels, not the pack's 4 MP budget (768×768 came back 2048×2048).
    comfy.viewBody = png(640, 480); // what /view answers for the uploaded file
    [, r] = await mcp(app, "tools/call", { name: "edit_image", arguments: { prompt: "add a hat", image: imageId } }, 2);
    const scale2 = Object.values<any>(comfy.prompts.at(-1)!).find((n) => n.class_type === "ImageScaleToTotalPixels");
    expect(scale2.inputs.megapixels).toBeCloseTo((640 * 480) / 1_048_576, 3);
    expect(comfy.calls.some(([, path, params]) => path === "/view" && params?.preview === "webp;1")).toBe(true);

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

  it("a failed Modal deploy shows its reason, and Try again reuses the stored token", async () => {
    const { app, net } = world();
    const cookie = await login(app);
    await app.handle(request("POST", "/api/setup/build", { modal_token_id: "ak-1", modal_token_secret: "as-1" }, cookie));
    let nonce = net.buildVars.COMFY_GEN_NONCE.value;
    const reason = "Please add a payment method to use L4 GPU functions.";
    await app.handle(request("POST", "/build-callback", { nonce, stage: "deployed", modal_result: "failed (exit 1)", modal_error: reason }));
    const state = async () => body(await app.handle(request("GET", "/api/state", undefined, cookie)));
    expect([(await state()).modal_error, (await state()).generator]).toEqual([reason, null]);

    // Try again: no token fields, so the stored ones stay; only the nonce changes.
    const retry = await app.handle(request("POST", "/api/setup/build", {}, cookie));
    expect((await body(retry)).build).toBe("build2");
    expect(net.buildVars.MODAL_TOKEN_SECRET).toEqual({ value: "as-1", is_secret: true });
    expect(net.buildVars.COMFY_GEN_NONCE.value).not.toBe(nonce);
    expect((await state()).modal_error).toBeNull(); // hidden while the new build runs
    nonce = net.buildVars.COMFY_GEN_NONCE.value;
    await app.handle(request("POST", "/build-callback", { nonce, stage: "deployed", modal_result: "failed (exit 1)" }));
    expect((await state()).modal_error).toBe("failed (exit 1)"); // no reason came: the result, at least
    await app.handle(request("POST", "/build-callback", { nonce, modal: { server_url: "https://m.modal.run", admin_url: ADMIN } }));
    expect([(await state()).modal_error, (await state()).generator.kind]).toEqual([null, "modal"]);
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
    const models = await body(await app.handle(request("GET", "/api/models", undefined, cookie)));
    expect(models.backends).toEqual(["modal"]);
    const packs = Object.fromEntries(models.packs.map((p: any) => [p.name, p.on.modal]));
    expect([packs.anima_turbo.state, packs.z_image_turbo.done, packs.flux2klein_edit.state]).toEqual(["done", 1, "missing"]);
    expect(models.packs[0].size).toBeGreaterThan(5e9);
    net.adminCalls = [];
    await app.handle(request("GET", "/api/models", undefined, cookie));
    expect(net.adminCalls.map((c) => c[1]).sort()).toEqual(["/seed/flux2klein_edit", "/seed/z_image_turbo"]); // anima is recorded
    const retry = await app.handle(request("POST", "/api/models/seed", { pack: "flux2klein_edit", backend: "modal" }, cookie));
    expect((await body(retry)).started).toBe(true);
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
    expect(await body(await app.handle(request("GET", "/api/loras", undefined, cookie)))).toEqual({
      backends: ["modal"], files: { "old.safetensors": { modal: 5 } }, syncing: {}, errors: {}, offline: [],
    });

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
    expect(await body(del)).toEqual({ deleted: "old.safetensors", from: ["modal"], errors: [] });
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
    const listing = await body(await app.handle(request("GET", "/api/loras", undefined, cookie)));
    expect(listing).toMatchObject({ backends: ["url"], files: {} }); // a ComfyUI by URL has no listing
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
    expect(resp.warnings).toEqual(["The LoRA gone.safetensors is not on your Modal Volume: generations will fail until it is."]);
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

describe("custom workflows (removed)", () => {
  it("a stored custom workflow adds no tool and is forgotten on the next save", async () => {
    const { app } = world();
    const workflow = { "1": { class_type: "EmptyImage", inputs: {} } };
    await app.store.saveConfig({ custom_workflow: { workflow } });
    await withGenerator(app);
    const names = (await mcp(app, "tools/list"))[1].result.tools.map((t: any) => t.name);
    expect(names).not.toContain("generate_custom_image");
    expect("custom_workflow" in (await app.store.config())).toBe(false);
  });
});

describe("session cookies", () => {
  it("match the v0 vectors, so existing logins survive", async () => {
    for (const v of (golden as any).sessions) {
      expect(await makeSession(v.cookie_key, v.now)).toBe(v.value);
      expect(await sessionOk(v.value, v.cookie_key, v.now + 60)).toBe(true);
      expect(await sessionOk(v.value.replace(/.$/, (c: string) => (c === "0" ? "1" : "0")), v.cookie_key, v.now)).toBe(false);
    }
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

  it("the settings page can update now", async () => {
    const { app, net, env } = world();
    env.VERSION = "v0.9.0";
    const cookie = await login(app);
    const info = await body(await app.handle(request("GET", "/api/update", undefined, cookie)));
    expect(info).toEqual({ current: "v0.9.0", latest: "v1.0.0", newer: true, can: true, build: null, building: false });
    const started = await body(await app.handle(request("POST", "/api/update", undefined, cookie)));
    expect(started).toEqual({ build: "build1", latest: "v1.0.0" });
    expect((await app.store.setup()).update_build).toBe("build1");
    expect((await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).update_build).toBe("build1");
    // Again on demand, though the daily check would not retry a release it already tried.
    await app.handle(request("POST", "/api/update", undefined, cookie));
    expect(net.buildsStarted.length).toBe(2);
    expect((await body(await app.handle(request("GET", "/api/update", undefined, cookie)))).building).toBe(true);
    env.VERSION = "v1.0.0"; // the build deployed it
    net.buildState = "stopped";
    const done = await body(await app.handle(request("GET", "/api/update", undefined, cookie)));
    expect([done.newer, done.building]).toEqual([false, false]);
    expect((await app.store.setup()).update_finished).toBe("build2");
    // The next release: the button comes back (not hidden by the finished build), and the
    // finished build is not asked about again.
    net.latestRelease = "v1.1.0";
    const calls = net.buildStatusCalls;
    const next = await body(await app.handle(request("GET", "/api/update", undefined, cookie)));
    expect([next.newer, next.building, net.buildStatusCalls]).toEqual([true, false, calls]);
    expect((await app.handle(request("POST", "/api/update"))).status).toBe(401); // cookie required
  });

  it("parseVersion", () => {
    expect(updates.parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(updates.parseVersion("dev")).toBeNull();
  });
});

describe("the PC path", () => {
  const ws = (secret: string) => request("GET", "/agent", undefined, { upgrade: "websocket", authorization: `Bearer ${secret}` });
  const pair = async (app: App) => {
    const cookie = await login(app);
    const { link } = await body(await app.handle(request("POST", "/api/pc/pair", undefined, cookie)));
    return { cookie, link: link as string, secret: (link as string).split("#")[1] };
  };
  const toolText = (r: any) => r.result.content.map((c: any) => c.text ?? `[${c.type}]`).join(" ");

  it("pairs with a link, which is what opens the relay, until unpaired or re-paired", async () => {
    const { app, pc } = world();
    expect(await app.agentRefusal(ws("anything"))).not.toBeNull(); // nothing paired
    const { cookie, link, secret } = await pair(app);
    expect(link).toBe(`https://${HOST}/agent#${secret}`);
    expect(secret.length).toBeGreaterThan(40);
    expect(await app.agentRefusal(ws(secret))).toBeNull();
    expect((await app.agentRefusal(ws("wrong")))!.status).toBe(401);
    expect((await app.agentRefusal(request("GET", "/agent", undefined, { authorization: `Bearer ${secret}` })))!.status).toBe(426);
    const state = await body(await app.handle(request("GET", "/api/state", undefined, cookie)));
    expect(state.pc).toMatchObject({ paired: true, connected: true, link, info: { gpu: "nvidia" } });

    const second = await pair(app); // a new link replaces the old one and disconnects that PC
    expect(await app.agentRefusal(ws(secret))).not.toBeNull();
    expect(pc.dropped).toBe(2);
    await app.handle(request("DELETE", "/api/pc", undefined, second.cookie));
    expect(await app.agentRefusal(ws(second.secret))).not.toBeNull();
    expect((await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).pc).toEqual({ paired: false });
  });

  it("one config serves every backend; saving applies it to the PC too", async () => {
    const { app, pc } = world();
    await withModal(app);
    await app.store.updateSetup({ seeded: ["anima_turbo", "z_image_turbo", "flux2klein_edit"] });
    const { cookie } = await pair(app);
    const state = async () => body(await app.handle(request("GET", "/api/state", undefined, cookie)));
    expect((await state()).pc_config).toBeUndefined();
    const cfg = { ...(await state()).config, pack_settings: { anima: { artist_list: "@one_artist" } }, keep_warm_minutes: 7, pc_keep_warm_minutes: 12 };

    const put = await body(await app.handle(request("PUT", "/api/config", { config: cfg }, cookie)));
    expect(put.warnings).toEqual([]);
    expect(pc.controlCalls.filter(([op]) => op === "download").length).toBe(3); // the PC downloads the selected packs
    expect(pc.controlCalls.at(-1)![0]).toBe("sync"); // and copies LoRAs

    const illustrated = async () => (await mcp(app, "tools/list"))[1].result.tools.find((t: any) => t.name === "generate_illustrated_image").description;
    expect(await illustrated()).toContain("@one_artist");

    pc.controlCalls.length = 0;
    await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a cat" } });
    expect(pc.controlCalls.find(([op]) => op === "ensure")![1].keep_warm_minutes).toBe(12); // the PC's keep-warm

    pc.connected = false; // saving while the PC is off: a warning, and no wait for it
    pc.controlCalls.length = 0;
    const off = await body(await app.handle(request("PUT", "/api/config", { config: cfg }, cookie)));
    expect([off.warnings, off.notes]).toEqual([[], []]); // the page shows the PC offline already
    expect(pc.controlCalls).toEqual([]);
  });

  it("warns only about LoRAs that no backend has", async () => {
    const { app, net, pc } = world();
    await app.store.updateSecrets({
      generator: { kind: "modal", base_url: COMFY, admin_url: ADMIN, upload_url: "https://up.example/", headers: {} },
    });
    await app.store.updateSetup({ seeded: ["anima_turbo", "z_image_turbo", "flux2klein_edit"] });
    const { cookie } = await pair(app);
    net.loras = { "modal.safetensors": 1 };
    pc.controls.loras = () => [200, { files: { "pc.safetensors": 2 }, syncing: {} }];
    const cfg = (await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).config;
    cfg.pack_loras = { anima: [{ name: "modal.safetensors" }, { name: "pc.safetensors" }, { name: "gone.safetensors" }] };
    const resp = await body(await app.handle(request("PUT", "/api/config", { config: cfg }, cookie)));
    expect(resp.warnings).toEqual(["The LoRA gone.safetensors is not on your PC or your Modal Volume: generations will fail until it is."]);
  });

  it("the agent's LoRA sync: push what only the PC has, pull what only Modal has", async () => {
    const { app, net } = world();
    await app.store.updateSecrets({
      generator: { kind: "modal", base_url: COMFY, admin_url: ADMIN, upload_url: "https://up.example/", headers: {} },
    });
    const { secret } = await pair(app);
    const sync = (loras: unknown, auth = secret) =>
      app.handle(request("POST", "/agent/sync", { loras }, { authorization: `Bearer ${auth}` }));
    expect((await sync({}, "wrong")).status).toBe(401);
    expect(await body(await sync({}))).toEqual({ push: [], pull: [], errors: [] }); // no LoRAs anywhere

    net.loras = { "modal.safetensors": 30, "both.safetensors": 1, "unused.safetensors": 9 };
    await app.store.saveConfig({ pack_loras: { anima: [{ name: "modal.safetensors" }, { name: "pc.safetensors" }, { name: "both.safetensors" }, { name: "nowhere.safetensors" }] } });
    // PC files: pushed only when some pack uses them (mine.safetensors is not).
    const plan = await body(await sync({ "pc.safetensors": 40, "both.safetensors": 1, "mine.safetensors": 5 }));
    expect(plan.push).toEqual([{ name: "pc.safetensors", size: 40, upload_url: `https://up.example/u/${"u".repeat(43)}`, chunk_size: 16, chunks: 3 }]);
    // Every Volume LoRA the PC lacks, used or not: they all came in through an upload.
    const pullUrl = `https://up.example/d/${"d".repeat(43)}`;
    expect(plan.pull).toEqual([{ name: "modal.safetensors", size: 30, url: pullUrl }, { name: "unused.safetensors", size: 9, url: pullUrl }]);
    expect(plan.errors).toEqual([]);
    expect(net.adminCalls.find((c) => c[1] === "/loras/uploads")![2].origin).toBe(`https://${HOST}`);

    await withGenerator(app); // no Modal: nothing to copy
    expect(await body(await sync({ "pc.safetensors": 40 }))).toEqual({ push: [], pull: [], errors: [] });
  });

  it("generates on the PC when it is online, on Modal when it is not", async () => {
    const { app, pc, comfy, net } = world();
    await withModal(app);
    await pair(app);
    const [, onPc] = await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a cat" } });
    expect(onPc.result.isError).toBe(false);
    expect(pc.comfy.prompts.length).toBe(1);
    expect(comfy.prompts.length).toBe(0);
    expect(pc.controlCalls[0][0]).toBe("ensure");
    expect(pc.controlCalls[0][1]).toMatchObject({ pack: { name: expect.any(String), models: expect.any(Array) }, keep_warm_minutes: 5 });

    pc.connected = false;
    const [, onModal] = await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a dog" } }, 2);
    // Modal's hooks answered (its models are not on the Volume in this fixture); the PC was not used
    expect(toolText(onModal)).toContain("being downloaded to your GPU");
    expect(pc.comfy.prompts.length).toBe(1);
    expect(net.adminCalls.length).toBeGreaterThan(0);
  });

  it("image ids name their backend: the PC's first image and the main generator's don't collide", async () => {
    const { app, pc, comfy } = world();
    await withGenerator(app);
    await pair(app);
    const key = fromHex((await secretsOf(app)).hmac_key);
    const fox = png(64, 32);
    const girl = png(32, 64);
    pc.comfy.viewBody = fox;
    comfy.viewBody = girl;
    const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());
    const idOf = (r: any) => r.result.content.find((c: any) => c.text?.includes("image_id: ")).text.split("image_id: ")[1].split("\n")[0];

    const [, onPc] = await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a fox" } });
    pc.connected = false;
    const [, onMain] = await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a girl" } }, 2);
    const [pcId, mainId] = [idOf(onPc), idOf(onMain)];
    // Both ComfyUIs named their first output comfy-gen_00001_.png; the ids still differ.
    expect((await refs.verify(pcId, key)).image).toEqual((await refs.verify(mainId, key)).image);
    expect(pcId).not.toBe(mainId);
    // Ids from before the PC existed are the main generator's.
    expect(mainId).toBe(await refs.sign(new OutputImage("comfy-gen_00001_.png", "", "output"), key));

    pc.connected = true; // /img/ serves each from its own backend, whichever answers calls now
    expect(await bytes(await app.handle(request("GET", `/img/${pcId}`)))).toEqual(fox);
    expect(await bytes(await app.handle(request("GET", `/img/${mainId}`)))).toEqual(girl);

    // Editing the main generator's image while the PC answers copies it to the PC first.
    const uploads = pc.comfy.uploads.length;
    const [, edited] = await mcp(app, "tools/call", { name: "edit_image", arguments: { prompt: "at night", image: mainId } }, 3);
    expect(edited.result.isError).toBe(false);
    expect(pc.comfy.uploads.length).toBe(uploads + 1);
    const sent = pc.comfy.uploads.at(-1)!;
    expect(Buffer.from(sent).includes(Buffer.from(girl))).toBe(true); // the main generator's image, copied

    // A PC image edited while the PC is off: the main generator cannot fetch it, and says so.
    pc.connected = false;
    const [, stuck] = await mcp(app, "tools/call", { name: "edit_image", arguments: { prompt: "at night", image: pcId } }, 4);
    expect(stuck.result.isError).toBe(true);
    expect(toolText(stuck)).toContain("on your PC");
  });

  it("a PC paused from its tray takes no requests: Modal answers, or the tools say it is paused", async () => {
    const { app, pc, comfy } = world();
    const { cookie } = await pair(app);
    pc.paused = true;
    const [, alone] = await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a cat" } });
    expect(alone.result.isError).toBe(true);
    expect(toolText(alone)).toContain("Your PC is paused");
    expect(pc.comfy.prompts.length).toBe(0);
    const state = await body(await app.handle(request("GET", "/api/state", undefined, cookie)));
    expect(state.pc).toMatchObject({ connected: true, info: { paused: true } }); // shown as paused, not offline

    await withGenerator(app); // with another generator, it answers instead
    const [, other] = await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a cat" } }, 2);
    expect(other.result.isError).toBe(false);
    expect(comfy.prompts.length).toBe(1);
    pc.paused = false;
    await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a cat" } }, 3);
    expect(pc.comfy.prompts.length).toBe(1); // back on the PC
  });

  it("says the PC is offline when there is nothing else, and passes the agent's errors on", async () => {
    const { app, pc } = world();
    await pair(app);
    pc.connected = false;
    const [, off] = await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a cat" } });
    expect(off.result.isError).toBe(true);
    expect(toolText(off)).toContain("Your PC is offline");
    pc.connected = true;
    pc.controls.ensure = () => [500, "The Anima model is downloading: 12% of 5.6 GB."];
    const [, dl] = await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a cat" } }, 2);
    expect(toolText(dl)).toContain("downloading: 12%");
  });

  it("uploads LoRAs to the PC through the relay when there is no Modal", async () => {
    const { app, pc } = world();
    const { cookie } = await pair(app);
    const got: any[] = [];
    pc.controls.upload_start = (args) => [200, { id: "s".repeat(43), chunk_size: 4, chunks: 2, echo: args }];
    pc.controls.upload_chunk = (args, chunk) => (got.push([args, [...(chunk ?? [])]]), args.sha256 === "bad" ? [400, "chunk 0 checksum mismatch"] : [200, { ok: true }]);
    pc.controls.upload_finish = () => [200, { state: "done" }];
    pc.controls.upload_status = () => [200, { state: "done" }];
    const started = await body(await app.handle(request("POST", "/api/pc/loras/uploads", { filename: "a.safetensors", size: 6 }, cookie)));
    expect(started).toMatchObject({ id: "s".repeat(43), chunks: 2, upload_url: `/api/pc/loras/uploads/${"s".repeat(43)}`, echo: { filename: "a.safetensors", size: 6 } });
    const put = (sha: string) =>
      app.handle(new Request(`https://${HOST}${started.upload_url}/1`, { method: "PUT", body: new Uint8Array([7, 8]), headers: { ...cookie, "X-Chunk-Sha256": sha } }));
    expect((await put("abc")).status).toBe(200);
    expect(got[0]).toEqual([{ id: "s".repeat(43), index: 1, sha256: "abc" }, [7, 8]]); // the chunk rides as the body
    const bad = await put("bad");
    expect([bad.status, (await body(bad)).error]).toEqual([400, "chunk 0 checksum mismatch"]); // the agent's status
    expect(await body(await app.handle(request("POST", `${started.upload_url}/finish`, undefined, cookie)))).toEqual({ state: "done" });
    pc.connected = false;
    expect((await app.handle(request("GET", started.upload_url, undefined, cookie))).status).toBe(503);
  });

  it("pauses and resumes the PC from the page", async () => {
    const { app, pc } = world();
    const { cookie } = await pair(app);
    pc.controls.pause = (args) => ((pc.paused = args.paused), [200, { paused: args.paused }]);
    expect(await body(await app.handle(request("POST", "/api/pc/pause", { paused: true }, cookie)))).toEqual({ paused: true });
    expect((await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).pc.info.paused).toBe(true);
    await app.handle(request("POST", "/api/pc/pause", { paused: false }, cookie));
    expect(pc.paused).toBe(false);
    pc.connected = false;
    expect((await app.handle(request("POST", "/api/pc/pause", { paused: true }, cookie))).status).toBe(503);
  });

  it("deletes a LoRA everywhere, and nudges the agent's sync after an upload", async () => {
    const { app, pc, net } = world();
    await app.store.updateSecrets({
      generator: { kind: "modal", base_url: COMFY, admin_url: ADMIN, upload_url: "https://up.example/", headers: {} },
    });
    const { cookie } = await pair(app);
    net.loras = { "x.safetensors": 1 };
    pc.controls.lora_delete = (args) => (args.name === "x.safetensors" ? [200, { deleted: args.name }] : [404, "no LoRA"]);
    pc.controls.sync = () => [200, { started: true }];
    const del = await body(await app.handle(request("DELETE", "/api/loras/x.safetensors", undefined, cookie)));
    expect(del).toEqual({ deleted: "x.safetensors", from: ["modal", "pc"], errors: [] });
    expect((await app.handle(request("DELETE", "/api/loras/nope.safetensors", undefined, cookie))).status).toBe(404);
    expect(await body(await app.handle(request("POST", "/api/loras/sync", undefined, cookie)))).toEqual({ started: true });
    expect(pc.controlCalls.at(-1)![0]).toBe("sync");
    pc.connected = false;
    expect(await body(await app.handle(request("POST", "/api/loras/sync", undefined, cookie)))).toEqual({ started: false });
  });

  it("shows the PC's LoRA files and model downloads beside Modal's", async () => {
    const { app, pc, net } = world();
    await withModal(app);
    await app.store.updateSetup({ seeded: ["anima_turbo", "z_image_turbo", "flux2klein_edit"] });
    const { cookie } = await pair(app);
    net.loras = { "both.safetensors": 7 };
    pc.controls.loras = () => [200, { files: { "mine.safetensors": 123, "both.safetensors": 7 }, syncing: { "x.safetensors": { to: "pc", done: 1, total: 2 } } }];
    pc.controls.models = (args) => [200, args.packs.map((p: any) => ({ name: p.name, state: "downloading", done: 1, total: 4 }))];
    pc.controls.download = (args) => [200, { state: "queued", done: 0, total: args.pack.models.length }];
    expect(await body(await app.handle(request("GET", "/api/loras", undefined, cookie)))).toEqual({
      backends: ["pc", "modal"],
      files: { "mine.safetensors": { pc: 123 }, "both.safetensors": { pc: 7, modal: 7 } },
      syncing: { "x.safetensors": { to: "pc", done: 1, total: 2 } },
      errors: {},
      offline: [],
    });
    const models = await body(await app.handle(request("GET", "/api/models", undefined, cookie)));
    expect(models.backends).toEqual(["pc", "modal"]);
    expect(models.packs[0]).toMatchObject({ on: { pc: { state: "downloading", total: 4 }, modal: { state: "done" } }, size: expect.any(Number) });
    const onlyModal = await body(await app.handle(request("GET", "/api/models?backend=modal", undefined, cookie)));
    expect([onlyModal.backends, onlyModal.packs[0].on]).toEqual([["modal"], { modal: { state: "done" } }]);
    const seeded = await app.handle(request("POST", "/api/models/seed", { pack: models.packs[0].name, backend: "pc" }, cookie));
    expect((await body(seeded)).state).toBe("queued");

    pc.connected = false; // offline: listed as such at once, not waited for
    pc.controlCalls.length = 0;
    const loras = await body(await app.handle(request("GET", "/api/loras", undefined, cookie)));
    expect([loras.offline, loras.errors, loras.files]).toEqual([["pc"], {}, { "both.safetensors": { modal: 7 } }]);
    expect((await body(await app.handle(request("GET", "/api/models", undefined, cookie)))).packs[0].on.pc).toEqual({ state: "offline" });
    expect(pc.controlCalls).toEqual([]);
  });
});
