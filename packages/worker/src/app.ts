// The Worker's routes, over the Platform services, so every route is tested in Node; index.ts
// adapts Cloudflare's runtime to it.
//
// Keep the MCP path lean: packs load at module scope, and a warm call reads its state from the
// isolate cache. Each fetch to ComfyUI costs CPU, so the client backs off its polls.

import {
  Brain, ComfyUIClient, ComfyUIError, FetchTransport, McpHandler, SETTINGS_SCHEMA, UnknownTool,
  builtinPacks, configKey, downloadSize, fromHex, groupByTool, refs, select, sniffMime, tokenUrlsafe, safeEqual,
  type Config, type Content, type Pack,
} from "@comfy-gen/core";
import * as auth from "./auth.ts";
import * as cloudflare from "./cloudflare.ts";
import { WorkerHooks } from "./hooks.ts";
import * as modalAdmin from "./modal-admin.ts";
import { bodyJson, error, json, withUserAgent, type Fetch, type Platform } from "./platform.ts";
import { render, text } from "./render.ts";
import { Store, type Secrets } from "./store.ts";
import * as updates from "./updates.ts";
import * as uploads from "./uploads.ts";

export const PACKS = builtinPacks();
const GROUPS = groupByTool(PACKS);

// Of the free plan's 50 external subrequests per invocation, what one MCP call may spend on
// ComfyUI. The rest covers downloading an edit_image URL and its upload.
export const REQUEST_BUDGET = 44;
export const MODAL_COLD_START_S = 300;

export const INSTRUCTIONS =
  "Images come back inline, each followed by its image_id. Pass an image_id to edit_image to edit that image.";

/** What the settings page needs to render pack choices. */
export const PACK_METADATA = Object.entries(GROUPS).map(([tool, group]) => ({
  tool_name: tool,
  packs: group.map((p) => ({
    name: p.name,
    display_name: p.display_name ?? p.name,
    description: p.description ?? "",
    download_size: downloadSize(p),
    is_default: Boolean(p.is_default),
    config_key: configKey(p),
    max_pixels: p.max_pixels ?? null,
    max_pixels_limit: p.max_pixels_limit ?? null,
    default_artist_list: p.default_artist_list ?? null,
  })),
}));

export function selectedPacks(cfg: Config): Pack[] {
  return select(GROUPS, cfg.pack_selections);
}

const hmacKey = (s: Secrets) => fromHex(s.hmac_key);

export class App {
  readonly p: Platform;
  readonly fetch: Fetch;
  readonly store: Store; // the MCP, image and upload routes
  readonly fresh: Store; // settings pages and callbacks: never the isolate cache

  constructor(platform: Platform) {
    this.p = platform;
    this.fetch = withUserAgent(platform.fetch);
    this.store = new Store(platform.kv, platform.now);
    this.fresh = new Store(platform.kv, platform.now, false);
  }

  get version(): string {
    return this.p.env.VERSION || "dev";
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path.startsWith("/mcp/")) return await this.mcp(req, url, path.slice(5));
      if (path.startsWith("/img/") && req.method === "GET") return await this.image(path.slice(5));
      if (path.startsWith("/upload/") && req.method === "POST") return await this.upload(req, path.slice(8));
      if (path === "/build-callback" && req.method === "POST") return await this.buildCallback(req);
      if (path.startsWith("/api/")) return await this.api(req, url, path.slice(4));
    } catch (e) {
      if (e instanceof cloudflare.CloudflareError) return error(502, e.message);
      throw e;
    }
    return error(404, "not found");
  }

  async scheduled(): Promise<string> {
    const result = await updates.check(this.fetch, this.store, this.version);
    console.log(`update check: ${result}`);
    return result;
  }

  // ── MCP ───────────────────────────────────────────────────────────

  private client(generator: Record<string, any> | undefined): ComfyUIClient | null {
    if (!generator?.base_url) return null;
    return new ComfyUIClient(new FetchTransport(this.fetch, generator.base_url, generator.headers ?? {}), {
      coldStartS: generator.cold_start_s ?? 0,
      requestBudget: REQUEST_BUDGET,
      sleep: this.p.sleep,
      now: this.p.now,
    });
  }

  private async mcp(req: Request, url: URL, secret: string): Promise<Response> {
    const s = await this.store.secrets();
    if (!safeEqual(secret.replace(/^\/+|\/+$/g, ""), s.mcp_secret)) return error(404, "not found");
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const cfg = await this.store.config();
    const key = hmacKey(s);
    const client = this.client(s.generator);
    const admin = modalAdmin.forGenerator(this.fetch, s.generator);
    const brain = new Brain(PACKS, cfg, client!, "refs", {
      hooks: new WorkerHooks(client!, key, this.fetch, admin, this.store, `${url.origin}/`),
    });
    const served = new Set(brain.specs.map((spec) => spec.name));

    const call = async (name: string, args: Record<string, any>): Promise<[Content[], boolean]> => {
      if (!served.has(name)) throw new UnknownTool(name);
      if (!client) return [[text(`Error: the image generator is not set up yet. Finish setup at ${url.origin}/`)], true];
      if (name === "request_upload") return uploads.requestUpload(args, url.origin, key, this.p.now());
      return render(await brain.call(name, args), client, url.origin, key);
    };

    const handler = new McpHandler("Comfy-Gen-MCP", this.version, brain.specs, call, INSTRUCTIONS);
    const [status, body] = await handler.handle(await req.text());
    if (body === null) return new Response(null, { status });
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }

  private async image(ref: string): Promise<Response> {
    const s = await this.store.secrets();
    let image;
    try {
      image = await refs.verify(ref, hmacKey(s));
    } catch (e) {
      if (e instanceof refs.RefError) return error(404, "not found");
      throw e;
    }
    const client = this.client(s.generator);
    if (!client) return error(503, "generator not set up");
    try {
      const resp = await client.view(image);
      return new Response(resp.content, {
        status: 200,
        headers: { "Content-Type": sniffMime(resp.content) ?? "application/octet-stream", "Cache-Control": "private, max-age=86400" },
      });
    } catch (e) {
      if (e instanceof ComfyUIError) return error(502, e.message);
      throw e;
    }
  }

  private async upload(req: Request, token: string): Promise<Response> {
    const s = await this.store.secrets();
    const client = this.client(s.generator);
    if (!client) return error(503, "generator not set up");
    return uploads.receive(token, new Uint8Array(await req.arrayBuffer()), client, hmacKey(s), this.p.now());
  }

  // ── builds ────────────────────────────────────────────────────────

  private async buildCallback(req: Request): Promise<Response> {
    const data = await bodyJson(req);
    const expected = (await this.fresh.setup()).build_nonce;
    if (!expected || !safeEqual(String(data.nonce ?? ""), expected)) return error(403, "bad nonce");
    const modal = data.modal;
    let warnings: string[] = [];
    if (modal && typeof modal === "object" && modal.server_url) {
      const generator = {
        kind: "modal",
        base_url: modal.server_url,
        admin_url: modal.admin_url ?? null,
        headers: { "Modal-Key": modal.proxy_token_id ?? "", "Modal-Secret": modal.proxy_token_secret ?? "" },
        cold_start_s: MODAL_COLD_START_S,
      };
      await this.fresh.updateSecrets({ generator });
      // A deploy resets keep-warm to the app's default, and a fresh install has no models yet.
      const admin = modalAdmin.forGenerator(this.fetch, generator);
      if (admin) warnings = await this.applyToModal(admin, await this.fresh.config(), true);
    }
    return json({ ok: true, warnings });
  }

  /** Best effort: apply keep-warm, start downloads for selected packs. Returns warnings. */
  private async applyToModal(admin: modalAdmin.ModalAdmin, cfg: Config, keepWarm: boolean): Promise<string[]> {
    const warnings: string[] = [];
    if (keepWarm) {
      try {
        await admin.idle(cfg.keep_warm_minutes);
      } catch (e) {
        if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
        warnings.push(`Could not apply keep-warm: ${e.message}`);
      }
    }
    return warnings.concat(await modalAdmin.seedMissing(admin, this.fresh, selectedPacks(cfg)));
  }

  // ── settings API ──────────────────────────────────────────────────

  private async api(req: Request, url: URL, sub: string): Promise<Response> {
    if (sub === "/login" && req.method === "POST") return this.login(req, url);
    const s = await this.fresh.secrets();
    if (sub === "/logout" && req.method === "POST") return json({ ok: true }, 200, { "Set-Cookie": auth.cookieHeader("", 0) });
    if (!(await auth.sessionOk(auth.readCookie(req.headers.get("cookie")), s.cookie_key, this.p.now()))) {
      return error(401, "log in first");
    }

    if (sub === "/state" && req.method === "GET") return json(await this.state(url, s));
    if (sub === "/config" && req.method === "PUT") {
      const old = await this.fresh.config();
      const cfg = await this.fresh.saveConfig((await bodyJson(req)).config);
      const admin = modalAdmin.forGenerator(this.fetch, s.generator);
      const warnings = admin ? await this.applyToModal(admin, cfg, old.keep_warm_minutes !== cfg.keep_warm_minutes) : [];
      return json({ config: cfg, warnings });
    }
    if (sub === "/models" && req.method === "GET") return this.models(s);
    if (sub === "/models/seed" && req.method === "POST") return this.seedPack(req, s);
    if (sub === "/modal/diagnostics" && req.method === "GET") {
      const admin = modalAdmin.forGenerator(this.fetch, s.generator);
      if (!admin) return error(400, "the GPU is not on Modal");
      try {
        return json(await admin.diagnostics());
      } catch (e) {
        if (e instanceof modalAdmin.ModalAdminError) return error(502, e.message);
        throw e;
      }
    }
    if (sub === "/setup/generator" && req.method === "POST") return this.setupGenerator(req);
    if (sub === "/setup/build" && req.method === "POST") return this.startBuild(req, url, s);
    if (sub === "/setup/build" && req.method === "GET") return this.buildState(url, s);
    if (sub === "/setup/rotate-connector" && req.method === "POST") {
      await this.fresh.updateSecrets({ mcp_secret: tokenUrlsafe(24) });
      return json({ ok: true });
    }
    return error(404, "not found");
  }

  private async state(url: URL, s: Secrets) {
    const gen = s.generator;
    const setup = await this.fresh.setup();
    return {
      version: this.version,
      cloudflare: s.cf_token ? { account_id: s.cf_account_id ?? null, script: s.cf_script ?? null, branch: s.cf_branch ?? null } : null,
      generator: gen ? { kind: gen.kind ?? null, base_url: gen.base_url ?? null } : null,
      build: setup.build ?? null,
      connector_url: `${url.origin}/mcp/${s.mcp_secret}`,
      config: await this.fresh.config(),
      schema: SETTINGS_SCHEMA,
      packs: PACK_METADATA,
    };
  }

  /** A Cloudflare user token that can see this Worker proves ownership. It is also the token the
   * Worker needs for builds and updates, so the latest one is kept. */
  private async login(req: Request, url: URL): Promise<Response> {
    const token = String((await bodyJson(req)).token ?? "").trim();
    if (!token) return error(400, "paste a token");
    // Under wrangler dev the host is 127.0.0.1; DEV_WORKER_HOST names a deployed Worker instead.
    const host = this.p.env.DEV_WORKER_HOST || url.host;
    let found: cloudflare.Discovery;
    try {
      await cloudflare.verifyUserToken(this.fetch, token);
      found = await cloudflare.discover(this.fetch, token, host);
    } catch (e) {
      if (e instanceof cloudflare.CloudflareError) return error(401, e.message);
      throw e;
    }
    await this.fresh.updateSecrets({
      cf_token: token, cf_account_id: found.account_id, cf_script: found.script, cf_trigger: found.trigger, cf_branch: found.branch,
    });
    const session = await auth.makeSession((await this.fresh.secrets()).cookie_key, this.p.now());
    return json({ ok: true }, 200, { "Set-Cookie": auth.cookieHeader(session) });
  }

  /** Download state of the selected packs on Modal, for the pages to poll. */
  private async models(s: Secrets): Promise<Response> {
    const admin = modalAdmin.forGenerator(this.fetch, s.generator);
    if (!admin) return json({ packs: [] });
    const out = [];
    for (const pack of selectedPacks(await this.fresh.config())) {
      let status: Record<string, any>;
      try {
        status = await modalAdmin.packStatus(admin, this.fresh, pack);
      } catch (e) {
        if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
        status = { state: "unknown", error: e.message };
      }
      out.push({ name: pack.name, display_name: pack.display_name ?? pack.name, tool_name: pack.tool_name, size: downloadSize(pack), ...status });
    }
    return json({ packs: out });
  }

  private async seedPack(req: Request, s: Secrets): Promise<Response> {
    const admin = modalAdmin.forGenerator(this.fetch, s.generator);
    const wanted = (await bodyJson(req)).pack;
    const pack = PACKS.find((p) => p.name === wanted);
    if (!admin || !pack) return error(400, "no such pack, or the GPU is not on Modal");
    try {
      return json(await admin.seed(pack));
    } catch (e) {
      if (e instanceof modalAdmin.ModalAdminError) return error(502, e.message);
      throw e;
    }
  }

  /** A ComfyUI the Worker can reach directly (advanced; Modal is configured by the build). */
  private async setupGenerator(req: Request): Promise<Response> {
    const data = await bodyJson(req);
    const baseUrl = String(data.base_url ?? "").trim().replace(/\/+$/, "");
    const headers = data.headers && typeof data.headers === "object" && !Array.isArray(data.headers) ? data.headers : {};
    if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://")) return error(400, "base_url must be an http(s) URL");
    const resp = await new FetchTransport(this.fetch, baseUrl, headers).request("GET", "/system_stats");
    if (resp.status !== 200) return error(502, `ComfyUI did not answer at ${baseUrl}/system_stats (HTTP ${resp.status})`);
    await this.fresh.updateSecrets({ generator: { kind: "url", base_url: baseUrl, headers } });
    return json({ ok: true, system: resp.json().system ?? {} });
  }

  private async startBuild(req: Request, url: URL, s: Secrets): Promise<Response> {
    if (!s.cf_token) return error(400, "set up the Cloudflare token first");
    const data = await bodyJson(req);
    const nonce = tokenUrlsafe(24);
    await cloudflare.setBuildVars(
      this.fetch, s.cf_token, s.cf_account_id, s.cf_trigger,
      { COMFY_GEN_NONCE: nonce, MODAL_TOKEN_ID: data.modal_token_id, MODAL_TOKEN_SECRET: data.modal_token_secret },
      { COMFY_GEN_CALLBACK: `${url.origin}/build-callback` },
    );
    const build = await cloudflare.startBuild(this.fetch, s.cf_token, s.cf_account_id, s.cf_trigger, s.cf_branch || "main");
    await this.fresh.updateSetup({ build, build_nonce: nonce });
    return json({ build });
  }

  private async buildState(url: URL, s: Secrets): Promise<Response> {
    const build = (await this.fresh.setup()).build;
    if (!build || !s.cf_token) return json({ build: null });
    const [status, logs] = await Promise.all([
      cloudflare.buildStatus(this.fetch, s.cf_token, s.cf_account_id, build),
      cloudflare.buildLogs(this.fetch, s.cf_token, s.cf_account_id, build, url.searchParams.get("cursor")),
    ]);
    return json({ build, ...status, ...logs });
  }
}
