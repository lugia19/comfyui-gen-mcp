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
import { gpusOf, newPcId, newPcName, splitToken, DEFAULT_KEEP_WARM, type Gpu } from "./gpus.ts";
import { offlineMessage, pausedMessage, PcHooks, WorkerHooks } from "./hooks.ts";
import * as loras from "./loras.ts";
import * as modalAdmin from "./modal-admin.ts";
import { bodyJson, error, json, withUserAgent, type Fetch, type Platform } from "./platform.ts";
import { serveImage } from "./images.ts";
import { render, text } from "./render.ts";
import { RelayTransport } from "./relay.ts";
import { Store, type Secrets } from "./store.ts";

type GpuStatus = { online: boolean; paused: boolean; since: number | null; info: Record<string, unknown> | null };
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
// Password logins: this many wrong ones within the window pause them (the token login stays open).
export const LOGIN_FAILS_MAX = 10;
export const LOGIN_WINDOW_S = 3600;

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
      if (path.startsWith("/img/") && req.method === "GET") return await serveImage(this.p.bucket, path.slice(5));
      if (path.startsWith("/upload/") && req.method === "POST") return await this.upload(req, path.slice(8));
      if (path === "/build-callback" && req.method === "POST") return await this.buildCallback(req);
      if (path === "/agent/sync" && req.method === "POST") return await this.agentSync(req, url);
      if (path.startsWith("/agent/loras/uploads")) return await this.agentUpload(req, url, path.slice("/agent".length));
      if (path.startsWith("/store/") && req.method === "GET") return await this.storeLink(req, path.slice(7));
      if (path.startsWith("/api/")) return await this.api(req, url, path.slice(4));
    } catch (e) {
      if (e instanceof cloudflare.CloudflareError) return error(502, e.message);
      throw e;
    }
    return error(404, "not found");
  }

  /** The agent's WebSocket: the id of its PC (whose Relay object takes the socket), or why it is
   * refused. The secret is checked first, so the agent can tell "not paired" (401) from "paired"
   * (426 to a plain GET) without opening a socket. */
  async agentGate(req: Request): Promise<Response | string> {
    const pc = await this.agentPc(req);
    if (pc instanceof Response) return pc;
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return error(426, "expected a WebSocket");
    return pc.id;
  }

  /** The PC whose pairing secret the request carries, or a 401. */
  private async agentPc(req: Request): Promise<Gpu | Response> {
    const presented = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    // fresh: a pairing made a moment ago must work at once
    const pc = presented ? (await this.gpus(this.fresh)).find((g) => g.kind === "pc" && g.secret && safeEqual(presented, g.secret)) : null;
    return pc ?? error(401, "This PC is not paired with this Worker. Paste a fresh pairing link from its settings page.");
  }

  /**
   * The agent's LoRA sync (design §9): it posts its LoRA files (ours only: uploaded or synced), and
   * gets back what to do. pull: every LoRA in R2 the PC lacks, as a storage link. push: one of the
   * PC's that R2 lacks (uploaded before R2), as an upload to /agent/loras/uploads. delete: one the
   * PC still has that was deleted while it was offline. The agent asks again after a round with
   * work in it, for the rest.
   */
  private async agentSync(req: Request, url: URL): Promise<Response> {
    const pc = await this.agentPc(req);
    if (pc instanceof Response) return pc;
    const s = await this.fresh.secrets();
    const body = await bodyJson(req);
    const pcFiles: Record<string, unknown> = body.loras && typeof body.loras === "object" ? body.loras : {};
    const plan = { push: [] as any[], pull: [] as any[], delete: [] as string[], errors: [] as string[] };
    const inR2 = await loras.stored(this.p.bucket);
    const deleted: Record<string, number> = (await this.fresh.setup()).lora_deleted ?? {};
    plan.delete = Object.keys(pcFiles).filter((name) => name in deleted && !(name in inR2));
    const uploads = new loras.LoraUploads(this.p.bucket, this.fresh, this.p.now);
    const pull = Object.keys(inR2).filter((name) => !(name in pcFiles));
    const push = Object.keys(pcFiles).filter((name) => !(name in inR2) && !(name in deleted));
    for (const name of pull.slice(0, SYNC_MAX_FILES)) {
      plan.pull.push({ name, size: inR2[name], url: await this.storeUrl(url.origin, hmacKey(s), loras.loraKey(name)) });
    }
    for (const name of push.slice(0, Math.max(0, SYNC_MAX_FILES - plan.pull.length))) {
      try {
        const size = Number(pcFiles[name]);
        const session = await uploads.start(name, size);
        plan.push.push({ name, size, upload_url: `${url.origin}/agent/loras/uploads/${session.id}`, chunk_size: session.chunk_size, chunks: session.chunks });
      } catch (e) {
        if (!(e instanceof loras.LoraError)) throw e;
        plan.errors.push(`${name}: ${e.message}`);
      }
    }
    return json(plan);
  }

  /** A storage link for *key*: a GPU downloads it without other auth. Six hours, for slow lines. */
  private async storeUrl(origin: string, key: Uint8Array, object: string): Promise<string> {
    return `${origin}/store/${await refs.mintStore(key, object, this.p.now(), 6 * 3600)}`;
  }

  /** GET /store/<token>: the stored object a storage link names, with Range for resuming. */
  private async storeLink(req: Request, token: string): Promise<Response> {
    const s = await this.store.secrets();
    let object: string;
    try {
      object = await refs.checkStore(decodeURIComponent(token), hmacKey(s), this.p.now());
    } catch (e) {
      if (e instanceof refs.RefError) return error(403, e.message);
      throw e;
    }
    return loras.serveStored(this.p.bucket, object, req);
  }

  /** The agent's pushes: the same upload protocol as the settings page, with its bearer secret. */
  private async agentUpload(req: Request, url: URL, sub: string): Promise<Response> {
    const pc = await this.agentPc(req);
    if (pc instanceof Response) return pc;
    return this.loraUploads(req, url, sub, await this.fresh.secrets());
  }

  async scheduled(): Promise<string> {
    const result = await updates.check(this.fetch, this.store, this.version);
    console.log(`update check: ${result}`);
    return result;
  }

  // ── GPUs ──────────────────────────────────────────────────────────

  /** The GPU list, converted once from a Worker's older generator and paired PC. */
  async gpus(store: Store = this.fresh): Promise<Gpu[]> {
    const s = await store.secrets();
    const { gpus, converted } = gpusOf(s, await store.config());
    if (converted && (s.generator || s.agent_secret)) await this.saveGpus(gpus);
    return gpus;
  }

  private async saveGpus(gpus: Gpu[]): Promise<void> {
    await this.fresh.updateSecrets({ gpus, generator: null, agent_secret: null });
  }

  private async updateGpu(id: string, changes: Partial<Gpu>): Promise<Gpu | null> {
    const gpus = await this.gpus();
    const i = gpus.findIndex((g) => g.id === id);
    if (i < 0) return null;
    gpus[i] = { ...gpus[i], ...changes };
    await this.saveGpus(gpus);
    return gpus[i];
  }

  private client(gpu: Gpu): ComfyUIClient {
    if (gpu.kind === "pc") {
      return new ComfyUIClient(new RelayTransport(this.p.relays(gpu.id)), { requestBudget: PC_REQUEST_BUDGET, sleep: this.p.sleep, now: this.p.now });
    }
    return new ComfyUIClient(new FetchTransport(this.fetch, gpu.base_url!, gpu.headers ?? {}), {
      coldStartS: gpu.cold_start_s ?? 0,
      requestBudget: REQUEST_BUDGET,
      sleep: this.p.sleep,
      now: this.p.now,
    });
  }

  private admin(gpu: Gpu): modalAdmin.ModalAdmin | null {
    return gpu.kind === "modal" && gpu.admin_url ? new modalAdmin.ModalAdmin(this.fetch, gpu.admin_url, gpu.headers ?? {}) : null;
  }

  /** Whether a GPU can take a call now. A PC: its agent connected and not paused (one Durable Object
   * call, no waiting). Modal and a URL: always (Modal starts on the call). */
  private async status(gpu: Gpu): Promise<GpuStatus> {
    if (gpu.kind !== "pc") return { online: true, paused: false, since: null, info: null };
    try {
      const st = await this.p.relays(gpu.id).status();
      return { online: st.connected, paused: st.connected && st.info?.paused === true, since: st.since, info: st.info };
    } catch {
      return { online: false, paused: false, since: null, info: null }; // the relay object is unreachable: offline
    }
  }

  /** A control call to a PC's agent. Check status() first: to an offline PC this waits for it. */
  private async control(gpu: Gpu, op: string, args?: unknown): Promise<{ ok: true; data: any } | { ok: false; message: string }> {
    const r = await this.p.relays(gpu.id).control(op, args);
    if (r.offline) return { ok: false, message: offlineMessage([gpu]) };
    return relay.controlResult(r.status, r.body);
  }

  /** The PCs that are online now. */
  private async onlinePcs(gpus: Gpu[]): Promise<Gpu[]> {
    const pcs = gpus.filter((g) => g.kind === "pc");
    const online = await Promise.all(pcs.map(async (g) => (await this.status(g)).online));
    return pcs.filter((_, i) => online[i]);
  }

  /** Whether a GPU has a pack's models: true, false (downloading, or missing), or null when not
   * known yet (a PC that has not been asked). Modal's from its seed cache (downloads it finished), a
   * PC's from its last ensure or models check. A ComfyUI by URL has what it has. */
  private ready(gpu: Gpu, setup: Record<string, any>, pack: Pack): boolean | null {
    if (gpu.kind === "url" || !pack.models?.length) return true;
    if (gpu.kind === "modal" && (setup.seeded ?? []).includes(pack.name)) return true;
    return setup.ready?.[gpu.id]?.[pack.name] ?? null;
  }

  private async setReady(gpu: Gpu, pack: string, ready: boolean): Promise<void> {
    const setup = await this.fresh.setup();
    const known: Record<string, boolean> = setup.ready?.[gpu.id] ?? {};
    if (known[pack] === ready) return;
    await this.fresh.updateSetup({ ready: { ...(setup.ready ?? {}), [gpu.id]: { ...known, [pack]: ready } } });
  }

  /**
   * The GPU for a call (design §2, "GPUs"): the first enabled one, in the list's order, that is
   * available and not known to lack *pack* (unknown is worth a try: its answer says); else the first
   * available, which starts the download. *skip*: GPUs this call already found downloading. A
   * message instead when none is available.
   */
  private async pick(gpus: Gpu[], pack: Pack | null, skip: Gpu[] = []): Promise<Gpu | string> {
    const enabled = gpus.filter((g) => g.enabled);
    if (!enabled.length) return "No GPU is set up yet.";
    const statuses = await Promise.all(enabled.map((g) => this.status(g)));
    const available = enabled.filter((_, i) => statuses[i].online && !statuses[i].paused);
    if (!available.length) {
      const paused = enabled.filter((_, i) => statuses[i].paused);
      return paused.length ? pausedMessage(paused) : offlineMessage(enabled);
    }
    const left = available.filter((g) => !skip.includes(g));
    if (pack) {
      const setup = await this.store.setup();
      const ready = left.find((g) => this.ready(g, setup, pack) !== false);
      if (ready) return ready;
    }
    return left[0] ?? available[0];
  }

  // ── MCP ───────────────────────────────────────────────────────────

  private async mcp(req: Request, url: URL, secret: string): Promise<Response> {
    const s = await this.store.secrets();
    if (!safeEqual(secret.replace(/^\/+|\/+$/g, ""), s.mcp_secret)) return error(404, "not found");
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const cfg = await this.store.config(); // one config for every GPU: Claude sees one tool list
    const specs = new Brain(PACKS, cfg, null as unknown as ComfyUIClient, "refs").specs;
    const served = new Set(specs.map((spec) => spec.name));
    const key = hmacKey(s);

    const call = async (name: string, args: Record<string, any>): Promise<[Content[], boolean]> => {
      if (!served.has(name)) throw new UnknownTool(name);
      // Uploads go to R2: no GPU needed.
      if (name === "request_upload") return uploads.requestUpload(args, url.origin, key, this.p.now());
      const gpus = await this.gpus(this.store);
      if (!gpus.length) return [[text(`Error: no GPU is set up yet. Finish setup at ${url.origin}/`)], true];
      const pack = selectedPacks(cfg).find((p) => p.tool_name === name) ?? null;
      let gpu: Gpu | string;
      if (name === "fetch_result") {
        // The token names the GPU the job is on: only that one has it.
        const [on, promptId] = splitToken(String(args.request_token ?? ""), gpus);
        args = { ...args, request_token: promptId };
        if (on) {
          const st = await this.status(on);
          gpu = st.online ? on : offlineMessage([on]);
        } else {
          gpu = await this.pick(gpus, null);
        }
      } else {
        gpu = await this.pick(gpus, pack);
      }
      if (typeof gpu === "string") return [[text(`Error: ${gpu}`)], true];
      const tried: Gpu[] = [];
      for (;;) {
        const target: Gpu = gpu;
        let downloading = false; // this GPU lacks the pack: it starts the download, the next may answer
        const onReady = async (packName: string, ready: boolean) => {
          downloading = !ready;
          if (target.kind === "pc") await this.setReady(target, packName, ready);
        };
        const client = this.client(target);
        const hooks =
          target.kind === "pc"
            ? new PcHooks(client, key, this.fetch, this.store, `${url.origin}/`, this.p.relays(target.id), target, this.p.bucket, onReady)
            : new WorkerHooks(client, key, this.fetch, this.admin(target), this.store, `${url.origin}/`, this.p.bucket, onReady);
        const outcome = await new Brain(PACKS, cfg, client, "refs", { hooks }).call(name, args);
        tried.push(target);
        if (outcome.kind === "failed" && downloading && name !== "fetch_result") {
          const next = await this.pick(gpus, pack, tried);
          if (typeof next !== "string" && !tried.includes(next)) {
            gpu = next;
            continue;
          }
        }
        if (outcome.kind === "pending") outcome.token = `${target.id}:${outcome.token}`;
        return render(outcome, client, url.origin, this.p.bucket);
      }
    };

    const handler = new McpHandler("Comfy-Gen-MCP", this.version, specs, call, INSTRUCTIONS);
    let listed = false; // claude.ai lists the tools once the connector is added: setup's last step
    const [status, body] = await handler.handle(await req.text(), (m) => (listed ||= m === "tools/list"));
    if (listed && !(await this.store.setup()).claude_seen) await this.store.updateSetup({ claude_seen: this.p.now() });
    if (body === null) return new Response(null, { status });
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }

  private async upload(req: Request, token: string): Promise<Response> {
    const s = await this.store.secrets();
    return uploads.receive(token, new Uint8Array(await req.arrayBuffer()), this.p.bucket, hmacKey(s), this.p.now());
  }

  // ── builds ────────────────────────────────────────────────────────

  private async buildCallback(req: Request): Promise<Response> {
    const data = await bodyJson(req);
    const expected = (await this.fresh.setup()).build_nonce;
    if (!expected || !safeEqual(String(data.nonce ?? ""), expected)) return error(403, "bad nonce");
    const modal = data.modal;
    let warnings: string[] = [];
    if (modal && typeof modal === "object" && modal.server_url) {
      // The Modal GPU: added at the end of the list (a fallback behind the PCs), or updated in place.
      const gpus = await this.gpus();
      const old = gpus.find((g) => g.kind === "modal");
      const gpu: Gpu = {
        id: "modal", kind: "modal", name: old?.name ?? "Modal", enabled: old?.enabled ?? true,
        keep_warm_minutes: old?.keep_warm_minutes ?? DEFAULT_KEEP_WARM,
        base_url: modal.server_url,
        admin_url: modal.admin_url ?? null,
        headers: { "Modal-Key": modal.proxy_token_id ?? "", "Modal-Secret": modal.proxy_token_secret ?? "" },
        cold_start_s: MODAL_COLD_START_S,
      };
      await this.saveGpus(old ? gpus.map((g) => (g === old ? gpu : g)) : [...gpus, gpu]);
      // A deploy resets keep-warm to the app's default, and a fresh install has no models yet.
      warnings = await this.applyToModal(this.admin(gpu)!, await this.fresh.config(), gpu.keep_warm_minutes);
      warnings.push(...(await this.spreadLoras(new URL(req.url).origin)).warnings);
      await this.fresh.updateSetup({ modal_error: null });
    } else if (typeof data.modal_error === "string" || String(data.modal_result ?? "").startsWith("failed")) {
      // The setup page shows Modal's reason (no card on file, a bad token) and offers Try again.
      await this.fresh.updateSetup({ modal_error: String(data.modal_error || data.modal_result).slice(0, 500) });
    }
    return json({ ok: true, warnings });
  }

  /** Best effort: apply keep-warm (when given), start downloads for selected packs. Returns warnings.
   * LoRAs are spreadLoras' (the callers call it after). */
  private async applyToModal(admin: modalAdmin.ModalAdmin, cfg: Config, keepWarmMinutes: number | null): Promise<string[]> {
    const warnings: string[] = [];
    if (keepWarmMinutes !== null) {
      try {
        await admin.idle(keepWarmMinutes);
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
    // The login screen asks which way in to offer: a password once one is set, else a token.
    if (sub === "/login" && req.method === "GET") return json({ password: Boolean((await this.fresh.secrets()).password) });
    const s = await this.fresh.secrets();
    if (sub === "/logout" && req.method === "POST") return json({ ok: true }, 200, { "Set-Cookie": auth.cookieHeader("", 0) });
    if (!(await auth.sessionOk(auth.readCookie(req.headers.get("cookie")), s.cookie_key, this.p.now()))) {
      return error(401, "log in first");
    }

    if (sub === "/state" && req.method === "GET") return json(await this.state(url, s));
    if (sub === "/password" && req.method === "PUT") {
      const password = String((await bodyJson(req)).password ?? "");
      if (password.length < auth.PASSWORD_MIN) return error(400, `Use at least ${auth.PASSWORD_MIN} characters.`);
      await this.fresh.updateSecrets({ password: await auth.makePassword(password) });
      return json({ ok: true });
    }
    if (sub === "/config" && req.method === "PUT") return this.saveConfig(req, s);
    if (sub === "/loras" || sub.startsWith("/loras/")) return this.loras(req, url, sub, s);
    if (sub === "/models" && req.method === "GET") return this.models(url, s);
    if (sub === "/models/seed" && req.method === "POST") return this.seedPack(req, s);
    if (sub === "/setup/generator" && req.method === "POST") return this.setupGenerator(req);
    if (sub === "/setup/build" && req.method === "POST") return this.startBuild(req, url, s);
    if (sub === "/setup/build" && req.method === "GET") return this.buildState(url, s);
    if (sub === "/gpus" || sub.startsWith("/gpus/")) return this.gpuApi(req, url, sub);
    if (sub === "/update") return this.update(req, s);
    if (sub === "/setup/rotate-connector" && req.method === "POST") {
      await this.fresh.updateSecrets({ mcp_secret: tokenUrlsafe(24) });
      await this.fresh.updateSetup({ claude_seen: null }); // the new URL has to be added again
      return json({ ok: true });
    }
    return error(404, "not found");
  }

  private async state(url: URL, s: Secrets) {
    const setup = await this.fresh.setup();
    return {
      version: this.version,
      cloudflare: s.cf_token ? { account_id: s.cf_account_id ?? null, script: s.cf_script ?? null } : null,
      gpus: await this.gpuStates(url),
      build: setup.build ?? null,
      update_build: setup.update_build ?? null,
      modal_error: setup.modal_error ?? null,
      connector_url: `${url.origin}/mcp/${s.mcp_secret}`,
      claude_seen: setup.claude_seen ?? null,
      password_set: Boolean(s.password),
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

  /**
   * The GPU list (design §2, "GPUs"):
   *   POST   /gpus/pc            add a PC: {id, link} (the pairing link for its agent)
   *   POST   /gpus/<id>/pair     a new pairing link; the old one stops working, its agent is dropped
   *   POST   /gpus/<id>/pause    {paused}: the tray's pause, from here. The agent keeps it in memory
   *                              only, so a forgotten pause cannot send every image elsewhere for days
   *   PATCH  /gpus/<id>          {name, enabled, keep_warm_minutes}
   *   PUT    /gpus/order         {ids}: the priority order
   *   DELETE /gpus/<id>          remove it (a PC's agent is dropped; Modal's app stays deployed)
   */
  private async gpuApi(req: Request, url: URL, sub: string): Promise<Response> {
    const gpus = await this.gpus();
    if (sub === "/gpus/pc" && req.method === "POST") {
      const gpu: Gpu = { id: newPcId(gpus), kind: "pc", name: newPcName(gpus), enabled: true, keep_warm_minutes: DEFAULT_KEEP_WARM, secret: tokenUrlsafe(32), seen: null };
      // A new PC goes first: a GPU of one's own is free, the others are the fallback.
      await this.saveGpus([gpu, ...gpus]);
      return json({ id: gpu.id, link: pairingLink(url, gpu.secret!) });
    }
    if (sub === "/gpus/order" && req.method === "PUT") {
      const ids = (await bodyJson(req)).ids;
      if (!Array.isArray(ids) || ids.length !== gpus.length || !gpus.every((g) => ids.includes(g.id))) return error(400, "ids must list every GPU once");
      await this.saveGpus(ids.map((id: string) => gpus.find((g) => g.id === id)!));
      return json({ ok: true });
    }
    const m = /^\/gpus\/([\w-]+)(?:\/(pair|pause))?$/.exec(sub);
    const gpu = m ? gpus.find((g) => g.id === m[1]) : undefined;
    if (!m || !gpu) return error(404, "no such GPU");
    if (m[2] === "pair" && req.method === "POST" && gpu.kind === "pc") {
      const secret = tokenUrlsafe(32);
      await this.updateGpu(gpu.id, { secret, seen: null }); // a new PC starts at the pairing view
      await this.p.relays(gpu.id).drop();
      return json({ link: pairingLink(url, secret) });
    }
    if (m[2] === "pause" && req.method === "POST" && gpu.kind === "pc") {
      const r = await this.control(gpu, "pause", { paused: (await bodyJson(req)).paused === true });
      return r.ok ? json(r.data) : error(r.message === offlineMessage([gpu]) ? 503 : 502, r.message);
    }
    if (!m[2] && req.method === "PATCH") {
      const body = await bodyJson(req);
      const changes: Partial<Gpu> = {};
      if (typeof body.name === "string" && body.name.trim()) changes.name = body.name.trim().slice(0, 60);
      if (typeof body.enabled === "boolean") changes.enabled = body.enabled;
      if (body.keep_warm_minutes !== undefined) {
        const minutes = Number(body.keep_warm_minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) return error(400, "keep_warm_minutes must be 1 to 60");
        changes.keep_warm_minutes = minutes;
      }
      const updated = (await this.updateGpu(gpu.id, changes))!;
      const warnings: string[] = [];
      const admin = this.admin(updated);
      if (admin && changes.keep_warm_minutes !== undefined) {
        try {
          await admin.idle(updated.keep_warm_minutes);
        } catch (e) {
          if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
          warnings.push(`Could not apply keep-warm: ${e.message}`);
        }
      }
      return json({ gpu: redact(updated, url), warnings });
    }
    if (!m[2] && req.method === "DELETE") {
      await this.saveGpus(gpus.filter((g) => g !== gpu));
      if (gpu.kind === "pc") await this.p.relays(gpu.id).drop();
      return json({ ok: true });
    }
    return error(404, "not found");
  }

  /** The GPU list for the settings page, with each one's live state. A PC's pairing link is shown
   * there (the page is logged in); its secret on its own never is. */
  private async gpuStates(url: URL) {
    const gpus = await this.gpus();
    return Promise.all(
      gpus.map(async (g) => {
        const st = await this.status(g);
        // Once a PC has connected, its being offline is a moment, not a pairing still to do.
        if (g.kind === "pc" && st.online && !g.seen) g = (await this.updateGpu(g.id, { seen: this.p.now() })) ?? g;
        return { ...redact(g, url), ...st };
      }),
    );
  }

  /** A Cloudflare user token that can see this Worker proves ownership. It is also the token the
   * Worker needs for builds and updates, so the latest one is kept. Once set, the password logs in
   * too; too many wrong ones in an hour stop password logins until the hour is up (the token way in
   * stays open). */
  private async login(req: Request, url: URL): Promise<Response> {
    const body = await bodyJson(req);
    if (typeof body.password === "string") return this.passwordLogin(body.password);
    const token = String(body.token ?? "").trim();
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

  private async passwordLogin(password: string): Promise<Response> {
    const s = await this.fresh.secrets();
    if (!s.password) return error(400, "No password is set yet: log in with a Cloudflare token.");
    const now = this.p.now();
    const fails: number[] = ((await this.fresh.setup()).login_fails ?? []).filter((t: number) => now - t < LOGIN_WINDOW_S);
    if (fails.length >= LOGIN_FAILS_MAX) {
      return error(429, "Too many wrong passwords: password login is paused for up to an hour. Log in with a Cloudflare token instead.");
    }
    if (!(await auth.passwordOk(password, s.password))) {
      await this.fresh.updateSetup({ login_fails: [...fails, now] });
      return error(401, "Wrong password.");
    }
    if (fails.length) await this.fresh.updateSetup({ login_fails: null });
    const session = await auth.makeSession(s.cookie_key, now);
    return json({ ok: true }, 200, { "Set-Cookie": auth.cookieHeader(session) });
  }

  /**
   * Saving the settings applies them to every GPU: Modal's downloads, each online PC's downloads,
   * and a LoRA copy. Warns about LoRAs not in storage.
   */
  private async saveConfig(req: Request, _s: Secrets): Promise<Response> {
    const cfg = await this.fresh.saveConfig((await bodyJson(req)).config);
    const gpus = await this.gpus();
    const warnings: string[] = [];
    const notes: string[] = []; // informational, not a problem (none yet: an offline PC shows on the page)
    for (const gpu of gpus) {
      const admin = this.admin(gpu);
      if (admin) warnings.push(...(await this.applyToModal(admin, cfg, null)));
    }
    // As the extension does: a newly chosen pack starts downloading now.
    for (const pc of await this.onlinePcs(gpus)) {
      for (const pack of selectedPacks(cfg)) await this.control(pc, "download", { pack: needs(pack) });
    }
    warnings.push(...(await this.spreadLoras(new URL(req.url).origin)).warnings);
    if (wantedLoras(cfg).length) warnings.push(...missingLoras(cfg, await this.loraListing()));
    return json({ config: cfg, warnings, notes });
  }

  /**
   * The LoRA files in storage and on each GPU, for the settings page: {backends: ["storage", gpu
   * ids…], gpus: [{id, name, kind}], files: {name: {backend: size}}, syncing: the agents' copies in
   * progress, errors: {backend: message}, offline: PCs not connected now}. A ComfyUI reached by URL
   * is listed with no files.
   */
  private async loraListing() {
    const gpus = await this.gpus();
    const out = {
      backends: ["storage"] as string[], // R2: where every LoRA comes in and every GPU copies from
      gpus: gpus.map((g) => ({ id: g.id, name: g.name, kind: g.kind })),
      files: {} as Record<string, Record<string, number>>,
      syncing: {} as Record<string, unknown>,
      errors: {} as Record<string, string>,
      offline: [] as string[], // not reachable now (a PC off): not an error, nothing listed
    };
    const add = (backend: string, list: Record<string, number>) => {
      for (const [name, size] of Object.entries(list ?? {})) (out.files[name] ??= {})[backend] = size;
    };
    add("storage", await loras.stored(this.p.bucket));
    for (const gpu of gpus) {
      out.backends.push(gpu.id);
      if (gpu.kind === "pc") {
        const r = (await this.status(gpu)).online ? await this.control(gpu, "loras") : null;
        if (!r || (!r.ok && r.message === offlineMessage([gpu]))) {
          out.offline.push(gpu.id);
        } else if (r.ok) {
          add(gpu.id, r.data?.files ?? {});
          for (const [name, job] of Object.entries((r.data?.syncing ?? {}) as Record<string, any>)) out.syncing[name] = { ...job, to: gpu.id };
        } else {
          out.errors[gpu.id] = r.message;
        }
      }
      const admin = this.admin(gpu);
      if (admin) {
        try {
          add(gpu.id, await admin.loras());
        } catch (e) {
          if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
          out.errors[gpu.id] = e.message;
        }
      }
    }
    return out;
  }

  /** LoRA files on every backend, uploads into R2 from the settings page, delete. */
  private async loras(req: Request, url: URL, sub: string, s: Secrets): Promise<Response> {
    if (sub === "/loras" && req.method === "GET") return json(await this.loraListing());
    if (sub === "/loras/sync" && req.method === "POST") {
      // Copy what R2 has to every GPU now, not at a PC's next connection or the next save.
      return json({ started: (await this.spreadLoras(url.origin)).pcs > 0 });
    }
    if (sub.startsWith("/loras/uploads")) return this.loraUploads(req, url, sub, s);
    if (sub.startsWith("/loras/") && req.method === "DELETE") return this.deleteLora(decodeURIComponent(sub.slice("/loras/".length)), s);
    return error(404, "not found");
  }

  /**
   * The upload protocol (web/src/lib/upload.js, and the agent's pushes): POST {filename, size} opens
   * a session; PUT <id>/<index> streams one chunk into R2 and answers its ETag (the chunk's MD5, for
   * the uploader to check); POST <id>/finish {parts} joins them; GET <id> reports. Once joined, the
   * LoRA is copied to every GPU.
   */
  private async loraUploads(req: Request, url: URL, sub: string, s: Secrets): Promise<Response> {
    const uploads = new loras.LoraUploads(this.p.bucket, this.fresh, this.p.now);
    const base = sub.startsWith("/loras/uploads") ? "/api/loras/uploads" : "/agent/loras/uploads";
    const m = /^\/loras\/uploads\/([\w-]+)(?:\/(\d+|finish))?$/.exec(sub);
    try {
      if (sub === "/loras/uploads" && req.method === "POST") {
        const body = await bodyJson(req);
        const session = await uploads.start(body.filename, body.size);
        return json({ ...session, upload_url: `${base}/${session.id}` });
      }
      if (m && m[2] === "finish" && req.method === "POST") {
        const done = await uploads.finish(m[1], (await bodyJson(req)).parts);
        const deleted = (await this.fresh.setup()).lora_deleted ?? {};
        if (done.name in deleted) await this.fresh.updateSetup({ lora_deleted: { ...deleted, [done.name]: undefined } });
        await this.spreadLoras(url.origin);
        return json(done);
      }
      if (m && m[2] !== undefined && m[2] !== "finish" && req.method === "PUT") return json(await uploads.chunk(m[1], Number(m[2]), req));
      if (m && m[2] === undefined && req.method === "GET") return json(await uploads.status(m[1]));
    } catch (e) {
      if (e instanceof loras.LoraError) return error(e.status, e.message);
      throw e;
    }
    return error(404, "not found");
  }

  /**
   * Copy what R2 holds to every GPU (best effort): Modal fetches the LoRAs its Volume lacks from
   * storage links; each online PC is told to sync. {pcs: how many PCs were told, warnings}.
   */
  private async spreadLoras(origin: string): Promise<{ pcs: number; warnings: string[] }> {
    const warnings: string[] = [];
    const gpus = await this.gpus();
    const s = await this.fresh.secrets();
    let inR2: Record<string, number> | null = null;
    for (const gpu of gpus) {
      const admin = this.admin(gpu);
      if (!admin) continue;
      try {
        inR2 ??= await loras.stored(this.p.bucket);
        const onModal = Object.keys(inR2).length ? await admin.loras() : {};
        for (const name of Object.keys(inR2).filter((n) => !(n in onModal)).slice(0, SYNC_MAX_FILES)) {
          await admin.fetchLora(name, await this.storeUrl(origin, hmacKey(s), loras.loraKey(name)), inR2[name]);
        }
      } catch (e) {
        if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
        warnings.push(`Could not copy LoRAs to ${gpu.name}: ${e.message}`);
      }
    }
    const pcs = await this.onlinePcs(gpus);
    for (const pc of pcs) await this.control(pc, "sync");
    return { pcs: pcs.length, warnings };
  }

  /** Delete a LoRA from R2 and every GPU that has it (one way in, one way out). A PC that is
   * offline drops its copy at its next sync: the name is kept as deleted until it is uploaded again. */
  private async deleteLora(name: string, _s: Secrets): Promise<Response> {
    const from: string[] = [];
    const errors: string[] = [];
    if (await this.p.bucket.head(loras.loraKey(name))) {
      await this.p.bucket.delete(loras.loraKey(name));
      from.push("storage");
    }
    const setup = await this.fresh.setup();
    await this.fresh.updateSetup({ lora_deleted: { ...(setup.lora_deleted ?? {}), [name]: this.p.now() } });
    const gpus = await this.gpus();
    for (const gpu of gpus) {
      const admin = this.admin(gpu);
      if (!admin) continue;
      try {
        await admin.deleteLora(name);
        from.push(gpu.id);
      } catch (e) {
        if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
        if (e.status !== 404) errors.push(`${gpu.name}: ${e.message}`);
      }
    }
    for (const pc of await this.onlinePcs(gpus)) {
      const r = await this.p.relays(pc.id).control("lora_delete", { name });
      if (r.status === 200) from.push(pc.id);
      else if (r.status !== 404) errors.push(`${pc.name}: ${fromUtf8(r.body)}`);
    }
    if (!from.length && !errors.length) return error(404, `no LoRA named ${name}`);
    return json({ deleted: name, from, errors });
  }

  /**
   * Download state of the selected packs on each GPU, for the pages to poll: {gpus: [{id, name,
   * kind}], packs: [{name, display_name, tool_name, size, on: {gpu id: status}}]}. ?gpu= limits it
   * to one. A PC's answer also tells routing which packs it has ready.
   */
  private async models(url: URL, _s: Secrets): Promise<Response> {
    const only = url.searchParams.get("gpu");
    const packs = selectedPacks(await this.fresh.config());
    const on: Record<string, any>[] = packs.map(() => ({}));
    const gpus = (await this.gpus()).filter((g) => g.kind !== "url" && (!only || g.id === only));
    for (const gpu of gpus) {
      if (gpu.kind === "pc") {
        const r = (await this.status(gpu)).online ? await this.control(gpu, "models", { packs: packs.map(needs) }) : null;
        const status = new Map<string, any>(r?.ok ? (r.data as any[]).map((st) => [st.name, st]) : []);
        for (const [i, p] of packs.entries()) {
          on[i][gpu.id] = !r ? { state: "offline" } : r.ok ? status.get(p.name) ?? { state: "unknown" } : { state: "unknown", error: r.message };
          if (r?.ok) await this.setReady(gpu, p.name, on[i][gpu.id].state === "done");
        }
      }
      const admin = this.admin(gpu);
      if (admin) {
        for (const [i, pack] of packs.entries()) {
          try {
            on[i][gpu.id] = await modalAdmin.packStatus(admin, this.fresh, pack);
          } catch (e) {
            if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
            on[i][gpu.id] = { state: "unknown", error: e.message };
          }
        }
      }
    }
    return json({
      gpus: gpus.map((g) => ({ id: g.id, name: g.name, kind: g.kind })),
      packs: packs.map((p, i) => ({ name: p.name, display_name: p.display_name ?? p.name, tool_name: p.tool_name, size: downloadSize(p), on: on[i] })),
    });
  }

  /** Start downloading a pack on one GPU: {pack, gpu: id}. */
  private async seedPack(req: Request, _s: Secrets): Promise<Response> {
    const body = await bodyJson(req);
    const pack = PACKS.find((p) => p.name === body.pack);
    if (!pack) return error(400, "no such pack");
    const gpu = (await this.gpus()).find((g) => g.id === body.gpu);
    if (!gpu) return error(400, "no such GPU");
    if (gpu.kind === "pc") {
      const r = await this.control(gpu, "download", { pack: needs(pack) });
      return r.ok ? json(r.data) : error(r.message === offlineMessage([gpu]) ? 503 : 502, r.message);
    }
    const admin = this.admin(gpu);
    if (!admin) return error(400, "a ComfyUI by URL downloads its own models");
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
    // One ComfyUI by URL: added at the end of the list, or replacing the one there was.
    const gpus = await this.gpus();
    const old = gpus.find((g) => g.kind === "url");
    const gpu: Gpu = { id: "url", kind: "url", name: old?.name ?? "Your ComfyUI", enabled: true, keep_warm_minutes: DEFAULT_KEEP_WARM, base_url: baseUrl, headers };
    await this.saveGpus(old ? gpus.map((g) => (g === old ? gpu : g)) : [...gpus, gpu]);
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
  listing: { backends: string[]; gpus: { id: string; name: string }[]; files: Record<string, unknown>; errors: Record<string, string>; offline: string[] },
): string[] {
  // Every LoRA comes in through R2 (storage): one a model uses that R2 lacks was deleted, or is a
  // PC's own not yet copied up. GPUs missing one get it copied; that shows on the page.
  const name = (id: string) => listing.gpus.find((g) => g.id === id)?.name ?? id;
  const out = listing.backends.filter((b) => listing.errors[b]).map((b) => `Could not check the LoRA files on ${name(b)}: ${listing.errors[b]}`);
  const files = listing.files as Record<string, Record<string, number>>;
  for (const name of wantedLoras(cfg)) {
    if (!files[name]?.storage) out.push(`The LoRA ${name} is not uploaded: generations will fail until it is. Upload it under LoRAs.`);
  }
  return out;
}

/** A GPU as the settings page sees it: no secret or headers; a PC's pairing link instead. */
function redact(g: Gpu, url: URL) {
  const { secret, headers: _headers, ...rest } = g;
  return { ...rest, ...(g.kind === "pc" && secret ? { link: pairingLink(url, secret) } : {}) };
}

/** What the agent's settings page takes: the Worker's address and the secret, in one paste. The
 * secret is in the fragment, which browsers never send, should the link be opened. */
export function pairingLink(url: URL, secret: string): string {
  return `${url.origin}/agent#${secret}`;
}
