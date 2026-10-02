import { describe, expect, it } from "vitest";
import { fromBase64, fromHex, OutputImage, refs, utf8 } from "@comfy-gen/core";
import { png } from "../../core/test/fake-comfy.ts";
import { LORA_CHUNK } from "../src/loras.ts";
import { REQUEST_BUDGET, type App } from "../src/app.ts";
import { offlineMessage, pausedMessage } from "../src/hooks.ts";
import { cacheEntry } from "../src/store.ts";
import * as updates from "../src/updates.ts";
import golden from "../../core/test/golden.json" with { type: "json" };
import { makeSession, sessionOk } from "../src/auth.ts";
import * as auth from "../src/auth.ts";
import { ADMIN, COMFY, HOST, TOKEN, request, sha256Hex, world } from "./world.ts";

const secretsOf = (app: App) => app.store.secrets();

async function mcp(app: App, method: string, params: unknown = {}, id = 1): Promise<[number, any]> {
  const s = await secretsOf(app);
  const resp = await app.handle(request("POST", `/mcp/${s.mcp_secret}`, { jsonrpc: "2.0", id, method, params }));
  const text = await resp.text();
  return [resp.status, text ? JSON.parse(text) : null];
}

/** Add a GPU at the end of the list (as the URL setup and the Modal build do). */
const addGpu = async (app: App, gpu: Record<string, unknown>) => {
  const gpus = (await app.gpus()).filter((g) => g.id !== gpu.id);
  await app.store.updateSecrets({ gpus: [...gpus, { enabled: true, keep_warm_minutes: 5, ...gpu }] });
};
const withGenerator = (app: App) => addGpu(app, { id: "url", kind: "url", name: "Your ComfyUI", base_url: COMFY, headers: { "X-Test": "1" } });
const withModal = (app: App) =>
  addGpu(app, { id: "modal", kind: "modal", name: "Modal", base_url: COMFY, admin_url: ADMIN, headers: { "Modal-Key": "wk", "Modal-Secret": "ws" } });

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
    expect(r.result.content[0].text).toContain("no GPU is set up yet");
    [, r] = await mcp(app, "tools/call", { name: "no_such_tool" });
    expect(r.error.code).toBe(-32602);
  });

  it("generate returns inline WebP and an image id; the WebP is stored in R2", async () => {
    const { app, net, comfy, bucket } = world();
    await withGenerator(app);
    const [, r] = await mcp(app, "tools/call", { name: "generate_realistic_image", arguments: { prompt: "a harbor" } });
    const [image, info] = r.result.content;
    expect([image.type, image.mimeType]).toEqual(["image", "image/webp"]);
    expect(fromBase64(image.data)).toEqual(comfy.viewBody);
    expect(comfy.calls.find((c) => c[1] === "/view")![2]!.preview).toBe("webp;90");
    const id = info.text.split("image_id: ")[1].split("\n")[0];
    expect(id).toMatch(refs.IMAGE_ID);
    expect(info.text).toContain(`https://${HOST}/img/${id}`);
    expect(bucket.objects.get(`img/${id}`)).toEqual({ data: comfy.viewBody, contentType: "image/webp" });
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
    expect(imageId).toMatch(refs.IMAGE_ID); // short: the model copies it
    [, r] = await mcp(app, "tools/call", { name: "edit_image", arguments: { prompt: "add a hat", image: imageId } });
    expect(r.result.isError).toBe(false);
    const loads = Object.values<any>(comfy.prompts.at(-1)!).filter((n) => n.class_type === "LoadImage").map((n) => n.inputs.image);
    expect(loads[0]).toMatch(/^comfy-gen-uploads\/upload-.*\.png$/);
    expect(loads[0]).toBe(`comfy-gen-uploads/upload-${imageId}.png`); // named after the id: edited again, the same file
    // The input keeps its size: its pixels, not the pack's 4 MP budget (768×768 came back 2048×2048).
    const scale = Object.values<any>(comfy.prompts.at(-1)!).find((n) => n.class_type === "ImageScaleToTotalPixels");
    expect(scale.inputs.megapixels).toBeCloseTo((640 * 480) / 1_048_576, 3);

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
    // A well-formed id that names nothing: deleted after a year, or mistyped.
    [, r] = await mcp(app, "tools/call", { name: "edit_image", arguments: { prompt: "x", image: "h3Kd9QxA" } }, 2);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("There is no image h3Kd9QxA");
  });

  it("the image route streams from R2, with no generator involved", async () => {
    const { app, comfy, bucket } = world(); // no generator set up at all
    await bucket.put("img/h3Kd9QxA", png(10, 10), { httpMetadata: { contentType: "image/png" } });
    const resp = await app.handle(request("GET", "/img/h3Kd9QxA"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(png(10, 10));
    const head = await app.handle(request("HEAD", "/img/h3Kd9QxA")); // link previews ask this way
    expect([head.status, head.headers.get("content-type"), head.headers.get("content-length"), head.body]).toEqual([200, "image/png", String(png(10, 10).length), null]);
    expect((await app.handle(request("HEAD", "/img/h3Kd9QxB"))).status).toBe(404);
    expect(comfy.calls).toEqual([]);
    for (const bad of ["bogus", "h3Kd9QxB", "..%2Fimg%2Fh3Kd9QxA"]) expect((await app.handle(request("GET", `/img/${bad}`))).status).toBe(404);
  });

  it("uploads land in R2, not on a GPU", async () => {
    const { app, comfy, bucket } = world();
    await withGenerator(app);
    const [, r] = await mcp(app, "tools/call", { name: "request_upload", arguments: { filename: "cat.png" } });
    const token = r.result.content[0].text.split("/upload/")[1].split("'")[0];
    const up = await app.handle(request("POST", `/upload/${token}`, png(64, 48)));
    expect(up.status).toBe(200);
    const { image_id } = await body(up);
    expect(bucket.objects.get(`img/${image_id}`)!.data).toEqual(png(64, 48));
    expect(comfy.calls).toEqual([]); // the GPU sees it only when an edit uses it
    expect((await app.handle(request("POST", `/upload/${token}`, utf8("not an image")))).status).toBe(415);
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
    expect(state.gpus).toEqual([]);
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
    expect(await app.gpus()).toEqual([]);
    const ok = await app.handle(request("POST", "/api/setup/generator", { base_url: COMFY + "/" }, cookie));
    expect((await body(ok)).system.comfyui_version).toBe("0.37.0");
    expect(await app.gpus()).toEqual([{ id: "url", kind: "url", name: "Your ComfyUI", enabled: true, keep_warm_minutes: 5, base_url: COMFY, headers: {} }]);
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
    const [gen] = await app.gpus();
    expect([gen.id, gen.kind, gen.headers, gen.admin_url]).toEqual(["modal", "modal", { "Modal-Key": "wk-1", "Modal-Secret": "ws-1" }, ADMIN]);
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
    expect([(await state()).modal_error, (await state()).gpus]).toEqual([reason, []]);

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
    expect([(await state()).modal_error, (await state()).gpus[0].kind]).toEqual([null, "modal"]);
    expect((await state()).gpus[0]).not.toHaveProperty("headers"); // the proxy token stays on the Worker
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
    expect((await app.gpus())[0].kind).toBe("modal");
  });

  it("the models page reports and remembers ready packs", async () => {
    const { app, net } = world();
    await withModal(app);
    const cookie = await login(app);
    net.seedState = { anima_turbo: { state: "done", done: 9, total: 9 }, z_image_turbo: { state: "downloading", done: 1, total: 4 } };
    const models = await body(await app.handle(request("GET", "/api/models", undefined, cookie)));
    expect(models.gpus).toEqual([{ id: "modal", name: "Modal", kind: "modal" }]);
    const packs = Object.fromEntries(models.packs.map((p: any) => [p.name, p.on.modal]));
    expect([packs.anima_turbo.state, packs.z_image_turbo.done, packs.flux2klein_edit.state]).toEqual(["done", 1, "missing"]);
    expect(models.packs[0].size).toBeGreaterThan(5e9);
    net.adminCalls = [];
    await app.handle(request("GET", "/api/models", undefined, cookie));
    expect(net.adminCalls.map((c) => c[1]).sort()).toEqual(["/seed/flux2klein_edit", "/seed/z_image_turbo"]); // anima is recorded
    const retry = await app.handle(request("POST", "/api/models/seed", { pack: "flux2klein_edit", gpu: "modal" }, cookie));
    expect((await body(retry)).started).toBe(true);
  });

  it("saving settings seeds new packs; keep-warm is set per GPU", async () => {
    const { app, net } = world();
    await withModal(app);
    const cookie = await login(app);
    await app.store.updateSetup({ seeded: ["anima_turbo", "z_image_turbo", "flux2klein_edit"] });
    const cfg = (await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).config;
    const resp = await app.handle(request("PUT", "/api/config", { config: cfg }, cookie));
    expect((await body(resp)).warnings).toEqual([]);
    expect(net.adminCalls).toEqual([]); // nothing changed
    cfg.pack_selections = { generate_realistic_image: "flux2klein_9b" };
    await app.handle(request("PUT", "/api/config", { config: cfg }, cookie));
    expect(net.adminCalls.filter((c) => c[1] === "/seed").map((c) => c[2].pack)).toEqual(["flux2klein_9b"]);
    // Keep-warm belongs to the GPU: setting Modal's applies it on Modal at once.
    const patched = await body(await app.handle(request("PATCH", "/api/gpus/modal", { keep_warm_minutes: 15 }, cookie)));
    expect([patched.gpu.keep_warm_minutes, patched.warnings]).toEqual([15, []]);
    expect(net.adminCalls).toContainEqual(["POST", "/idle", { seconds: 900 }]);
    expect((await app.handle(request("PATCH", "/api/gpus/modal", { keep_warm_minutes: 0 }, cookie))).status).toBe(400);
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
  /** Upload *data* as *name* the way the settings page does: chunks with their ETags, then finish. */
  const upload = async (app: App, cookie: Record<string, string>, name: string, data: Uint8Array) => {
    const created = await body(await app.handle(request("POST", "/api/loras/uploads", { filename: name, size: data.length }, cookie)));
    const parts = [];
    for (let i = 0; i < created.chunks; i++) {
      const chunk = data.subarray(i * created.chunk_size, (i + 1) * created.chunk_size);
      const r = await app.handle(request("PUT", `${created.upload_url}/${i}`, chunk, { ...cookie, "content-length": String(chunk.length) }));
      expect(r.status).toBe(200);
      parts.push(await body(r));
    }
    return app.handle(request("POST", `/api/loras/uploads/${created.id}/finish`, { parts }, cookie));
  };

  it("the settings page uploads into R2 in chunks; Modal is told to copy it; delete removes it everywhere", async () => {
    const { app, net, bucket } = world();
    await withModal(app);
    const cookie = await login(app);
    net.loras = { "old.safetensors": 5 }; // on the Volume from before R2
    const data = new Uint8Array(LORA_CHUNK + 1000);
    for (let i = 0; i < data.length; i += 4096) data[i] = (i / 4096) % 251; // toEqual on MBs is slow: compare hashes

    const created = await body(await app.handle(request("POST", "/api/loras/uploads", { filename: "style.safetensors", size: data.length }, cookie)));
    expect(created).toMatchObject({ chunk_size: LORA_CHUNK, chunks: 2, upload_url: `/api/loras/uploads/${created.id}` });
    const wrong = await app.handle(request("PUT", `${created.upload_url}/0`, data.subarray(0, 10), { ...cookie, "content-length": "10" }));
    expect([wrong.status, (await body(wrong)).error]).toEqual([400, `chunk 0 must be ${LORA_CHUNK} bytes`]);
    const finish = await upload(app, cookie, "style.safetensors", data);
    expect(await body(finish)).toEqual({ state: "done", name: "style.safetensors", size: data.length });
    expect(await sha256Hex(bucket.objects.get("lora/style.safetensors")!.data)).toBe(await sha256Hex(data));
    // Modal fetches it from a storage link, which the Worker serves from R2.
    expect(net.fetches.map((f) => [f.name, f.size])).toEqual([["style.safetensors", data.length]]);
    const link = new URL(net.fetches[0].url);
    expect(link.pathname).toMatch(/^\/store\//);
    const ranged = await app.handle(request("GET", link.pathname, undefined, { range: `bytes=${LORA_CHUNK}-` }));
    expect([ranged.status, ranged.headers.get("content-range")]).toEqual([206, `bytes ${LORA_CHUNK}-${data.length - 1}/${data.length}`]);
    expect(await sha256Hex(new Uint8Array(await ranged.arrayBuffer()))).toBe(await sha256Hex(data.subarray(LORA_CHUNK)));
    expect((await app.handle(request("GET", link.pathname.slice(0, -3) + "AAA"))).status).toBe(403);

    expect(await body(await app.handle(request("GET", "/api/loras", undefined, cookie)))).toMatchObject({
      backends: ["storage", "modal"], files: { "style.safetensors": { storage: data.length }, "old.safetensors": { modal: 5 } },
    });
    for (const bad of [{ filename: "x.ckpt", size: 1 }, { filename: "x.safetensors", size: 3 * 1024 ** 3 }]) {
      expect((await app.handle(request("POST", "/api/loras/uploads", bad, cookie))).status).toBe(400);
    }
    expect((await app.handle(request("GET", "/api/loras/uploads/nope", undefined, cookie))).status).toBe(404);

    net.loras["style.safetensors"] = data.length;
    const entry = { name: "style.safetensors", strength: 1, trigger: "@style", hidden: false };
    const other = { name: "keep.safetensors", strength: 1, trigger: "", hidden: false };
    await app.handle(request("PUT", "/api/config", { config: { pack_loras: { anima: [entry, other] } } }, cookie));
    const del = await app.handle(request("DELETE", "/api/loras/style.safetensors", undefined, cookie));
    expect(await body(del)).toEqual({ deleted: "style.safetensors", from: ["storage", "modal"], errors: [], pending: [] });
    expect(bucket.objects.has("lora/style.safetensors")).toBe(false);
    // Turned off in every model too: a generation must not ask ComfyUI for the missing file.
    const state = await body(await app.handle(request("GET", "/api/state", undefined, cookie)));
    expect(state.config.pack_loras).toEqual({ anima: [other] });
    expect((await app.handle(request("DELETE", "/api/loras/style.safetensors", undefined, cookie))).status).toBe(404);
    expect((await app.handle(request("GET", "/api/loras"))).status).toBe(401); // cookie required
  });

  it("a ComfyUI by URL takes LoRAs by name: listed as a backend with no files", async () => {
    const { app } = world();
    await withGenerator(app);
    const cookie = await login(app);
    const listing = await body(await app.handle(request("GET", "/api/loras", undefined, cookie)));
    expect(listing).toMatchObject({ backends: ["storage", "url"], files: {} });
  });

  it("saving warns about LoRAs that are not uploaded", async () => {
    const { app, net, bucket } = world();
    await withModal(app);
    const cookie = await login(app);
    await app.store.updateSetup({ seeded: ["anima_turbo", "z_image_turbo", "flux2klein_edit"] });
    await bucket.put("lora/here.safetensors", new Uint8Array(1));
    net.loras = { "here.safetensors": 1 };
    const cfg = (await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).config;
    cfg.pack_loras = { anima: [{ name: "here.safetensors", trigger: "@a" }, { name: "gone.safetensors" }] };
    const resp = await body(await app.handle(request("PUT", "/api/config", { config: cfg }, cookie)));
    expect(resp.warnings).toEqual(["The LoRA gone.safetensors is not uploaded: generations will fail until it is. Upload it under LoRAs."]);
    expect(resp.config.pack_loras.anima[0]).toEqual({ name: "here.safetensors", strength: 1, trigger: "@a", hidden: false });
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
    expect(await updates.check(net.fetch, app.store, "claude/some-branch")).toBe("development build (claude/some-branch): no automatic updates");
    expect(net.calls.at(-1)?.[1]).toBe("https://github.com/lugia19/comfyui-gen-mcp/releases/latest");
  });

  it("the settings page can update now", async () => {
    const { app, net, env } = world();
    env.VERSION = "v0.9.0";
    const cookie = await login(app);
    const info = await body(await app.handle(request("GET", "/api/update", undefined, cookie)));
    expect(info).toEqual({ current: "v0.9.0", latest: "v1.0.0", dev: false, newer: true, can: true, build: null, building: false });
    env.VERSION = "claude/some-branch"; // a branch build: the page says so, and offers no update
    expect(await body(await app.handle(request("GET", "/api/update", undefined, cookie)))).toMatchObject({ dev: true, newer: false });
    env.VERSION = "v0.9.0";
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
    const { id, link } = await body(await app.handle(request("POST", "/api/gpus/pc", undefined, cookie)));
    return { cookie, id: id as string, link: link as string, secret: (link as string).split("#")[1] };
  };
  const toolText = (r: any) => r.result.content.map((c: any) => c.text ?? `[${c.type}]`).join(" ");

  it("pairs PCs with links: each opens its own relay, until removed or re-paired", async () => {
    const { app, pc, relay } = world();
    const gate = (secret: string) => app.agentGate(ws(secret));
    expect(await gate("anything")).toBeInstanceOf(Response); // nothing paired
    const { cookie, id, link, secret } = await pair(app);
    expect([id, link]).toEqual(["pc", `https://${HOST}/agent#${secret}`]);
    expect(secret.length).toBeGreaterThan(40);
    expect(await gate(secret)).toBe("pc"); // its socket goes to the Relay object named "pc"
    expect(((await gate("wrong")) as Response).status).toBe(401);
    expect(((await app.agentGate(request("GET", "/agent", undefined, { authorization: `Bearer ${secret}` }))) as Response).status).toBe(426);
    const gpus = async () => (await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).gpus;
    const [first] = await gpus();
    expect(first).toMatchObject({ id: "pc", kind: "pc", name: "Your PC", link, online: true, info: { gpu: "nvidia" }, seen: expect.any(Number) });
    expect(first).not.toHaveProperty("secret");
    pc.connected = false; // offline for a moment: still seen, not a pairing to do
    expect((await gpus())[0].seen).toBe(first.seen);
    pc.connected = true;

    // A second PC: its own id, secret, Relay object and name; the first keeps working.
    const two = await pair(app);
    expect(two.id).toMatch(/^pc-/);
    expect(await gate(two.secret)).toBe(two.id);
    expect(await gate(secret)).toBe("pc");
    expect((await gpus()).map((g: any) => [g.id, g.name])).toEqual([["pc", "Your PC"], [two.id, "PC 2"]]); // after the other PCs

    // A new link for the first PC: the old one stops working and its agent is dropped.
    const again = await body(await app.handle(request("POST", "/api/gpus/pc/pair", undefined, cookie)));
    expect(await gate(secret)).toBeInstanceOf(Response);
    expect(await gate(again.link.split("#")[1])).toBe("pc");
    expect(pc.dropped).toBe(1);
    pc.connected = false;
    expect((await gpus()).find((g: any) => g.id === "pc").seen).toBeNull(); // a new pairing view
    // Removing the second PC drops its agent and its secret.
    expect((await app.handle(request("DELETE", `/api/gpus/${two.id}`, undefined, cookie))).status).toBe(200);
    expect(await gate(two.secret)).toBeInstanceOf(Response);
    expect(relay(two.id).dropped).toBe(1);
    expect((await gpus()).map((g: any) => g.id)).toEqual(["pc"]);
    expect((await app.handle(request("DELETE", "/api/gpus/nope", undefined, cookie))).status).toBe(404);
  });

  it("one config serves every GPU; saving applies it to the PC too; keep-warm is the PC's own", async () => {
    const { app, pc } = world();
    await withModal(app);
    await app.store.updateSetup({ seeded: ["anima_turbo", "z_image_turbo", "flux2klein_edit"] });
    const { cookie } = await pair(app);
    const state = async () => body(await app.handle(request("GET", "/api/state", undefined, cookie)));
    const cfg = { ...(await state()).config, pack_settings: { anima: { artist_list: "@one_artist" } } };

    const put = await body(await app.handle(request("PUT", "/api/config", { config: cfg }, cookie)));
    expect(put.warnings).toEqual([]);
    expect(pc.controlCalls.filter(([op]) => op === "download").length).toBe(3); // the PC downloads the selected packs
    expect(pc.controlCalls.at(-1)![0]).toBe("sync"); // and copies LoRAs

    const illustrated = async () => (await mcp(app, "tools/list"))[1].result.tools.find((t: any) => t.name === "generate_illustrated_image").description;
    expect(await illustrated()).toContain("@one_artist");

    await app.handle(request("PATCH", "/api/gpus/pc", { keep_warm_minutes: 12, name: "Desk PC" }, cookie));
    pc.controlCalls.length = 0;
    await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a cat" } });
    expect(pc.controlCalls.find(([op]) => op === "ensure")![1].keep_warm_minutes).toBe(12); // the PC's keep-warm
    expect((await state()).gpus[0].name).toBe("Desk PC");

    pc.connected = false; // saving while the PC is off: no warning, and no wait for it
    pc.controlCalls.length = 0;
    const off = await body(await app.handle(request("PUT", "/api/config", { config: cfg }, cookie)));
    expect([off.warnings, off.notes]).toEqual([[], []]); // the page shows the PC offline already
    expect(pc.controlCalls).toEqual([]);
  });

  it("warns only about LoRAs that are not in storage, whatever the GPUs hold", async () => {
    const { app, net, pc, bucket } = world();
    await withModal(app);
    await app.store.updateSetup({ seeded: ["anima_turbo", "z_image_turbo", "flux2klein_edit"] });
    const { cookie } = await pair(app);
    await bucket.put("lora/stored.safetensors", new Uint8Array(1));
    net.loras = { "modal.safetensors": 1 };
    pc.controls.loras = () => [200, { files: { "pc.safetensors": 2 }, syncing: {} }];
    pc.controls.download = () => [200, {}];
    pc.controls.sync = () => [200, { started: true }];
    const cfg = (await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).config;
    cfg.pack_loras = { anima: [{ name: "stored.safetensors" }, { name: "pc.safetensors" }] };
    const resp = await body(await app.handle(request("PUT", "/api/config", { config: cfg }, cookie)));
    // The PC's own copy is pushed into storage at its next sync; until then, it is not uploaded.
    expect(resp.warnings).toEqual(["The LoRA pc.safetensors is not uploaded: generations will fail until it is. Upload it under LoRAs."]);
    expect(pc.controlCalls.some(([op]) => op === "sync")).toBe(true); // the save copies storage to the PC
  });

  it("the agent's LoRA sync: pull what R2 has, push what only the PC has, delete what was deleted", async () => {
    const { app, bucket } = world();
    const { secret, cookie } = await pair(app);
    const sync = (loras: unknown, auth = secret) =>
      app.handle(request("POST", "/agent/sync", { loras }, { authorization: `Bearer ${auth}` }));
    expect((await sync({}, "wrong")).status).toBe(401);
    expect(await body(await sync({}))).toEqual({ push: [], pull: [], delete: [], errors: [] }); // no LoRAs anywhere

    await bucket.put("lora/stored.safetensors", new Uint8Array(30));
    await bucket.put("lora/both.safetensors", new Uint8Array(1));
    const plan = await body(await sync({ "pc.safetensors": 40, "both.safetensors": 1 }));
    expect(plan.pull).toEqual([{ name: "stored.safetensors", size: 30, url: expect.stringMatching(new RegExp(`^https://${HOST}/store/`)) }]);
    expect(plan.push).toEqual([{ name: "pc.safetensors", size: 40, upload_url: expect.stringMatching(new RegExp(`^https://${HOST}/agent/loras/uploads/`)), chunk_size: LORA_CHUNK, chunks: 1 }]);
    // The storage link serves the file to anyone holding it.
    expect((await app.handle(request("GET", new URL(plan.pull[0].url).pathname))).status).toBe(200);
    // The push goes to the agent's upload route, which needs the pairing secret.
    const push = new URL(plan.push[0].upload_url).pathname;
    const chunk = new Uint8Array(40).fill(4);
    expect((await app.handle(request("PUT", `${push}/0`, chunk, { "content-length": "40" }))).status).toBe(401);
    const part = await body(await app.handle(request("PUT", `${push}/0`, chunk, { authorization: `Bearer ${secret}`, "content-length": "40" })));
    const done = await app.handle(request("POST", `${push}/finish`, { parts: [part] }, { authorization: `Bearer ${secret}` }));
    expect(await body(done)).toMatchObject({ state: "done", name: "pc.safetensors" });
    expect(bucket.objects.get("lora/pc.safetensors")!.data).toEqual(chunk);

    // Deleted while the PC was offline: its next sync deletes its copy, and never pushes it back.
    expect((await app.handle(request("DELETE", "/api/loras/both.safetensors", undefined, cookie))).status).toBe(200);
    const after = await body(await sync({ "both.safetensors": 1, "pc.safetensors": 40, "stored.safetensors": 30 }));
    expect([after.delete, after.push, after.pull]).toEqual([["both.safetensors"], [], []]);
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

  it("images outlive their GPU: a PC image opens and is edited on Modal while the PC is off", async () => {
    const { app, pc, comfy } = world();
    await withGenerator(app);
    await pair(app);
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
    // Both ComfyUIs named their first output comfy-gen_00001_.png; the ids are R2's, so they differ.
    expect(pcId).not.toBe(mainId);
    expect(await bytes(await app.handle(request("GET", `/img/${pcId}`)))).toEqual(fox); // the PC is off
    expect(await bytes(await app.handle(request("GET", `/img/${mainId}`)))).toEqual(girl);

    // The PC's image, edited while only Modal answers: it comes from R2 into Modal's inputs.
    const before = comfy.uploads.length;
    const [, edited] = await mcp(app, "tools/call", { name: "edit_image", arguments: { prompt: "at night", image: pcId } }, 3);
    expect(edited.result.isError).toBe(false);
    expect(comfy.uploads.length).toBe(before + 1);
    expect(Buffer.from(comfy.uploads.at(-1)!).includes(Buffer.from(fox))).toBe(true);
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
    expect(state.gpus[0]).toMatchObject({ online: true, paused: true }); // shown as paused, not offline

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

  it("relays the PC's own settings calls for the Worker's page, and says when it is offline", async () => {
    const { app, pc } = world();
    const { cookie, id } = await pair(app);
    pc.controls.machine = (args) =>
      args.path === "/state" ? [200, { comfyui: { state: "stopped" }, method: args.method }]
      : args.path === "/setup/install" ? [200, { state: "running", body: args.body }]
      : [403, "That can only be changed on the PC itself, on its Comfy-Gen page."];
    const state = await app.handle(request("GET", `/api/gpus/${id}/machine/state`, undefined, cookie));
    expect([state.status, await body(state)]).toEqual([200, { comfyui: { state: "stopped" }, method: "GET" }]);
    expect(await body(await app.handle(request("POST", `/api/gpus/${id}/machine/setup/install`, { gpu: "nvidia" }, cookie)))).toEqual({ state: "running", body: '{"gpu":"nvidia"}' });
    const refused = await app.handle(request("PUT", `/api/gpus/${id}/machine/config`, {}, cookie));
    expect([refused.status, (await body(refused)).error]).toEqual([403, "Your PC: That can only be changed on the PC itself, on its Comfy-Gen page."]);
    expect((await app.handle(request("GET", "/api/gpus/nope/machine/state", undefined, cookie))).status).toBe(404);
    expect((await app.handle(request("GET", `/api/gpus/${id}/machine/state`))).status).toBe(401); // login required
    pc.connected = false;
    const off = await app.handle(request("GET", `/api/gpus/${id}/machine/state`, undefined, cookie));
    expect([off.status, (await body(off)).error]).toEqual([503, offlineMessage([{ name: "Your PC" } as any])]);
  });

  it("pauses and resumes the PC from the page", async () => {
    const { app, pc } = world();
    const { cookie } = await pair(app);
    pc.controls.pause = (args) => ((pc.paused = args.paused), [200, { paused: args.paused }]);
    expect(await body(await app.handle(request("POST", "/api/gpus/pc/pause", { paused: true }, cookie)))).toEqual({ paused: true });
    expect((await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).gpus[0].paused).toBe(true);
    await app.handle(request("POST", "/api/gpus/pc/pause", { paused: false }, cookie));
    expect(pc.paused).toBe(false);
    pc.connected = false;
    expect((await app.handle(request("POST", "/api/gpus/pc/pause", { paused: true }, cookie))).status).toBe(503);
  });

  it("deletes a LoRA everywhere, and nudges the agent's sync after an upload", async () => {
    const { app, pc, net } = world();
    await app.store.updateSecrets({
      generator: { kind: "modal", base_url: COMFY, admin_url: ADMIN, upload_url: "https://up.example/", headers: {} },
    });
    const { cookie } = await pair(app);
    net.loras = { "x.safetensors": 1 };
    // The PC's ComfyUI still has the file open (Windows): off the list, the file goes when it stops.
    pc.controls.lora_delete = (args) => (args.name === "x.safetensors" ? [200, { deleted: args.name, pending: true }] : [404, "no LoRA"]);
    pc.controls.sync = () => [200, { started: true }];
    const del = await body(await app.handle(request("DELETE", "/api/loras/x.safetensors", undefined, cookie)));
    expect(del).toEqual({ deleted: "x.safetensors", from: ["modal", "pc"], errors: [], pending: ["Your PC"] });
    expect((await app.handle(request("DELETE", "/api/loras/nope.safetensors", undefined, cookie))).status).toBe(404);
    expect(await body(await app.handle(request("POST", "/api/loras/sync", undefined, cookie)))).toEqual({ started: true });
    expect(pc.controlCalls.at(-1)![0]).toBe("sync");
    pc.connected = false;
    expect(await body(await app.handle(request("POST", "/api/loras/sync", undefined, cookie)))).toEqual({ started: false });
  });

  it("shows each GPU's LoRA files and model downloads, and learns which packs a PC has", async () => {
    const { app, pc, net } = world();
    await withModal(app);
    await app.store.updateSetup({ seeded: ["anima_turbo", "z_image_turbo", "flux2klein_edit"] });
    const { cookie } = await pair(app);
    net.loras = { "both.safetensors": 7 };
    pc.controls.loras = () => [200, { files: { "mine.safetensors": 123, "both.safetensors": 7 }, syncing: { "x.safetensors": { to: "pc", done: 1, total: 2 } } }];
    pc.controls.models = (args) => [200, args.packs.map((p: any) => ({ name: p.name, state: "downloading", done: 1, total: 4 }))];
    pc.controls.download = (args) => [200, { state: "queued", done: 0, total: args.pack.models.length }];
    expect(await body(await app.handle(request("GET", "/api/loras", undefined, cookie)))).toEqual({
      backends: ["storage", "pc", "modal"],
      gpus: [{ id: "pc", name: "Your PC", kind: "pc" }, { id: "modal", name: "Modal", kind: "modal" }],
      files: { "mine.safetensors": { pc: 123 }, "both.safetensors": { pc: 7, modal: 7 } },
      syncing: { "x.safetensors": { to: "pc", done: 1, total: 2 } },
      errors: {},
      offline: [],
    });
    const models = await body(await app.handle(request("GET", "/api/models", undefined, cookie)));
    expect(models.gpus.map((g: any) => g.id)).toEqual(["pc", "modal"]);
    expect(models.packs[0]).toMatchObject({ on: { pc: { state: "downloading", total: 4 }, modal: { state: "done" } }, size: expect.any(Number) });
    // Routing learned the PC lacks these packs: a call goes to Modal, which has them.
    await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a cat" } });
    expect(pc.comfy.prompts.length).toBe(0);
    const onlyModal = await body(await app.handle(request("GET", "/api/models?gpu=modal", undefined, cookie)));
    expect([onlyModal.gpus.map((g: any) => g.id), onlyModal.packs[0].on]).toEqual([["modal"], { modal: { state: "done" } }]);
    const seeded = await app.handle(request("POST", "/api/models/seed", { pack: models.packs[0].name, gpu: "pc" }, cookie));
    expect((await body(seeded)).state).toBe("queued");

    pc.connected = false; // offline: listed as such at once, not waited for
    pc.controlCalls.length = 0;
    const loras = await body(await app.handle(request("GET", "/api/loras", undefined, cookie)));
    expect([loras.offline, loras.errors, loras.files]).toEqual([["pc"], {}, { "both.safetensors": { modal: 7 } }]);
    expect((await body(await app.handle(request("GET", "/api/models", undefined, cookie)))).packs[0].on.pc).toEqual({ state: "offline" });
    expect(pc.controlCalls).toEqual([]);
  });
});

describe("the GPU list", () => {
  it("names the GPUs in its messages, as a list", () => {
    const g = (name: string) => ({ name }) as any;
    expect(offlineMessage([g("Your PC")])).toMatch(/^Your PC is offline\. Start the PC .*its tray icon/);
    expect(offlineMessage([g("Your PC"), g("PC 2")])).toMatch(/^Your PC and PC 2 are offline\. Start them .*their tray icons/);
    expect(pausedMessage([g("A"), g("B"), g("C")])).toMatch(/^A, B and C are paused: .*their Comfy-Gen tray icons/);
  });

  const pairPc = async (app: App, cookie: Record<string, string>) =>
    body(await app.handle(request("POST", "/api/gpus/pc", undefined, cookie))) as Promise<{ id: string; link: string }>;
  const gen = (app: App, n: number) => mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "a cat" } }, n);

  it("a Worker from before the list keeps its PC and generator, the PC first, its agent still connected", async () => {
    const { app } = world();
    await app.store.updateSecrets({
      agent_secret: "s".repeat(43),
      generator: { kind: "modal", base_url: COMFY, admin_url: ADMIN, headers: { "Modal-Key": "k" }, cold_start_s: 300 },
    });
    const gpus = await app.gpus();
    expect(gpus.map((g) => [g.id, g.kind, g.name])).toEqual([["pc", "pc", "Your PC"], ["modal", "modal", "Modal"]]);
    expect(gpus[0].secret).toBe("s".repeat(43)); // the same pairing: the agent reconnects to the same Relay
    const s = await secretsOf(app);
    expect([s.generator, s.agent_secret, s.gpus.length]).toEqual([undefined, undefined, 2]);
    expect(await app.agentGate(request("GET", "/agent", undefined, { upgrade: "websocket", authorization: `Bearer ${"s".repeat(43)}` }))).toBe("pc");
  });

  it("calls go down the list: offline, paused or disabled GPUs are passed over; the order is the user's", async () => {
    const { app, relay, comfy } = world();
    const cookie = await login(app);
    await withGenerator(app);
    const b = await pairPc(app, cookie);
    const a = await pairPc(app, cookie); // after the other PCs, before the URL: [b, a, url]
    expect((await app.gpus()).map((g) => g.id)).toEqual([b.id, a.id, "url"]);
    await gen(app, 1);
    expect([relay(b.id).comfy.prompts.length, relay(a.id).comfy.prompts.length]).toEqual([1, 0]);
    relay(b.id).connected = false;
    await gen(app, 2);
    expect(relay(a.id).comfy.prompts.length).toBe(1);
    relay(a.id).paused = true;
    await gen(app, 3);
    expect(comfy.prompts.length).toBe(1); // both PCs out: the ComfyUI by URL
    relay(b.id).connected = true;
    relay(a.id).paused = false;
    await app.handle(request("PATCH", `/api/gpus/${b.id}`, { enabled: false }, cookie));
    await app.handle(request("PUT", "/api/gpus/order", { ids: ["url", a.id, b.id] }, cookie));
    await gen(app, 4);
    expect(comfy.prompts.length).toBe(2); // the URL is first now
    expect((await app.handle(request("PUT", "/api/gpus/order", { ids: ["url"] }, cookie))).status).toBe(400);
  });

  it("a GPU still downloading the pack hands the call to the next; the next call skips it", async () => {
    const { app, pc, comfy } = world();
    const cookie = await login(app);
    await withGenerator(app);
    await pairPc(app, cookie);
    pc.controls.ensure = () => [500, "The Anima model is downloading: 12% of 5.6 GB."];
    const [, first] = await gen(app, 1);
    expect(first.result.isError).toBe(false);
    expect(comfy.prompts.length).toBe(1); // answered by the URL in the same call
    pc.controlCalls.length = 0;
    await gen(app, 2);
    expect(pc.controlCalls.some(([op]) => op === "ensure")).toBe(false); // known to lack it: not asked
  });

  it("a fetch_result token names its GPU, and goes only there", async () => {
    const { app, pc, comfy } = world();
    const cookie = await login(app);
    await withGenerator(app);
    await pairPc(app, cookie);
    pc.comfy.history = Array(500).fill("running");
    const [, pending] = await mcp(app, "tools/call", { name: "generate_illustrated_image", arguments: { prompt: "slow" } });
    const token = pending.result.content[0].text.match(/request_token '([^']+)'/)[1];
    expect(token).toMatch(/^pc:/);
    pc.connected = false;
    const [, off] = await mcp(app, "tools/call", { name: "fetch_result", arguments: { request_token: token } }, 2);
    expect([off.result.isError, off.result.content[0].text]).toEqual([true, `Error: ${offlineMessage([{ name: "Your PC" } as any])}`]);
    expect(comfy.calls).toEqual([]); // never asked the URL, which does not have the job
    pc.connected = true;
    pc.comfy.history = [];
    const [, done] = await mcp(app, "tools/call", { name: "fetch_result", arguments: { request_token: token } }, 3);
    expect(done.result.content[0].type).toBe("image");
  });
});

describe("password login", () => {
  it("hashes with PBKDF2-SHA256 (a stored format: the vector is Python's hashlib.pbkdf2_hmac)", async () => {
    const salt = "00112233445566778899aabbccddeeff";
    expect(await auth.hashPassword("correct horse battery", salt, 1000)).toBe("7b45bab25588ef932d09a1d56ad6911d7d7c1759dedf18cb663cd6c3034bd67b");
  });

  it("is set after a token login, then logs in, and pauses after too many wrong ones", async () => {
    const { app, clock } = world();
    const loginWith = (password: string) => app.handle(request("POST", "/api/login", { password }));
    expect(await body(await app.handle(request("GET", "/api/login")))).toEqual({ password: false });
    expect((await loginWith("anything at all")).status).toBe(400); // none set: the token is the way in
    expect((await app.handle(request("PUT", "/api/password", { password: "long enough!" }))).status).toBe(401); // logged in only

    const cookie = await login(app);
    expect((await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).password_set).toBe(false);
    expect((await app.handle(request("PUT", "/api/password", { password: "short" }, cookie))).status).toBe(400);
    expect((await app.handle(request("PUT", "/api/password", { password: "7 chars" }, cookie))).status).toBe(400);
    expect((await app.handle(request("PUT", "/api/password", { password: "8 chars!" }, cookie))).status).toBe(200); // the minimum
    expect((await app.handle(request("PUT", "/api/password", { password: "long enough!" }, cookie))).status).toBe(200);
    expect((await body(await app.handle(request("GET", "/api/state", undefined, cookie)))).password_set).toBe(true);
    expect(await body(await app.handle(request("GET", "/api/login")))).toEqual({ password: true });
    const stored = (await secretsOf(app)).password;
    expect(Object.keys(stored).sort()).toEqual(["hash", "iterations", "salt"]); // never the password itself
    expect(JSON.stringify(stored)).not.toContain("long enough");

    const ok = await loginWith("long enough!");
    expect(ok.status).toBe(200);
    const session = ok.headers.get("set-cookie")!.split(";")[0];
    expect((await app.handle(request("GET", "/api/state", undefined, { cookie: session }))).status).toBe(200);
    expect((await loginWith("wrong password")).status).toBe(401);

    for (let i = 0; i < 9; i++) await loginWith("wrong password");
    const paused = await loginWith("long enough!"); // even the right one, for the rest of the hour
    expect([paused.status, (await body(paused)).error]).toEqual([429, expect.stringContaining("Cloudflare token")]);
    expect((await app.handle(request("POST", "/api/login", { token: TOKEN }))).status).toBe(200); // the token still works
    clock.t += 3601;
    expect((await loginWith("long enough!")).status).toBe(200);
  });
});
