// The Worker's routes, over the Platform services, so every route is tested in Node; index.ts
// adapts Cloudflare's runtime to it.
//
// Keep the MCP path lean: packs load at module scope, and a warm call reads its state from the
// isolate cache. Each fetch to ComfyUI costs CPU, so the client backs off its polls.

import {
  Brain, ComfyUIClient, ComfyUIError, FetchTransport, McpHandler, SETTINGS_SCHEMA, UnknownTool,
  builtinPacks, downloadSize, fromHex, groupByTool, packMetadata, refs, relay, select, sniffMime, tokenUrlsafe, safeEqual,
  type Config, type Content, type Pack,
} from "@comfy-gen/core";
import * as auth from "./auth.ts";
import * as cloudflare from "./cloudflare.ts";
import { PC_OFFLINE, PcHooks, WorkerHooks } from "./hooks.ts";
import * as modalAdmin from "./modal-admin.ts";
import { bodyJson, error, json, withUserAgent, type Fetch, type Platform } from "./platform.ts";
import { render, text } from "./render.ts";
import { RelayTransport } from "./relay.ts";
import { Store, type Secrets } from "./store.ts";
import * as updates from "./updates.ts";
import * as uploads from "./uploads.ts";

export const PACKS = builtinPacks();
const GROUPS = groupByTool(PACKS);

// Of the free plan's 50 external subrequests per invocation, what one MCP call may spend on
// ComfyUI. The rest covers downloading an edit_image URL and its upload.
export const REQUEST_BUDGET = 44;
// Over the relay each ComfyUI request is a Durable Object call, counted against the 1,000 internal
// subrequests, not the 50 external ones.
export const PC_REQUEST_BUDGET = 300;
export const MODAL_COLD_START_S = 300;

export const INSTRUCTIONS =
  "Images come back inline, each followed by its image_id. Pass an image_id to edit_image to edit that image.";

/** What the settings page needs to render pack choices. */
export const PACK_METADATA = packMetadata(PACKS);

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
    this.store = new Store(platform.storage, platform.now);
    this.fresh = new Store(platform.storage, platform.now, false);
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

  /** Why the agent's WebSocket must be refused (a Response), or null to hand it to the Relay. The
   * secret is checked first, so the agent can tell "not paired" (401) from "paired" (426 to a plain
   * GET) without opening a socket. */
  async agentRefusal(req: Request): Promise<Response | null> {
    const s = await this.fresh.secrets(); // fresh: a pairing made a moment ago must work at once
    const presented = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!s.agent_secret || !presented || !safeEqual(presented, s.agent_secret)) {
      return error(401, "This PC is not paired with this Worker. Paste a fresh pairing link from its settings page.");
    }
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return error(426, "expected a WebSocket");
    return null;
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

  private pcPaired(s: Secrets): boolean {
    return Boolean(s.agent_secret && this.p.relay);
  }

  /**
   * The generator for a call: the PC when it is paired and connected (or when it is all there is:
   * its hooks then say it is offline), otherwise the configured one (Modal, or a ComfyUI URL).
   * One Durable Object call when a PC is paired.
   */
  private async generator(s: Secrets): Promise<{ kind: "pc" | "modal" | "url"; client: ComfyUIClient } | null> {
    if (this.pcPaired(s)) {
      let online = false;
      try {
        online = (await this.p.relay!.status()).connected;
      } catch {
        // the relay object is unreachable: treat the PC as offline
      }
      if (online || !s.generator?.base_url) {
        const client = new ComfyUIClient(new RelayTransport(this.p.relay!), { requestBudget: PC_REQUEST_BUDGET, sleep: this.p.sleep, now: this.p.now });
        return { kind: "pc", client };
      }
    }
    const client = this.client(s.generator);
    return client ? { kind: s.generator.kind === "modal" ? "modal" : "url", client } : null;
  }

  private async mcp(req: Request, url: URL, secret: string): Promise<Response> {
    const s = await this.store.secrets();
    if (!safeEqual(secret.replace(/^\/+|\/+$/g, ""), s.mcp_secret)) return error(404, "not found");
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    // Claude sees one tool list, built from the PC's settings while one is paired; each call then
    // runs with the settings of the backend that answers it.
    const modalCfg = await this.store.config();
    const pcCfg = this.pcPaired(s) ? await this.store.pcConfig() : null;
    const specs = new Brain(PACKS, pcCfg ?? modalCfg, null as unknown as ComfyUIClient, "refs").specs;
    const served = new Set(specs.map((spec) => spec.name));
    const key = hmacKey(s);

    const call = async (name: string, args: Record<string, any>): Promise<[Content[], boolean]> => {
      if (!served.has(name)) throw new UnknownTool(name);
      const gen = await this.generator(s);
      if (!gen) return [[text(`Error: the image generator is not set up yet. Finish setup at ${url.origin}/`)], true];
      if (name === "request_upload") return uploads.requestUpload(args, url.origin, key, this.p.now());
      const settingsUrl = `${url.origin}/`;
      const cfg = gen.kind === "pc" ? pcCfg! : modalCfg;
      const hooks =
        gen.kind === "pc"
          ? new PcHooks(gen.client, key, this.fetch, this.store, settingsUrl, this.p.relay!, cfg.keep_warm_minutes)
          : new WorkerHooks(gen.client, key, this.fetch, modalAdmin.forGenerator(this.fetch, s.generator), this.store, settingsUrl);
      const brain = new Brain(PACKS, cfg, gen.client, "refs", { hooks });
      return render(await brain.call(name, args), gen.client, url.origin, key);
    };

    const handler = new McpHandler("Comfy-Gen-MCP", this.version, specs, call, INSTRUCTIONS);
    let listed = false; // claude.ai lists the tools once the connector is added: setup's last step
    const [status, body] = await handler.handle(await req.text(), (m) => (listed ||= m === "tools/list"));
    if (listed && !(await this.store.setup()).claude_seen) await this.store.updateSetup({ claude_seen: this.p.now() });
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
    const client = (await this.generator(s))?.client;
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
    const client = (await this.generator(s))?.client;
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
        upload_url: modal.upload_url ?? null,
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
      if (admin) warnings.push(...(await missingLoras(admin, cfg)));
      return json({ config: cfg, warnings });
    }
    if (sub === "/loras" || sub.startsWith("/loras/")) return this.loras(req, url, sub, s);
    if (sub === "/models" && req.method === "GET") return this.models(s);
    if (sub === "/models/seed" && req.method === "POST") return this.seedPack(req, s);
    if (sub === "/setup/generator" && req.method === "POST") return this.setupGenerator(req);
    if (sub === "/setup/build" && req.method === "POST") return this.startBuild(req, url, s);
    if (sub === "/setup/build" && req.method === "GET") return this.buildState(url, s);
    if (sub === "/pc/pair" && req.method === "POST") return this.pair(url);
    if (sub.startsWith("/pc/") && this.pcPaired(s)) {
      const r = await this.pcApi(req, sub);
      if (r) return r;
    }
    if (sub === "/pc" && req.method === "DELETE") {
      await this.fresh.updateSecrets({ agent_secret: null });
      await this.p.relay?.drop();
      return json({ ok: true });
    }
    if (sub === "/setup/rotate-connector" && req.method === "POST") {
      await this.fresh.updateSecrets({ mcp_secret: tokenUrlsafe(24) });
      await this.fresh.updateSetup({ claude_seen: null }); // the new URL has to be added again
      return json({ ok: true });
    }
    return error(404, "not found");
  }

  private async state(url: URL, s: Secrets) {
    const gen = s.generator;
    const setup = await this.fresh.setup();
    return {
      version: this.version,
      cloudflare: s.cf_token ? { account_id: s.cf_account_id ?? null, script: s.cf_script ?? null } : null,
      generator: gen ? { kind: gen.kind ?? null, base_url: gen.base_url ?? null } : null,
      build: setup.build ?? null,
      connector_url: `${url.origin}/mcp/${s.mcp_secret}`,
      claude_seen: setup.claude_seen ?? null,
      pc: await this.pcState(url, s),
      config: await this.fresh.config(),
      pc_config: this.pcPaired(s) ? await this.fresh.pcConfig() : null,
      schema: SETTINGS_SCHEMA,
      packs: PACK_METADATA,
    };
  }

  /** A new pairing link. A PC paired before is disconnected: its secret no longer opens the relay. */
  private async pair(url: URL): Promise<Response> {
    await this.fresh.updateSecrets({ agent_secret: tokenUrlsafe(32) });
    await this.p.relay?.drop();
    const s = await this.fresh.secrets();
    return json({ link: pairingLink(url, s.agent_secret) });
  }

  /** The settings pages' view of the PC, through the agent: LoRA files, model downloads. */
  private async pcApi(req: Request, sub: string): Promise<Response | null> {
    const relayStub = this.p.relay!;
    const ask = async (op: string, args?: unknown) => {
      const r = await relayStub.control(op, args);
      if (r.offline) return error(503, PC_OFFLINE);
      const result = relay.controlResult(r.status, r.body);
      return result.ok ? json(result.data) : error(502, result.message);
    };
    const needs = (p: Pack) => ({ name: p.name, display_name: p.display_name ?? p.name, models: p.models ?? [], required_nodes: p.required_nodes ?? {} });
    if (sub === "/pc/loras" && req.method === "GET") {
      const resp = await ask("loras");
      return resp.ok ? json({ loras: await resp.json() }) : resp;
    }
    if (sub === "/pc/config" && req.method === "PUT") {
      const cfg = await this.fresh.savePcConfig((await bodyJson(req)).config);
      // As the extension does: a newly chosen pack starts downloading now, if the PC is online.
      // (A status check first: a control call to an offline PC waits for it to come back.)
      if (!(await relayStub.status()).connected) {
        return json({ config: cfg, warnings: ["Your PC is offline: its models download when it is next asked for an image."] });
      }
      for (const pack of selectedPacks(cfg)) await relayStub.control("download", { pack: needs(pack) });
      return json({ config: cfg, warnings: [] });
    }
    if (sub === "/pc/models" && req.method === "GET") {
      const packs = selectedPacks(await this.fresh.pcConfig());
      const resp = await ask("models", { packs: packs.map(needs) });
      if (!resp.ok) return resp;
      const status = new Map(((await resp.json()) as any[]).map((s) => [s.name, s]));
      return json({ packs: packs.map((p) => ({ name: p.name, display_name: p.display_name ?? p.name, tool_name: p.tool_name, size: downloadSize(p), ...status.get(p.name) })) });
    }
    if (sub === "/pc/models/seed" && req.method === "POST") {
      const wanted = (await bodyJson(req)).pack;
      const pack = PACKS.find((p) => p.name === wanted);
      if (!pack) return error(400, "no such pack");
      return ask("download", { pack: needs(pack) });
    }
    return null;
  }

  private async pcState(url: URL, s: Secrets) {
    if (!this.pcPaired(s)) return { paired: false };
    let status = { connected: false, since: null as number | null, info: null as Record<string, unknown> | null };
    try {
      status = await this.p.relay!.status();
    } catch {
      // unreachable: shown as offline
    }
    return { paired: true, link: pairingLink(url, s.agent_secret), ...status };
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

  /** LoRA files on the Modal Volume, and upload sessions for the settings page. The browser sends the
   * bytes to the app's upload endpoint itself; this only creates, finishes and reports sessions. */
  private async loras(req: Request, url: URL, sub: string, s: Secrets): Promise<Response> {
    const admin = modalAdmin.forGenerator(this.fetch, s.generator);
    if (!admin) return error(400, "LoRAs can be uploaded only to the Modal GPU");
    const m = /^\/loras\/uploads\/([\w-]+)(\/finish)?$/.exec(sub);
    try {
      if (sub === "/loras" && req.method === "GET") return json({ loras: await admin.loras() });
      if (sub === "/loras/uploads" && req.method === "POST") {
        if (!s.generator.upload_url) return error(409, "Update the Modal app first (run setup again): it has no upload endpoint yet");
        const body = await bodyJson(req);
        const session = await admin.createUpload(String(body.filename ?? ""), Number(body.size), url.origin);
        return json({ ...session, upload_url: `${String(s.generator.upload_url).replace(/\/+$/, "")}/u/${session.id}` });
      }
      if (m && !m[2] && req.method === "GET") return json(await admin.uploadStatus(m[1]));
      if (m && m[2] && req.method === "POST") return json(await admin.finishUpload(m[1]));
      if (!m && sub.startsWith("/loras/") && req.method === "DELETE") {
        return json(await admin.deleteLora(decodeURIComponent(sub.slice("/loras/".length))));
      }
    } catch (e) {
      if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
      return error(e.status >= 400 && e.status < 500 ? e.status : 502, e.message);
    }
    return error(404, "not found");
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

/** Warnings for configured LoRAs whose file is not on the Volume. One admin call, only when some are set. */
async function missingLoras(admin: modalAdmin.ModalAdmin, cfg: Config): Promise<string[]> {
  const wanted = Object.values(cfg.pack_loras).flat().map((l) => l.name);
  if (!wanted.length) return [];
  let have: Record<string, number>;
  try {
    have = await admin.loras();
  } catch (e) {
    if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
    return [`Could not check the LoRA files: ${e.message}`];
  }
  return [...new Set(wanted)].filter((n) => !(n in have)).map((n) => `The LoRA ${n} is not uploaded: generations will fail until it is.`);
}

/** What the agent's settings page takes: the Worker's address and the secret, in one paste. The
 * secret is in the fragment, which browsers never send, should the link be opened. */
export function pairingLink(url: URL, secret: string): string {
  return `${url.origin}/agent#${secret}`;
}
