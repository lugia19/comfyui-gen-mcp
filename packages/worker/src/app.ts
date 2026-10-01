// The Worker's routes, over the Platform services, so every route is tested in Node; index.ts
// adapts Cloudflare's runtime to it.
//
// Keep the MCP path lean: packs load at module scope, and a warm call reads its state from the
// isolate cache. Each fetch to ComfyUI costs CPU, so the client backs off its polls.

import {
  Brain, ComfyUIClient, ComfyUIError, FetchTransport, McpHandler, SETTINGS_SCHEMA, UnknownTool,
  builtinPacks, downloadSize, fromHex, fromUtf8, groupByTool, packMetadata, refs, relay, select, sniffMime, tokenUrlsafe, safeEqual,
  type Config, type Content, type Pack,
} from "@comfy-gen/core";
import * as auth from "./auth.ts";
import * as cloudflare from "./cloudflare.ts";
import { PC_OFFLINE, PC_PAUSED, PcHooks, WorkerHooks } from "./hooks.ts";
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

// A sync plan creates one Modal session per file: keep it well inside the subrequest limit. The
// agent asks again once a round is done, for the rest.
export const SYNC_MAX_FILES = 20;

/** What the agent needs to know about a pack to download or check it. */
const needs = (p: Pack) => ({ name: p.name, display_name: p.display_name ?? p.name, models: p.models ?? [], required_nodes: p.required_nodes ?? {} });

/** Every LoRA file some pack is set up to use. */
const wantedLoras = (cfg: Config): string[] => [...new Set(Object.values(cfg.pack_loras).flat().map((l) => l.name as string))];

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
      if (path === "/agent/sync" && req.method === "POST") return await this.agentSync(req, url);
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
    const refused = await this.agentUnauthorized(req);
    if (refused) return refused;
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return error(426, "expected a WebSocket");
    return null;
  }

  private async agentUnauthorized(req: Request): Promise<Response | null> {
    const s = await this.fresh.secrets(); // fresh: a pairing made a moment ago must work at once
    const presented = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!s.agent_secret || !presented || !safeEqual(presented, s.agent_secret)) {
      return error(401, "This PC is not paired with this Worker. Paste a fresh pairing link from its settings page.");
    }
    return null;
  }

  /**
   * The agent's LoRA sync (design §9): it posts its LoRA files (ours only: uploaded or synced), and
   * gets back what to copy. Every LoRA on the Volume that the PC lacks is pulled (a download
   * session); one of the PC's that some pack uses and the Volume lacks is pushed (an upload session
   * the agent sends chunks to). The bytes go between the PC and Modal directly. Nothing is deleted.
   */
  private async agentSync(req: Request, url: URL): Promise<Response> {
    const refused = await this.agentUnauthorized(req);
    if (refused) return refused;
    const s = await this.fresh.secrets();
    const body = await bodyJson(req);
    const pcFiles: Record<string, unknown> = body.loras && typeof body.loras === "object" ? body.loras : {};
    const plan = { push: [] as any[], pull: [] as any[], errors: [] as string[] };
    const admin = modalAdmin.forGenerator(this.fetch, s.generator);
    const wanted = wantedLoras(await this.fresh.config());
    if (!admin) return json(plan);
    if (!s.generator.upload_url) return json({ ...plan, errors: ["Update the Modal app (run setup again) to copy LoRAs to and from it."] });
    const base = String(s.generator.upload_url).replace(/\/+$/, "");
    try {
      const onModal = await admin.loras();
      // Pull every LoRA on the Volume (all of them came in through an upload); push only ours on
      // the PC that some pack uses (uploaded to the PC before Modal was set up).
      const pull = Object.keys(onModal).filter((name) => !(name in pcFiles));
      const push = wanted.filter((name) => name in pcFiles && !(name in onModal));
      for (const name of [...push, ...pull].slice(0, SYNC_MAX_FILES)) {
        try {
          if (push.includes(name)) {
            const size = Number(pcFiles[name]);
            const session = await admin.createUpload(name, size, url.origin);
            plan.push.push({ name, size, upload_url: `${base}/u/${session.id}`, chunk_size: session.chunk_size, chunks: session.chunks });
          } else {
            const download = await admin.createDownload(name);
            plan.pull.push({ name, size: onModal[name], url: `${base}/d/${download.id}` });
          }
        } catch (e) {
          if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
          plan.errors.push(`${name}: ${e.message}`);
        }
      }
    } catch (e) {
      if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
      plan.errors.push(`Could not list the LoRAs on Modal: ${e.message}`);
    }
    return json(plan);
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

  private pcClient(): ComfyUIClient {
    return new ComfyUIClient(new RelayTransport(this.p.relay!), { requestBudget: PC_REQUEST_BUDGET, sleep: this.p.sleep, now: this.p.now });
  }

  /** The client for images on *backend* (an image id names it), or null if it is not set up. */
  private clientFor(s: Secrets, backend: refs.Backend): ComfyUIClient | null {
    if (backend === "pc") return this.pcPaired(s) ? this.pcClient() : null;
    return this.client(s.generator);
  }

  private pcPaired(s: Secrets): boolean {
    return Boolean(s.agent_secret && this.p.relay);
  }

  /** Whether the paired PC's agent is connected now. One Durable Object call, no waiting. */
  private async pcConnected(): Promise<boolean> {
    try {
      return (await this.p.relay!.status()).connected;
    } catch {
      return false; // the relay object is unreachable: offline
    }
  }

  /** A control call to the agent. Check pcConnected first: to an offline PC this waits for it. */
  private async pcControl(op: string, args?: unknown): Promise<{ ok: true; data: any } | { ok: false; message: string }> {
    const r = await this.p.relay!.control(op, args);
    if (r.offline) return { ok: false, message: PC_OFFLINE };
    return relay.controlResult(r.status, r.body);
  }

  /**
   * The generator for a call: the PC when it is paired and connected (or when it is all there is:
   * its hooks then say it is offline), otherwise the configured one (Modal, or a ComfyUI URL).
   * One Durable Object call when a PC is paired.
   */
  private async generator(s: Secrets): Promise<{ kind: "pc" | "modal" | "url"; client: ComfyUIClient; paused?: boolean } | null> {
    if (this.pcPaired(s)) {
      let online = false;
      let paused = false; // from the agent's tray: connected, but not taking requests
      try {
        const st = await this.p.relay!.status();
        online = st.connected;
        paused = st.connected && st.info?.paused === true;
      } catch {
        // the relay object is unreachable: treat the PC as offline
      }
      if (online && !paused) return { kind: "pc", client: this.pcClient() };
      if (!s.generator?.base_url) return { kind: "pc", client: this.pcClient(), paused };
    }
    const client = this.client(s.generator);
    return client ? { kind: s.generator.kind === "modal" ? "modal" : "url", client } : null;
  }

  private async mcp(req: Request, url: URL, secret: string): Promise<Response> {
    const s = await this.store.secrets();
    if (!safeEqual(secret.replace(/^\/+|\/+$/g, ""), s.mcp_secret)) return error(404, "not found");
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const cfg = await this.store.config(); // one config for every backend: Claude sees one tool list
    const specs = new Brain(PACKS, cfg, null as unknown as ComfyUIClient, "refs").specs;
    const served = new Set(specs.map((spec) => spec.name));
    const key = hmacKey(s);

    const call = async (name: string, args: Record<string, any>): Promise<[Content[], boolean]> => {
      if (!served.has(name)) throw new UnknownTool(name);
      const gen = await this.generator(s);
      if (!gen) return [[text(`Error: the image generator is not set up yet. Finish setup at ${url.origin}/`)], true];
      if (gen.paused) return [[text(`Error: ${PC_PAUSED}`)], true];
      if (name === "request_upload") return uploads.requestUpload(args, url.origin, key, this.p.now());
      const settingsUrl = `${url.origin}/`;
      const backend: refs.Backend = gen.kind === "pc" ? "pc" : "main";
      const source = (b: refs.Backend) => this.clientFor(s, b); // an image id from the other backend
      const hooks =
        gen.kind === "pc"
          ? new PcHooks(gen.client, key, this.fetch, this.store, settingsUrl, this.p.relay!, cfg.pc_keep_warm_minutes, source)
          : new WorkerHooks(gen.client, key, this.fetch, modalAdmin.forGenerator(this.fetch, s.generator), this.store, settingsUrl, "main", source);
      const brain = new Brain(PACKS, cfg, gen.client, "refs", { hooks });
      return render(await brain.call(name, args), gen.client, url.origin, key, backend);
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
    let image, backend;
    try {
      ({ image, backend } = await refs.verify(ref, hmacKey(s)));
    } catch (e) {
      if (e instanceof refs.RefError) return error(404, "not found");
      throw e;
    }
    // Served by the backend that made it, whichever answers calls now.
    const client = this.clientFor(s, backend);
    if (!client) return error(404, backend === "pc" ? "the PC that made this image is no longer paired" : "generator not set up");
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
    const gen = await this.generator(s);
    if (!gen) return error(503, "generator not set up");
    return uploads.receive(token, new Uint8Array(await req.arrayBuffer()), gen.client, hmacKey(s), this.p.now(), gen.kind === "pc" ? "pc" : "main");
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
      await this.fresh.updateSetup({ modal_error: null });
    } else if (typeof data.modal_error === "string" || String(data.modal_result ?? "").startsWith("failed")) {
      // The setup page shows Modal's reason (no card on file, a bad token) and offers Try again.
      await this.fresh.updateSetup({ modal_error: String(data.modal_error || data.modal_result).slice(0, 500) });
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
    if (sub === "/config" && req.method === "PUT") return this.saveConfig(req, s);
    if (sub === "/loras" || sub.startsWith("/loras/")) return this.loras(req, url, sub, s);
    if (sub === "/models" && req.method === "GET") return this.models(url, s);
    if (sub === "/models/seed" && req.method === "POST") return this.seedPack(req, s);
    if (sub === "/setup/generator" && req.method === "POST") return this.setupGenerator(req);
    if (sub === "/setup/build" && req.method === "POST") return this.startBuild(req, url, s);
    if (sub === "/setup/build" && req.method === "GET") return this.buildState(url, s);
    if (sub === "/pc/pair" && req.method === "POST") return this.pair(url);
    if (sub.startsWith("/pc/loras/uploads") && this.pcPaired(s)) return this.pcUploads(req, sub);
    if (sub === "/pc/pause" && req.method === "POST" && this.pcPaired(s)) {
      // The tray's pause, from here: the agent sets it and says so in a fresh hello. Not kept across
      // an agent restart, so a forgotten pause cannot send every image to Modal for days.
      const paused = (await bodyJson(req)).paused === true;
      const r = await this.pcControl("pause", { paused });
      return r.ok ? json(r.data) : error(r.message === PC_OFFLINE ? 503 : 502, r.message);
    }
    if (sub === "/pc" && req.method === "DELETE") {
      await this.fresh.updateSecrets({ agent_secret: null });
      await this.p.relay?.drop();
      return json({ ok: true });
    }
    if (sub === "/update") return this.update(req, s);
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
      update_build: setup.update_build ?? null,
      modal_error: setup.modal_error ?? null,
      connector_url: `${url.origin}/mcp/${s.mcp_secret}`,
      claude_seen: setup.claude_seen ?? null,
      pc: await this.pcState(url, s),
      config: await this.fresh.config(),
      schema: SETTINGS_SCHEMA,
      packs: PACK_METADATA,
    };
  }

  /**
   * The settings page's update: GET says which release this Worker runs and the latest; POST starts
   * the build that deploys the latest now, as the daily check would (without waiting for it).
   */
  private async update(req: Request, s: Secrets): Promise<Response> {
    const latest = await updates.latestRelease(this.fetch);
    const can = Boolean(s.cf_token && s.cf_trigger);
    if (req.method === "GET") {
      const setup = await this.fresh.setup();
      const build = setup.update_build ?? null;
      // In progress only while Cloudflare says so: a finished update build must not hide the button
      // for the next release (seen in v1.3.7). Once seen stopped it is recorded, and not asked again.
      let building = false;
      if (build && setup.update_finished !== build && can) {
        try {
          building = (await cloudflare.buildStatus(this.fetch, s.cf_token, s.cf_account_id, build)).status !== "stopped";
        } catch (e) {
          if (!(e instanceof cloudflare.CloudflareError)) throw e; // unknown: show the button
        }
        if (!building) await this.fresh.updateSetup({ update_finished: build });
      }
      return json({ current: this.version, latest, newer: updates.isNewer(latest, this.version), can, build, building });
    }
    if (req.method !== "POST") return error(405, "GET or POST");
    if (!can) return error(400, "Log in again with a Cloudflare token: this Worker has none to start builds with.");
    if (!latest) return error(502, "Could not find the latest release on GitHub. Try again in a minute.");
    return json({ build: await updates.startUpdate(this.fetch, this.fresh, latest), latest });
  }

  /** A new pairing link. A PC paired before is disconnected: its secret no longer opens the relay. */
  private async pair(url: URL): Promise<Response> {
    await this.fresh.updateSecrets({ agent_secret: tokenUrlsafe(32) });
    await this.p.relay?.drop();
    const s = await this.fresh.secrets();
    return json({ link: pairingLink(url, s.agent_secret) });
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

  /**
   * Saving the settings applies them to every backend: Modal's keep-warm and downloads, the PC's
   * downloads and a LoRA sync. Warns about LoRAs no backend has.
   */
  private async saveConfig(req: Request, s: Secrets): Promise<Response> {
    const old = await this.fresh.config();
    const cfg = await this.fresh.saveConfig((await bodyJson(req)).config);
    const admin = modalAdmin.forGenerator(this.fetch, s.generator);
    const warnings = admin ? await this.applyToModal(admin, cfg, old.keep_warm_minutes !== cfg.keep_warm_minutes) : [];
    const notes: string[] = []; // informational, not a problem
    const pcOnline = this.pcPaired(s) && (await this.pcConnected());
    if (this.pcPaired(s) && !pcOnline) {
      notes.push("Your PC is offline: its models download, and LoRAs are copied, when it is next online.");
    } else if (pcOnline) {
      // As the extension does: a newly chosen pack starts downloading now.
      for (const pack of selectedPacks(cfg)) await this.pcControl("download", { pack: needs(pack) });
      await this.pcControl("sync");
    }
    if (wantedLoras(cfg).length && (admin || pcOnline)) warnings.push(...missingLoras(cfg, await this.loraListing(s)));
    return json({ config: cfg, warnings, notes });
  }

  /**
   * The LoRA files on each backend that has a listing, for the settings page: {backends, files:
   * {name: {backend: size}}, syncing: the agent's copies in progress, errors: {backend: message}}.
   * A ComfyUI reached by URL is listed as a backend with no files.
   */
  private async loraListing(s: Secrets) {
    const out = {
      backends: [] as string[],
      files: {} as Record<string, Record<string, number>>,
      syncing: {} as Record<string, unknown>,
      errors: {} as Record<string, string>,
      offline: [] as string[], // backends not reachable now (the PC off): not an error, nothing listed
    };
    const add = (backend: string, list: Record<string, number>) => {
      for (const [name, size] of Object.entries(list ?? {})) (out.files[name] ??= {})[backend] = size;
    };
    if (this.pcPaired(s)) {
      out.backends.push("pc");
      const r = (await this.pcConnected()) ? await this.pcControl("loras") : null;
      if (!r || (!r.ok && r.message === PC_OFFLINE)) {
        out.offline.push("pc");
      } else if (r.ok) {
        add("pc", r.data?.files ?? {});
        out.syncing = r.data?.syncing ?? {};
      } else {
        out.errors.pc = r.message;
      }
    }
    const admin = modalAdmin.forGenerator(this.fetch, s.generator);
    if (admin) {
      out.backends.push("modal");
      try {
        add("modal", await admin.loras());
      } catch (e) {
        if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
        out.errors.modal = e.message;
      }
    } else if (s.generator?.kind === "url") {
      out.backends.push("url");
    }
    return out;
  }

  /** LoRA files on every backend, and upload sessions for the settings page. The browser sends the
   * bytes to the app's upload endpoint itself; this only creates, finishes and reports sessions. */
  private async loras(req: Request, url: URL, sub: string, s: Secrets): Promise<Response> {
    if (sub === "/loras" && req.method === "GET") return json(await this.loraListing(s));
    if (sub === "/loras/sync" && req.method === "POST") {
      // After an upload to Modal: the agent copies it to the PC now, not at its next connection.
      const online = this.pcPaired(s) && (await this.pcConnected());
      if (online) await this.pcControl("sync");
      return json({ started: online });
    }
    if (!sub.startsWith("/loras/uploads") && sub.startsWith("/loras/") && req.method === "DELETE") {
      return this.deleteLora(decodeURIComponent(sub.slice("/loras/".length)), s);
    }
    const admin = modalAdmin.forGenerator(this.fetch, s.generator);
    if (!admin) return error(400, "LoRAs can be uploaded only to the Modal GPU");
    const m = /^\/loras\/uploads\/([\w-]+)(\/finish)?$/.exec(sub);
    try {
      if (sub === "/loras/uploads" && req.method === "POST") {
        if (!s.generator.upload_url) return error(409, "Update the Modal app first (run setup again): it has no upload endpoint yet");
        const body = await bodyJson(req);
        const session = await admin.createUpload(String(body.filename ?? ""), Number(body.size), url.origin);
        return json({ ...session, upload_url: `${String(s.generator.upload_url).replace(/\/+$/, "")}/u/${session.id}` });
      }
      if (m && !m[2] && req.method === "GET") return json(await admin.uploadStatus(m[1]));
      if (m && m[2] && req.method === "POST") return json(await admin.finishUpload(m[1]));
    } catch (e) {
      if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
      return error(e.status >= 400 && e.status < 500 ? e.status : 502, e.message);
    }
    return error(404, "not found");
  }

  /** Delete a LoRA from every backend that has it (one way in, one way out). A PC that is offline
   * keeps its copy: it shows as PC-only, to delete again later. */
  private async deleteLora(name: string, s: Secrets): Promise<Response> {
    const from: string[] = [];
    const errors: string[] = [];
    const admin = modalAdmin.forGenerator(this.fetch, s.generator);
    if (admin) {
      try {
        await admin.deleteLora(name);
        from.push("modal");
      } catch (e) {
        if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
        if (e.status !== 404) errors.push(`Modal: ${e.message}`);
      }
    }
    if (this.pcPaired(s) && (await this.pcConnected())) {
      const r = await this.p.relay!.control("lora_delete", { name });
      if (r.status === 200) from.push("pc");
      else if (r.status !== 404) errors.push(`PC: ${fromUtf8(r.body)}`);
    }
    if (!from.length && !errors.length) return error(404, `no LoRA named ${name}`);
    return json({ deleted: name, from, errors });
  }

  /** LoRA uploads to the PC when there is no Modal: the page's chunks go to the agent over the
   * relay, one control call each, the chunk as its body. Same protocol as Modal's (upload.js). */
  private async pcUploads(req: Request, sub: string): Promise<Response> {
    const ask = async (op: string, args: unknown, body?: Uint8Array) => {
      const r = await this.p.relay!.control(op, args, 60, body);
      if (r.offline) return error(503, PC_OFFLINE);
      const result = relay.controlResult(r.status, r.body);
      if (result.ok) return json(result.data);
      return error(r.status >= 400 && r.status < 500 ? r.status : 502, result.message);
    };
    const m = /^\/pc\/loras\/uploads\/([\w-]+)(?:\/(\d+|finish))?$/.exec(sub);
    if (sub === "/pc/loras/uploads" && req.method === "POST") {
      const body = await bodyJson(req);
      const resp = await ask("upload_start", { filename: body.filename, size: body.size });
      if (!resp.ok) return resp;
      const session = (await resp.json()) as { id: string };
      return json({ ...session, upload_url: `/api/pc/loras/uploads/${session.id}` });
    }
    if (m && m[2] === "finish" && req.method === "POST") return ask("upload_finish", { id: m[1] });
    if (m && m[2] && req.method === "PUT") {
      const chunk = new Uint8Array(await req.arrayBuffer()); // passed on as it is, never looped over
      return ask("upload_chunk", { id: m[1], index: Number(m[2]), sha256: req.headers.get("x-chunk-sha256") }, chunk);
    }
    if (m && !m[2] && req.method === "GET") return ask("upload_status", { id: m[1] });
    return error(404, "not found");
  }

  /**
   * Download state of the selected packs on each backend, for the pages to poll: {backends, packs:
   * [{name, display_name, tool_name, size, on: {backend: status}}]}. ?backend= limits it to one.
   */
  private async models(url: URL, s: Secrets): Promise<Response> {
    const only = url.searchParams.get("backend");
    const packs = selectedPacks(await this.fresh.config());
    const on: Record<string, any>[] = packs.map(() => ({}));
    const backends: string[] = [];
    if (this.pcPaired(s) && (!only || only === "pc")) {
      backends.push("pc");
      const r = (await this.pcConnected()) ? await this.pcControl("models", { packs: packs.map(needs) }) : null;
      const status = new Map<string, any>(r?.ok ? (r.data as any[]).map((st) => [st.name, st]) : []);
      packs.forEach((p, i) => {
        on[i].pc = !r ? { state: "offline" } : r.ok ? status.get(p.name) ?? { state: "unknown" } : { state: "unknown", error: r.message };
      });
    }
    const admin = modalAdmin.forGenerator(this.fetch, s.generator);
    if (admin && (!only || only === "modal")) {
      backends.push("modal");
      for (const [i, pack] of packs.entries()) {
        try {
          on[i].modal = await modalAdmin.packStatus(admin, this.fresh, pack);
        } catch (e) {
          if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
          on[i].modal = { state: "unknown", error: e.message };
        }
      }
    }
    return json({
      backends,
      packs: packs.map((p, i) => ({ name: p.name, display_name: p.display_name ?? p.name, tool_name: p.tool_name, size: downloadSize(p), on: on[i] })),
    });
  }

  /** Start downloading a pack on one backend: {pack, backend: "modal" | "pc"}. */
  private async seedPack(req: Request, s: Secrets): Promise<Response> {
    const body = await bodyJson(req);
    const pack = PACKS.find((p) => p.name === body.pack);
    if (!pack) return error(400, "no such pack");
    if (body.backend === "pc") {
      if (!this.pcPaired(s)) return error(400, "no PC is paired");
      const r = await this.pcControl("download", { pack: needs(pack) });
      return r.ok ? json(r.data) : error(r.message === PC_OFFLINE ? 503 : 502, r.message);
    }
    const admin = modalAdmin.forGenerator(this.fetch, s.generator);
    if (!admin) return error(400, "the GPU is not on Modal");
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
    await this.fresh.updateSetup({ build, build_nonce: nonce, modal_error: null });
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

/** Warnings for configured LoRAs that no listed backend has. One on some backend but not another
 * gets none: the agent copies it. */
function missingLoras(
  cfg: Config,
  listing: { backends: string[]; files: Record<string, unknown>; errors: Record<string, string>; offline: string[] },
): string[] {
  const listed = listing.backends.filter((b) => b !== "url" && !listing.errors[b] && !listing.offline.includes(b));
  const unchecked = listing.backends.filter((b) => listing.errors[b]);
  const where = listed.map((b) => (b === "pc" ? "your PC" : "your Modal Volume")).join(" or ");
  const out = unchecked.map((b) => `Could not check the LoRA files on ${b === "pc" ? "your PC" : "Modal"}: ${listing.errors[b]}`);
  if (!listed.length) return out;
  for (const name of wantedLoras(cfg)) {
    if (!(name in listing.files)) out.push(`The LoRA ${name} is not on ${where}: generations will fail until it is.`);
  }
  return out;
}

/** What the agent's settings page takes: the Worker's address and the secret, in one paste. The
 * secret is in the fragment, which browsers never send, should the link be opened. */
export function pairingLink(url: URL, secret: string): string {
  return `${url.origin}/agent#${secret}`;
}
