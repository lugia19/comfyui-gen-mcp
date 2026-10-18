// The Worker's routes, over the Platform services, so every route is tested in Node; index.ts
// adapts Cloudflare's runtime to it.
//
// Keep the MCP path lean: packs load at module scope, and a warm call reads its state from the
// isolate cache. Each fetch to ComfyUI costs CPU, so the client backs off its polls.

import {
  Brain, ComfyUIClient, bodyJson, error, failResult, json, packNeeds, renderOutcome, UploadError, FetchTransport, McpHandler, UnknownTool,
  builtinPacks, cfapi, releases, isModelSet, wantedModelSets, fromHex, fromUtf8, sha256Hex, utf8, groupByTool, packLoras, packRow, refs, relay, select, settingsMetadata, tokenHex, tokenUrlsafe, safeEqual,
  withoutLora, tagLooseLoras, wantedLoras, strengthIn, packFor, redrawPack, redrawPackFor, seedKey, withFamilies, BG_MODELS, HIDDEN_TOOLS, type Config, type Content, type Pack,
} from "@comfy-gen/core";
import * as auth from "./auth.ts";
import * as cloudflare from "./cloudflare.ts";
import * as oauth from "./oauth.ts";
import { newPcId, newPcName, splitToken, DEFAULT_KEEP_WARM, PC_KEEP_WARM, type Gpu } from "./gpus.ts";
import { offlineMessage, pausedMessage, PcHooks, storedImageId, WorkerHooks } from "./hooks.ts";
import * as loras from "./loras.ts";
import { GrpcError, ModalClient, type ModalToken } from "./modal/client.ts";
import * as modalDeploy from "./modal/deploy.ts";
import * as modalAdmin from "./modal-admin.ts";
import { withUserAgent, type Bucket, type Fetch, type Job, type JobResult, type Platform } from "./platform.ts";
import { Images } from "./images.ts";
import { RelayTransport } from "./relay.ts";
import { Store, type Secrets } from "./store.ts";
import * as updates from "./updates.ts";
import * as uploads from "./uploads.ts";

type GpuStatus = { online: boolean; paused: boolean; since: number | null; info: Record<string, unknown> | null };

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
  "Images come back inline, each followed by its image_id. Pass an image_id to edit_image to edit that image, or to redraw to repaint one part of it.";

const SETTINGS_METADATA = settingsMetadata(PACKS);

export function selectedPacks(cfg: Config): Pack[] {
  return select(GROUPS, cfg.pack_selections);
}

/** The packs every GPU should have: the selected ones and the rest of their families (a call may
 * name one with the hidden `model` argument). */
export function wantedPacks(cfg: Config): Pack[] {
  const packs = withFamilies(selectedPacks(cfg), PACKS);
  return [...packs, ...wantedModelSets(cfg)];
}

// A sync plan creates one Modal session per file: keep it well inside the subrequest limit. The
// agent asks again once a round is done, for the rest.
export const SYNC_MAX_FILES = 20;

// How long a PC's "I lack that pack" holds before a call asks it again (routing, `ready`).
export const READY_RECHECK_S = 60;

const hmacKey = (s: Secrets) => fromHex(s.hmac_key);

/** The setup site (packages/setup): where Log in with Cloudflare and a move sign in. */
const SETUP_SITE = "https://comfy-setup.lugia19.com";

/** The setup record's one-use codes, and how many of each are kept at once. */
type OnceField = "login_ticket" | "reconnect";
const ONCE_KEEP: Record<OnceField, number> = { login_ticket: 1, reconnect: 5 };
type OnceCode = { hash: string; exp: number };
/** A field's codes: a list, or (before 2026-10-18) one code or none. */
const onceCodes = (v: OnceCode | OnceCode[] | null | undefined): OnceCode[] => (!v ? [] : Array.isArray(v) ? v : [v]);
/** The answers to the setup's "where should images be made?" (design §8). */
const SETUP_MODES = ["cloud", "pc", "both"] as const;
type SetupMode = (typeof SETUP_MODES)[number];

/** Storage (R2) isn't bound: R2 wasn't turned on in the account at the last build. The Setup page's
 * storage step turns it on and rebuilds. Thrown by App.bucket, answered 409 (404 for an image). */
export class NoStorage extends Error {}

const noStorageMessage = (origin: string) =>
  `storage isn't turned on yet. Finish the setup on your Worker's page (${origin}/): turn on storage.`;

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

  /** R2, or NoStorage while it isn't bound. */
  private get bucket(): Bucket {
    if (!this.p.bucket) throw new NoStorage("storage isn't turned on yet: finish the setup on this Worker's page (turn on storage).");
    return this.p.bucket;
  }

  /** The images in R2 (encrypted or not, images.ts); NoStorage while it isn't bound. */
  private get images(): Images {
    return new Images(this.bucket, this.store, this.fresh);
  }

  /** The LoRAs in R2: none while it isn't bound. */
  private storedLoras(): Promise<Record<string, number>> {
    return this.p.bucket ? loras.stored(this.p.bucket) : Promise.resolve({});
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path.startsWith("/mcp/")) return await this.mcp(req, url, path.slice(5));
      if (path.startsWith("/img/") && (req.method === "GET" || req.method === "HEAD")) return await this.images.serve(path.slice(5), req.method === "HEAD");
      if (path.startsWith("/upload/") && req.method === "POST") return await this.upload(req, path.slice(8));
      if (path === "/build-callback" && req.method === "POST") return await this.buildCallback(req);
      if (path === "/agent/sync" && req.method === "POST") return await this.agentSync(req, url);
      if (path === "/agent/whoami" && req.method === "GET") return await this.agentWhoami(req);
      if (path.startsWith("/gpu/") && (req.method === "GET" || req.method === "HEAD")) return await this.gpuPage(req, url, path.slice(5));
      if (path.startsWith("/agent/loras/uploads")) return await this.agentUpload(req, url, path.slice("/agent".length));
      if (path.startsWith("/store/") && req.method === "GET") return await this.storeLink(req, path.slice(7));
      if (path.startsWith("/api/")) return await this.api(req, url, path.slice(4));
    } catch (e) {
      if (e instanceof cfapi.CloudflareError) return error(502, e.message);
      if (e instanceof NoStorage) return error(path.startsWith("/img/") ? 404 : 409, e.message);
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

  /** The agent asks which PC it is here, for its tray to open its page (/gpu/<id>). */
  private async agentWhoami(req: Request): Promise<Response> {
    const pc = await this.agentPc(req);
    return pc instanceof Response ? pc : json({ id: pc.id, name: pc.name });
  }

  /**
   * GET /gpu/<id>: a PC's own settings page, relayed (design §9, "A page per PC"): the settings app,
   * which on this path talks to the PC through /api/gpus/<id>/machine. Logged out, the app (its
   * login) whatever the id. Logged in: Modal has no page of its own (to the GPU list); an unknown
   * id is a 404.
   */
  private async gpuPage(req: Request, url: URL, id: string): Promise<Response> {
    const s = await this.store.secrets();
    if (await auth.sessionOk(auth.readCookie(req.headers.get("cookie")), s.cookie_key, this.p.now())) {
      const gpu = (await this.gpus()).find((g) => g.id === id);
      if (!gpu) return new Response("There is no such GPU on this Worker.", { status: 404 });
      if (gpu.kind !== "pc") return Response.redirect(`${url.origin}/#settings/gpus`, 302);
    }
    if (!this.p.assets) return error(404, "not found");
    return this.p.assets(new Request(new URL("/", url), { method: req.method }));
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
    if (!this.p.bucket) return json(plan); // nothing to sync until storage is on
    const inR2 = await this.storedLoras();
    const deleted: Record<string, number> = (await this.fresh.setup()).lora_deleted ?? {};
    plan.delete = Object.keys(pcFiles).filter((name) => name in deleted && !(name in inR2));
    const uploads = new loras.LoraUploads(this.bucket, this.fresh, this.p.now);
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
        if (!(e instanceof UploadError)) throw e;
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
    return loras.serveStored(this.bucket, object, req);
  }

  /** The agent's pushes: the same upload protocol as the settings page, with its bearer secret. */
  private async agentUpload(req: Request, url: URL, sub: string): Promise<Response> {
    const pc = await this.agentPc(req);
    if (pc instanceof Response) return pc;
    return this.loraUploads(req, url, sub, await this.fresh.secrets());
  }

  async scheduled(): Promise<string> {
    const result = String((await this.job({ kind: "cron" })).body);
    console.log(`update check: ${result}`);
    return result;
  }

  /** *job* in the State object when the platform has it (its CPU budget), else here. */
  private job(job: Job): Promise<JobResult> {
    return this.p.inState ? this.p.inState(job) : this.runJob(job);
  }

  /** A Job's work (Platform.Job): run by the State object. */
  async runJob(job: Job): Promise<JobResult> {
    const s = await this.fresh.secrets();
    if (job.kind === "cron") {
      // Refreshed daily even with nothing to update: the grant never sits idle long enough to
      // expire, whatever Cloudflare's refresh-token lifetime is.
      if (this.oauthPath(s)) await this.cfToken();
      return { status: 200, body: await updates.check(this.fresh, this.version, this.updater(s)) };
    }
    try {
      if (job.kind === "modal") {
        if (!s.modal_token) return { status: 409, body: { error: "Connect Modal first." } };
        // Its own address, for the deploy's report when no request names it (the daily update).
        if (s.worker_url !== job.origin) await this.fresh.updateSecrets({ worker_url: job.origin });
        await this.startModalDeploy(s.modal_token, this.version, job.origin);
        return { status: 200, body: { started: true } };
      }
      const u = this.updater(s);
      const blocked = await u.blocked();
      if (blocked) return { status: 409, body: { error: blocked } };
      const r = await u.install(job.tag, { modal: job.modal });
      if (job.modal) await this.fresh.updateSetup({ update_tried: job.tag, update_error: null });
      return { status: 200, body: { storage: r.storage ?? null, build: r.build ?? null } };
    } catch (e) {
      const status = upstream(e);
      if (status) return status;
      throw e;
    }
  }

  // ── Updating itself through the Cloudflare API (installs made by the setup Worker, design §6) ──

  /** Created by the setup Worker and claimed: it updates itself with its OAuth token, no builds. */
  private oauthPath(s: Secrets): boolean {
    return Boolean(this.p.env.CF_OAUTH_CLIENT && s.cf_claimed);
  }

  /** How this Worker installs releases (updates.Updater): by uploading itself, or by a Workers Build. */
  private updater(s: Secrets): updates.Updater {
    if (!this.oauthPath(s)) return updates.buildUpdater(this.fetch, this.fresh);
    return {
      path: "oauth",
      latest: () => releases.latestTag(this.fetch, this.p.env.COMFY_GEN_RELEASES),
      blocked: async () => {
        const lost = await oauth.isLost(this.p.storage);
        return lost ? `Reconnect Cloudflare first (${lost}).` : null;
      },
      install: async (tag, o) => {
        const r = await this.uploadSelf(s, tag);
        if (o?.modal !== false) await this.redeployModal(s, tag); // Modal's app follows the release
        return r;
      },
    };
  }

  /** The OAuth access token, refreshed in the State object when due. */
  private cfToken(): Promise<oauth.TokenAnswer> {
    return this.p.storage.cfAccessToken(this.p.env.CF_OAUTH_CLIENT!);
  }

  /** Upload *tag* as this Worker's new version. Its bucket is made first if missing (once R2 is
   * on), so every upload binds R2 as soon as it can, as deploy.py does at each build. Throws
   * cfapi.CloudflareError, with a message for the page. */
  private async uploadSelf(s: Secrets, tag: string): Promise<{ storage: boolean }> {
    const t = await this.cfToken();
    if ("lost" in t) throw new cfapi.CloudflareError(`Reconnect Cloudflare first (${t.lost}).`);
    const [f, token, account, script] = [this.fetch, t.token, s.cf_account_id as string, s.cf_script as string];
    const bucket = cfapi.bucketName(script);
    const [made, release, fromTag] = await Promise.all([
      cfapi.createBucket(f, token, account, bucket),
      releases.loadRelease(f, this.p.env.COMFY_GEN_RELEASES, tag),
      cfapi.scriptMigrationTag(f, token, account, script),
    ]);
    if (made === "off" && tag === this.version) return { storage: false }; // nothing would change
    await Promise.all([
      made === "created" && cfapi.setLifecycle(f, token, account, bucket),
      releases.uploadRelease(f, token, account, script, release, {
        bucket: made === "off" ? null : bucket, vars: releases.workerVars(this.p.env), fromTag: fromTag ?? null,
      }),
    ]);
    return { storage: made !== "off" };
  }

  /** A one-use code kept, hashed, in the setup record's *field* for *ttl* seconds, beside the last
   * few unexpired ones (ONCE_KEEP): a sign-in code is minted without a session (Log in with
   * Cloudflare), so minting another mustn't cancel one in progress. */
  private async mintOnce(field: OnceField, ttl: number): Promise<string> {
    const code = tokenUrlsafe(24);
    const now = this.p.now();
    const live = onceCodes((await this.fresh.setup())[field]).filter((c) => c.exp >= now);
    const kept = ONCE_KEEP[field] > 1 ? live.slice(1 - ONCE_KEEP[field]) : [];
    await this.fresh.updateSetup({ [field]: [...kept, { hash: await sha256Hex(utf8(code)), exp: now + ttl }] });
    return code;
  }

  /** Whether *code* is one of *field*'s codes, unexpired; a match uses it up. */
  private async takeOnce(field: OnceField, code: unknown): Promise<boolean> {
    if (typeof code !== "string") return false;
    const hash = await sha256Hex(utf8(code));
    const codes = onceCodes((await this.fresh.setup())[field]);
    const i = codes.findIndex((c) => c.exp >= this.p.now() && safeEqual(hash, c.hash));
    if (i < 0) return false;
    codes.splice(i, 1);
    await this.fresh.updateSetup({ [field]: codes.length ? codes : null });
    return true;
  }

  /** The setup site's page that signs in to Cloudflare for this Worker and comes back logged in,
   * with a fresh one-use code: *kind* "login" (also a reconnect: the sign-in brings new tokens) or
   * "move" (design §6). */
  private async setupLink(kind: "login" | "move", origin: string): Promise<string> {
    const q = new URLSearchParams({ worker: origin, code: await this.mintOnce("reconnect", 900) });
    return `${releases.trim(this.p.env.COMFY_GEN_SETUP || SETUP_SITE)}/${kind}?${q}`;
  }

  /** A logged-in answer: the session cookie. */
  private async session(cookieKey?: string): Promise<Response> {
    const key = cookieKey ?? (await this.fresh.secrets()).cookie_key;
    return json({ ok: true }, 200, { "Set-Cookie": auth.cookieHeader(await auth.makeSession(key, this.p.now())) });
  }

  /**
   * The setup Worker hands a Worker it created over (design §6): {claim, tokens, account_id, script},
   * checked against the CLAIM secret it set at upload, once. Or a sign-in from this page (Log in
   * with Cloudflare, which also reconnects, or a move): {reconnect, tokens, account_id}, with a
   * one-time code this page made, from the same account. Its tokens replace the stored ones, and on
   * the new setup a password is no longer used. Answers a login ticket for the browser it sends
   * here (#ticket=…).
   */
  private async claim(req: Request): Promise<Response> {
    const b = await bodyJson(req);
    const t = b.tokens ?? {};
    if (typeof t.access_token !== "string" || typeof t.refresh_token !== "string" || typeof t.expires_in !== "number") return error(400, "tokens missing");
    const s = await this.fresh.secrets();
    if (b.reconnect !== undefined) {
      if (b.account_id !== s.cf_account_id) return error(403, "Sign in to the Cloudflare account this Worker is in.");
      if (!(await this.takeOnce("reconnect", b.reconnect))) return error(403, "That sign-in link has expired: start again from the Worker's page.");
      if (!s.cf_claimed) await this.finishMove(s);
      if (s.password) await this.fresh.updateSecrets({ password: null });
    } else {
      const claim = this.p.env.CLAIM;
      if (!claim || s.cf_claimed || !safeEqual(String(b.claim ?? ""), claim)) return error(403, "This Worker is already set up, or the claim is wrong.");
      if (typeof b.account_id !== "string" || typeof b.script !== "string") return error(400, "account_id and script missing");
      await this.fresh.updateSecrets({ cf_claimed: this.p.now(), cf_account_id: b.account_id, cf_script: b.script });
    }
    await this.p.storage.cfSetTokens(t);
    // Half an hour: a brand-new workers.dev address can take minutes to answer (its certificate), and
    // the setup page holds the link until it does.
    return json({ ticket: await this.mintOnce("login_ticket", 1800) });
  }

  /**
   * The end of a move to the new setup (design §6): the setup Worker has uploaded this version over
   * the one the Workers Build deployed and hands over its tokens. The build trigger goes, with the
   * Cloudflare token the build path kept (its template includes Workers Builds edit), and so does
   * that token. The page's note says what's left in GitHub; a trigger that won't go is in it too,
   * as the repository could still deploy.
   */
  private async finishMove(s: Secrets): Promise<void> {
    let note = "This Worker now updates itself. Its GitHub copy is no longer used: you can delete that repository.";
    if (s.cf_token && s.cf_trigger) {
      try {
        await cloudflare.deleteTrigger(this.fetch, s.cf_token, s.cf_account_id, s.cf_trigger);
      } catch (e) {
        if (!(e instanceof cfapi.CloudflareError)) throw e;
        note = `Cloudflare didn't let this Worker disconnect its GitHub repository (${e.message}). Disconnect it yourself: in Cloudflare, open this Worker's Settings, then Build, and click Disconnect. Then you can delete the repository.`;
      }
    }
    await this.fresh.updateSecrets({ cf_claimed: this.p.now(), cf_token: null, cf_trigger: null, cf_branch: null });
    await this.fresh.updateSetup({ move_note: note });
  }

  // ── GPUs ──────────────────────────────────────────────────────────

  /** The GPU list, in priority order. A ComfyUI by URL (removed 2026-10-15) is left out, and so
   * dropped from storage by the next write. */
  async gpus(store: Store = this.fresh): Promise<Gpu[]> {
    return ((await store.secrets()).gpus ?? []).filter((g: Gpu) => g.kind === "pc" || g.kind === "modal");
  }

  private async saveGpus(gpus: Gpu[]): Promise<void> {
    await this.fresh.updateSecrets({ gpus });
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
   * call, no waiting). Modal: always (it starts on the call). */
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

  /** Whether a GPU has a pack's models: true, false (downloading, or missing, when last asked), or
   * null when not known (a PC not asked yet, or not for READY_RECHECK_S). Modal's from its seed cache
   * (downloads it finished), a PC's from its last ensure or models check: true, or the time it last
   * said it lacked the pack. A not-ready PC is asked again after a while, else it would stay skipped
   * for good: its finished download never noticed, a lost one (the agent restarted) never restarted. */
  private ready(gpu: Gpu, setup: Record<string, any>, pack: Pack): boolean | null {
    if (!pack.models?.length) return true;
    if (gpu.kind === "modal" && (setup.seeded ?? []).includes(seedKey(pack))) return true;
    const known = setup.ready?.[gpu.id]?.[pack.name];
    if (known === true) return true;
    return typeof known === "number" && this.p.now() - known < READY_RECHECK_S ? false : null; // false: from before v1.21.1
  }

  private async setReady(gpu: Gpu, pack: string, ready: boolean): Promise<void> {
    // Most calls change nothing: compare with the copy this call already read (routing did), and
    // read fresh only to write. Saves a State read per generation (a 2026-10-01 CPU probe). A stale
    // copy at worst skips one update of an advisory flag; the next call corrects it.
    const same = (v: unknown) => (ready ? v === true : typeof v === "number" && this.p.now() - v < READY_RECHECK_S);
    if (same((await this.store.setup()).ready?.[gpu.id]?.[pack])) return;
    const setup = await this.fresh.setup();
    const known: Record<string, boolean | number> = setup.ready?.[gpu.id] ?? {};
    if (same(known[pack])) return;
    await this.fresh.updateSetup({ ready: { ...(setup.ready ?? {}), [gpu.id]: { ...known, [pack]: ready || this.p.now() } } });
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

  /** The switched-on LoRAs of the illustrated tool's pack, for a scripted caller to suggest their
   * triggers (design §3, Scripted callers). Claude reads the visible ones in the tool description. */
  private async mcpLoras(req: Request): Promise<Response> {
    if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const cfg = await this.store.config();
    const pack = selectedPacks(cfg).find((p) => p.tool_name === "generate_illustrated_image");
    const list = pack ? packLoras(pack, cfg) : [];
    // strength is the selected pack's; strengths has every pack of its group (a caller's `model`
    // picks another, and Anima and Anima Turbo take LoRAs differently).
    const group = PACKS.filter((p) => pack && p.lora_group === pack.lora_group);
    const raw = new Map(((pack && cfg.pack_loras[pack.lora_group!]) || []).map((e: any) => [e.name, e]));
    return json({
      loras: list.map((e) => ({
        name: e.name, trigger: e.trigger, strength: e.strength, hidden: e.hidden,
        strengths: Object.fromEntries(group.map((p) => [p.name, strengthIn(raw.get(e.name) ?? e, p.name)])),
      })),
    });
  }

  /** The packs a scripted caller may name in the illustrated tool's hidden `model` argument, and
   * which one the settings page picked (design §3, Scripted callers). */
  private async mcpModels(req: Request): Promise<Response> {
    if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const picked = selectedPacks(await this.store.config()).map((p) => p.name);
    const packs = PACKS.filter((p) => p.tool_name === "generate_illustrated_image");
    return json({ models: packs.map((p) => ({ name: p.name, display_name: p.display_name, selected: picked.includes(p.name) })) });
  }

  /** /mcp/<secret>: the MCP endpoint; /mcp/<secret>/loras and /models: its lists. */
  private async mcp(req: Request, url: URL, rest: string): Promise<Response> {
    const s = await this.store.secrets();
    const [secret, sub] = rest.replace(/^\/+|\/+$/g, "").split(/\/(.*)/s);
    if (!safeEqual(secret, s.mcp_secret)) return error(404, "not found");
    if (sub === "loras") return this.mcpLoras(req);
    if (sub === "models") return this.mcpModels(req);
    if (sub !== undefined) return error(404, "not found");
    const cfg = await this.store.config(); // one config for every GPU: Claude sees one tool list
    const specs = new Brain(PACKS, cfg, null as unknown as ComfyUIClient, "refs").specs;
    const served = new Set([...specs.map((spec) => spec.name), ...HIDDEN_TOOLS]);
    const key = hmacKey(s);

    const call = async (name: string, args: Record<string, any>): Promise<[Content[], boolean, Record<string, any>?]> => {
      if (!served.has(name)) throw new UnknownTool(name);
      // Images and uploads live in R2: without it, nothing to do (and no GPU time spent).
      if (!this.p.bucket) return failResult(noStorageMessage(url.origin));
      // Uploads go to R2: no GPU needed.
      if (name === "request_upload") return uploads.requestUpload(args, url.origin, key, this.p.now());
      const gpus = await this.gpus(this.store);
      if (!gpus.length) return failResult(`no GPU is set up yet. Finish setup at ${url.origin}/`);
      let pack = selectedPacks(cfg).find((p) => p.tool_name === name) ?? null;
      // A scripted caller's hidden `model` (Brain resolves it the same way): routed by, and an
      // unknown one answered before any GPU time.
      if (pack && name !== "edit_image") {
        const chosen = packFor(PACKS, pack, args.model);
        if (typeof chosen === "string") return failResult(chosen);
        pack = chosen;
      }
      if (name === "remove_background") pack = BG_MODELS; // routed to a GPU that has the model
      if (name === "redraw") {
        // Unnamed, the model that drew a stored image (its embedded prompt), as Brain decides it:
        // passed on as `model`, so the call is routed to a GPU with that pack.
        if (!args.model) {
          const id = storedImageId(String(args.image ?? ""), url.origin);
          const model = id ? redrawPackFor(await this.images.get(id).catch(() => null), PACKS) : null;
          if (model) args = { ...args, model };
        }
        const chosen = redrawPack(PACKS, args.model);
        if (typeof chosen === "string") return failResult(chosen);
        pack = chosen;
      }
      let gpu: Gpu | string;
      if (name === "fetch_result") {
        // The token names the GPU the job is on: only that one has it.
        const [on, promptId] = splitToken(String(args.request_token ?? ""), gpus);
        args = { ...args, request_token: promptId };
        if (on) {
          const st = await this.status(on);
          gpu = st.online ? on : offlineMessage([on]);
        } else {
          gpu = `there is no request ${args.request_token}: its GPU was removed, or the token is mistyped.`;
        }
      } else {
        gpu = await this.pick(gpus, pack);
      }
      if (typeof gpu === "string") return failResult(gpu);
      const tried: Gpu[] = [];
      for (;;) {
        const target: Gpu = gpu;
        let downloading = false; // this GPU lacks the pack: it starts the download, the next may answer
        const onReady = async (packName: string, ready: boolean) => {
          downloading = !ready;
          if (target.kind === "pc") await this.setReady(target, packName, ready);
        };
        const client = this.client(target);
        const images = this.images;
        const hooks =
          target.kind === "pc"
            ? new PcHooks(client, key, this.fetch, this.store, `${url.origin}/`, this.p.relays(target.id), target, images, onReady)
            : new WorkerHooks(client, key, this.fetch, this.admin(target), this.store, `${url.origin}/`, images, onReady);
        // What this GPU's ComfyUI can do: all of it on Modal; on a PC what its agent says (one from
        // before a feature doesn't say it).
        const info = target.kind === "pc" ? (await this.status(target)).info : null;
        const can = (feature: string) => target.kind === "modal" || info?.[feature] === true;
        const outcome = await new Brain(PACKS, cfg, client, "refs", {
          hooks, canRemoveMarks: can("remove_marks"), canRemoveBackground: can("remove_background"), canRedraw: can("redraw"), canCutout: can("cutout"), canRedrawArea: can("redraw_area"),
          canInpaintControl: can("inpaint_control"), canRedrawExtend: can("redraw_extend"),
        }).call(name, args);
        tried.push(target);
        if (outcome.kind === "failed" && downloading && name !== "fetch_result") {
          const next = await this.pick(gpus, pack, tried);
          if (typeof next !== "string" && !tried.includes(next)) {
            gpu = next;
            continue;
          }
        }
        if (outcome.kind === "pending") outcome.token = `${target.id}:${outcome.token}`;
        // Each image is stored in R2 under its id; Claude gets the id and its link.
        return renderOutcome(outcome, client, async (bytes) => {
          const id = await images.put(bytes);
          const link = `${url.origin}/img/${id}`;
          return { text: `image_id: ${id}\nFull resolution: ${link}`, meta: { image_id: id, url: link } };
        });
      }
    };

    const handler = new McpHandler("Comfy-Gen-MCP", this.version, specs, call, INSTRUCTIONS);
    // Setup's last step: claude.ai lists the tools once the connector is added (claude_seen), and
    // the first tool call is the first image asked for in a chat (claude_used), which ends it.
    const seen = new Set<string>();
    const resp = await handler.respond(req, (m) => seen.add(m));
    const marks = { claude_seen: seen.has("tools/list") || seen.has("tools/call"), claude_used: seen.has("tools/call") };
    if (marks.claude_seen) {
      const setup = await this.store.setup();
      const now = Object.fromEntries(Object.entries(marks).filter(([k, v]) => v && !setup[k]).map(([k]) => [k, this.p.now()]));
      if (Object.keys(now).length) await this.store.updateSetup(now);
    }
    return resp;
  }

  private async upload(req: Request, token: string): Promise<Response> {
    const s = await this.store.secrets();
    return uploads.receive(token, new Uint8Array(await req.arrayBuffer()), this.images, hmacKey(s), this.p.now());
  }

  // ── Modal without a build (Workers made by the setup site, design §6) ──

  private modal(token: ModalToken | null = null): ModalClient {
    return new ModalClient({ fetch: this.fetch, now: this.p.now, token, base: this.p.env.MODAL_GRPC || undefined });
  }

  /** A Modal token that works (it writes the workspace Secret the deploy reads), kept here too. */
  private async setModalToken(token: ModalToken): Promise<void> {
    await modalDeploy.putTokenSecret(this.modal(token), token);
    await this.fresh.updateSecrets({ modal_token: token });
  }

  /** Deploy *tag*'s Modal app from a Sandbox; the result comes back to /build-callback. */
  private async startModalDeploy(token: ModalToken, tag: string, origin: string): Promise<void> {
    const nonce = tokenUrlsafe(24);
    const source = modalDeploy.sourceUrl(this.p.env.COMFY_GEN_RELEASES, tag);
    const script = modalDeploy.deployScript(source, `${origin}/build-callback`, nonce, tag);
    const sandbox = await modalDeploy.startDeploy(this.modal(token), token, script);
    await this.fresh.updateSetup({ build_nonce: nonce, modal_deploy: { sandbox, tag, started: this.p.now() }, modal_error: null });
  }

  /** After an update: the same release on Modal, when Modal is set up (its deploy recorded the
   * Worker's address). A failure shows as Modal's (the page's Try again), not as a failed update. */
  private async redeployModal(s: Secrets, tag: string): Promise<void> {
    if (!s.modal_token || !s.worker_url || !(s.gpus ?? []).some((g: Gpu) => g.kind === "modal")) return;
    try {
      await this.startModalDeploy(s.modal_token, tag, s.worker_url);
    } catch (e) {
      if (!(e instanceof GrpcError)) throw e;
      await this.fresh.updateSetup({ modal_error: `Updating Modal to ${tag} didn't start: ${e.message}` });
    }
  }

  /**
   * Modal: its deploy, either way a Worker deploys it, and connecting it on the OAuth path.
   *   POST /setup/modal          deploy this version's app, with {token_id, token_secret} if given
   *                              (else the token stored): a Workers Build, or a Modal Sandbox
   *   GET  /setup/modal/log      ?cursor=: the deploy's output since *cursor*: {lines, cursor, done}
   *   POST /modal/connect        Modal's sign-in (the OAuth path): {url} to approve it at
   *   POST /modal/connect/wait   wait for the approval (about 20 s): {connected}
   */
  private async modalApi(req: Request, url: URL, sub: string, s: Secrets): Promise<Response> {
    const oauthPath = this.oauthPath(s);
    try {
      if (sub === "/setup/modal" && req.method === "POST") {
        const b = await bodyJson(req);
        const id = String(b.token_id ?? "").trim();
        const secret = String(b.token_secret ?? "").trim();
        if ((id || secret) && (!/^ak-\w+$/.test(id) || !/^as-\w+$/.test(secret))) return error(400, "Paste the token id (ak-…) and secret (as-…).");
        if (!oauthPath) return this.startBuild(url, s, id ? { id, secret } : null);
        if (id) await this.setModalToken({ id, secret });
        const r = await this.job({ kind: "modal", origin: url.origin });
        return json(r.body, r.status);
      }
      if (sub === "/setup/modal/log" && req.method === "GET") {
        const cursor = url.searchParams.get("cursor") ?? "";
        return oauthPath ? this.modalLog(s, cursor) : this.buildState(cursor, s);
      }
      if (!oauthPath) return error(409, "This Worker deploys Modal with its Workers Build.");
      if (sub === "/modal/connect" && req.method === "POST") {
        const f = await this.modal().tokenFlowCreate();
        await this.fresh.updateSetup({ modal_flow: { id: f.token_flow_id, wait_secret: f.wait_secret, exp: this.p.now() + 900 } });
        return json({ url: f.web_url });
      }
      if (sub === "/modal/connect/wait" && req.method === "POST") {
        const flow = (await this.fresh.setup()).modal_flow;
        if (!flow || flow.exp < this.p.now()) return error(409, "That Modal sign-in expired: click Connect Modal again.");
        const r = await this.modal().tokenFlowWait(flow.id, flow.wait_secret, 20);
        if (r.timeout || !r.token_id || !r.token_secret) return json({ connected: false });
        await this.setModalToken({ id: r.token_id, secret: r.token_secret });
        await this.fresh.updateSetup({ modal_flow: null });
        return json({ connected: true });
      }
    } catch (e) {
      const r = upstream(e);
      if (r) return json(r.body, r.status);
      throw e;
    }
    return error(404, "not found");
  }

  /** The deploy's output since *cursor*. Its script reports before it exits, so a Sandbox that
   * ended while the deploy is still recorded ended without its report: shown as Modal's error. */
  private async modalLog(s: Secrets, cursor: string): Promise<Response> {
    const d = (await this.fresh.setup()).modal_deploy;
    if (!d) return json({ lines: [], cursor, done: true });
    const c = this.modal(s.modal_token);
    const r = await c.sandboxLogs(d.sandbox, cursor, 5);
    if (r.eof) {
      const result = await c.sandboxResult(d.sandbox, 1);
      if (result && (await this.fresh.setup()).modal_deploy?.sandbox === d.sandbox) {
        const why = result.exception || `the deploy stopped (exit ${result.exitcode}) before it finished; its log says why`;
        await this.fresh.updateSetup({ modal_deploy: null, modal_error: why });
      }
    }
    return json({ lines: r.lines, cursor: r.entry, done: r.eof });
  }

  // ── builds ────────────────────────────────────────────────────────

  private async buildCallback(req: Request): Promise<Response> {
    const data = await bodyJson(req);
    const expected = (await this.fresh.setup()).build_nonce;
    if (!expected || !safeEqual(String(data.nonce ?? ""), expected)) return error(403, "bad nonce");
    const modal = data.modal;
    let warnings: string[] = [];
    if (modal && typeof modal === "object" && modal.server_url) {
      const gpu = await this.putGpu("modal", (old) => ({
        id: "modal", kind: "modal", name: old?.name ?? "Modal", enabled: old?.enabled ?? true,
        keep_warm_minutes: old?.keep_warm_minutes ?? DEFAULT_KEEP_WARM,
        base_url: modal.server_url,
        admin_url: modal.admin_url ?? null,
        headers: { "Modal-Key": modal.proxy_token_id ?? "", "Modal-Secret": modal.proxy_token_secret ?? "" },
        cold_start_s: MODAL_COLD_START_S,
      }));
      // A deploy resets keep-warm to the app's default, and a fresh install has no models yet.
      warnings = await this.applyToModal(this.admin(gpu)!, await this.fresh.config(), gpu.keep_warm_minutes);
      warnings.push(...(await this.spreadLoras(new URL(req.url).origin)));
      await this.fresh.updateSetup({ modal_error: null, modal_deploy: null });
    } else if (typeof data.modal_error === "string" || String(data.modal_result ?? "").startsWith("failed")) {
      // The setup page shows Modal's reason (no card on file, a bad token) and offers Try again.
      await this.fresh.updateSetup({ modal_error: String(data.modal_error || data.modal_result).slice(0, 500), modal_deploy: null });
    }
    return json({ ok: true, warnings });
  }

  /** Best effort: apply keep-warm (when given), start downloads for the wanted packs. Returns warnings.
   * LoRAs are spreadLoras' (the callers call it after). */
  private async applyToModal(admin: modalAdmin.ModalAdmin, cfg: Config, keepWarmMinutes: number | null): Promise<string[]> {
    const warnings = keepWarmMinutes === null ? [] : await this.applyKeepWarm(admin, keepWarmMinutes);
    return warnings.concat(await modalAdmin.seedMissing(admin, this.fresh, wantedPacks(cfg)));
  }

  /** Set how long Modal stays warm after a call. Returns warnings (best effort). */
  private async applyKeepWarm(admin: modalAdmin.ModalAdmin, minutes: number): Promise<string[]> {
    try {
      await admin.idle(minutes);
      return [];
    } catch (e) {
      if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
      return [`Could not apply keep-warm: ${e.message}`];
    }
  }

  /** A PC control op's answer for the page: its data, or 503 offline / 502 its error. */
  private controlResponse(gpu: Gpu, r: { ok: true; data: unknown } | { ok: false; message: string }): Response {
    return r.ok ? json(r.data) : error(r.message === offlineMessage([gpu]) ? 503 : 502, r.message);
  }

  /** The one GPU of *kind* (Modal) set to *make*'s: replaced where it is in the list, else added at
   * the end (a fallback behind the PCs). */
  private async putGpu(kind: Gpu["kind"], make: (old: Gpu | undefined) => Gpu): Promise<Gpu> {
    const gpus = await this.gpus();
    const old = gpus.find((g) => g.kind === kind);
    const gpu = make(old);
    await this.saveGpus(old ? gpus.map((g) => (g === old ? gpu : g)) : [...gpus, gpu]);
    return gpu;
  }

  // ── settings API ──────────────────────────────────────────────────

  private async api(req: Request, url: URL, sub: string): Promise<Response> {
    if (sub === "/login" && req.method === "POST") return this.login(req, url);
    if (sub === "/claim" && req.method === "POST") return this.claim(req);
    const s = await this.fresh.secrets();
    // The login screen asks which way in to offer: on the new setup Cloudflare (and a token), else
    // a password once one is set (and a token).
    if (sub === "/login" && req.method === "GET") return json({ cloudflare: this.oauthPath(s), password: !this.oauthPath(s) && Boolean(s.password) });
    if (sub === "/login/cloudflare" && req.method === "POST") {
      // No session needed: only a Cloudflare sign-in to this Worker's account finishes it.
      if (!this.oauthPath(s)) return error(409, "This Worker wasn't made by the setup site: log in with a Cloudflare token instead.");
      return json({ url: await this.setupLink("login", url.origin) });
    }
    if (sub === "/logout" && req.method === "POST") return json({ ok: true }, 200, { "Set-Cookie": auth.cookieHeader("", 0) });
    if (!(await auth.sessionOk(auth.readCookie(req.headers.get("cookie")), s.cookie_key, this.p.now()))) {
      return error(401, "log in first");
    }

    if (sub === "/state" && req.method === "GET") return json(await this.state(url, s));
    if (sub === "/password" && req.method === "PUT") {
      if (this.oauthPath(s)) return error(409, "This Worker logs in with Cloudflare: it has no password.");
      const password = String((await bodyJson(req)).password ?? "");
      if (password.length < auth.PASSWORD_MIN) return error(400, `Use at least ${auth.PASSWORD_MIN} characters.`);
      await this.fresh.updateSecrets({ password: await auth.makePassword(password) });
      return json({ ok: true });
    }
    if (sub === "/config" && req.method === "PUT") return this.saveConfig(req);
    if (sub === "/loras" || sub.startsWith("/loras/")) return this.loras(req, url, sub, s);
    if (sub === "/models" && req.method === "GET") return this.models(url);
    if (sub === "/models/seed" && req.method === "POST") return this.seedPack(req);
    if (sub === "/setup/mode" && req.method === "POST") {
      const mode = (await bodyJson(req)).mode;
      if (!SETUP_MODES.includes(mode)) return error(400, `mode: one of ${SETUP_MODES.join(", ")}`);
      await this.fresh.updateSetup({ mode });
      return json({ mode });
    }
    // Storage, Check now: install this same version again, which binds the bucket once R2 is on. A
    // build answers {build} (its log tells when it's done); an upload is live at once ({storage}),
    // and GET says when this Worker's version has it.
    if (sub === "/setup/storage" && req.method === "GET") return json({ storage: Boolean(this.p.bucket) });
    if (sub === "/setup/storage" && req.method === "POST") {
      const r = await this.job({ kind: "install", tag: this.version, modal: false });
      return json(r.body, r.status);
    }
    if (sub === "/setup/build" && req.method === "GET") return this.buildState(url.searchParams.get("cursor"), s);
    if (sub === "/gpus" || sub.startsWith("/gpus/")) return this.gpuApi(req, url, sub);
    if (sub === "/images/encryption" && req.method === "POST") {
      // New images stored encrypted (images.ts). The key is made the first time and never changes:
      // images already encrypted stay readable after the setting is turned off.
      if (!this.p.bucket) return error(409, noStorageMessage(url.origin));
      const on = (await bodyJson(req)).on === true;
      await this.fresh.updateSecrets(on && !s.image_key ? { encrypt_images: true, image_key: tokenHex(32) } : { encrypt_images: on });
      return json({ encrypt_images: on });
    }
    if (sub === "/update") return this.update(req, s);
    if (sub.startsWith("/modal/") || sub.startsWith("/setup/modal")) return this.modalApi(req, url, sub, s);
    if (sub === "/cloudflare/move" && req.method === "POST") {
      // An install made from a repository goes over to the new setup: the setup Worker uploads the
      // latest release over it, then hands over the tokens through claim() with this one-time code.
      if (this.oauthPath(s)) return error(409, "This Worker is on the new setup already.");
      if (!s.cf_account_id) return error(400, "Log in with a Cloudflare token first.");
      // The answer to "where?" came from the template's vars, which the new version won't have.
      const setup = await this.fresh.setup();
      if (!setup.mode && this.mode(setup)) await this.fresh.updateSetup({ mode: this.mode(setup) });
      return json({ url: await this.setupLink("move", url.origin) });
    }
    if (sub === "/setup/rotate-connector" && req.method === "POST") {
      await this.fresh.updateSecrets({ mcp_secret: tokenUrlsafe(24) });
      await this.fresh.updateSetup({ claude_seen: null, claude_used: null }); // the new URL has to be added again
      return json({ ok: true });
    }
    return error(404, "not found");
  }

  /**
   * The setup's answer to "where should images be made?": the one chosen on this page, else the
   * setup site's (SETUP_MODE, from the template the Deploy button copied), else none yet.
   */
  private mode(setup: Record<string, any>): SetupMode | null {
    if ((SETUP_MODES as readonly string[]).includes(setup.mode)) return setup.mode;
    const site = this.p.env.SETUP_MODE ?? "";
    if ((SETUP_MODES as readonly string[]).includes(site)) return site as SetupMode;
    return null;
  }

  private async state(url: URL, s: Secrets) {
    const [setup, cfLost, gpus, config] = await Promise.all([
      this.fresh.setup(),
      this.oauthPath(s) ? oauth.isLost(this.p.storage) : null,
      this.gpuStates(url),
      this.fresh.config(),
    ]);
    return {
      version: this.version,
      cloudflare: s.cf_token || s.cf_claimed ? { account_id: s.cf_account_id ?? null, script: s.cf_script ?? null } : null,
      cf_lost: cfLost, // a Worker made by the setup Worker lost its Cloudflare connection: why
      // How it updates and deploys Modal: "oauth" (itself, and Modal from a Sandbox) or "build".
      update_path: this.updater(s).path,
      modal_deploy: setup.modal_deploy ? { started: setup.modal_deploy.started } : null,
      // Moved from the build path, whose Modal token stays in the build: Connect Modal to update it.
      modal_connected: Boolean(s.modal_token),
      move_note: setup.move_note ?? null,
      gpus,
      storage: Boolean(this.p.bucket),
      encrypt_images: Boolean(s.encrypt_images),
      setup_mode: this.mode(setup), // not "mode": the page tells the agent and the extension apart by that
      mode_from_site: !setup.mode && ["cloud", "pc", "both"].includes(this.p.env.SETUP_MODE ?? ""),
      build: setup.build ?? null,
      update_build: setup.update_build ?? null,
      modal_error: setup.modal_error ?? null,
      connector_url: `${url.origin}/mcp/${s.mcp_secret}`,
      claude_seen: setup.claude_seen ?? null,
      claude_used: setup.claude_used ?? null,
      // The first login on a Worker made from a repository sets a password; the new setup has none.
      needs_password: !this.oauthPath(s) && !s.password,
      config,
      ...SETTINGS_METADATA,
    };
  }

  /**
   * The settings page's update: GET says which release this Worker runs, the latest, and whether
   * and how it can update; POST installs the latest now, as the daily check would. A build answers
   * {build} at its start (GET follows it); an upload answers once it's live ({build: null}).
   */
  private async update(req: Request, s: Secrets): Promise<Response> {
    const u = this.updater(s);
    const [setup, fetched] = await Promise.all([this.fresh.setup(), u.latest()]);
    const [latest, seen] = updates.steadyLatest(fetched, setup.latest_seen ?? null, this.p.now());
    if (seen) await this.fresh.updateSetup({ latest_seen: seen });
    const blocked = await u.blocked();
    if (req.method === "GET") {
      const dev = !updates.parseVersion(this.version); // a development build: no updates from here
      const b = u.path === "build" && !blocked ? await this.updateBuild(setup, s) : { build: null, building: false, outcome: null };
      const failed = u.path === "build" ? (b.outcome && b.outcome !== "success" ? `Cloudflare says: ${b.outcome}` : null) : (setup.update_error ?? null);
      return json({ current: this.version, latest, dev, newer: !dev && updates.isNewer(latest, this.version), path: u.path, blocked, failed, ...b });
    }
    if (req.method !== "POST") return error(405, "GET or POST");
    if (blocked) return error(409, blocked);
    if (!latest) return error(502, "Could not find the latest release. Try again in a minute.");
    const r = await this.job({ kind: "install", tag: latest, modal: true });
    return json(r.status === 200 ? { latest, build: (r.body as { build: string | null }).build } : r.body, r.status);
  }

  /** The last update build: in progress only while Cloudflare says so (a finished update build
   * must not hide the button for the next release, seen in v1.3.7). Once seen stopped it is
   * recorded with its outcome ("success", "failure", …; null if Cloudflare couldn't say), and not
   * asked again. */
  private async updateBuild(setup: Record<string, any>, s: Secrets) {
    const build: string | null = setup.update_build ?? null;
    let building = false;
    let outcome: string | null = setup.update_finished === build ? (setup.update_outcome ?? null) : null;
    if (build && setup.update_finished !== build) {
      try {
        const st = await cloudflare.buildStatus(this.fetch, s.cf_token, s.cf_account_id, build);
        building = st.status !== "stopped";
        outcome = building ? null : (st.outcome ?? null);
      } catch (e) {
        if (!(e instanceof cfapi.CloudflareError)) throw e; // unknown: show the button
      }
      if (!building) await this.fresh.updateSetup({ update_finished: build, update_outcome: outcome });
    }
    return { build, building, outcome };
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
    const managed = /^\/gpus\/([\w-]+)\/machine(\/.*)$/.exec(sub);
    if (managed) return this.managePc(req, gpus, managed[1], managed[2] + url.search);
    if (sub === "/gpus/pc" && req.method === "POST") {
      const gpu: Gpu = { id: newPcId(gpus), kind: "pc", name: newPcName(gpus), enabled: true, keep_warm_minutes: PC_KEEP_WARM, secret: tokenUrlsafe(32), seen: null };
      // A new PC goes after the other PCs and before Modal: a GPU of one's own is free, Modal is the
      // fallback, and a PC added later (a laptop, say) shouldn't take over from the first.
      const at = gpus.reduce((last, g, i) => (g.kind === "pc" ? i + 1 : last), 0);
      await this.saveGpus([...gpus.slice(0, at), gpu, ...gpus.slice(at)]);
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
      return this.controlResponse(gpu, await this.control(gpu, "pause", { paused: (await bodyJson(req)).paused === true }));
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
      const admin = this.admin(updated);
      const warnings = admin && changes.keep_warm_minutes !== undefined ? await this.applyKeepWarm(admin, updated.keep_warm_minutes) : [];
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
    if (body.ticket !== undefined) {
      // A login ticket from claim(): one use, half an hour.
      return (await this.takeOnce("login_ticket", body.ticket)) ? this.session() : error(401, "That link has expired: log in again.");
    }
    if (typeof body.password === "string") return this.passwordLogin(body.password);
    const token = String(body.token ?? "").trim();
    if (!token) return error(400, "paste a token");
    // Under wrangler dev the host is 127.0.0.1; DEV_WORKER_HOST names a deployed Worker instead.
    const host = this.p.env.DEV_WORKER_HOST || url.host;
    const s = await this.fresh.secrets();
    let found: cloudflare.Discovery;
    try {
      await cloudflare.verifyUserToken(this.fetch, token);
      if (this.oauthPath(s)) {
        // Made by the setup Worker: the token only proves the Worker is yours, and isn't kept.
        if ((await cfapi.scriptMigrationTag(this.fetch, token, s.cf_account_id, s.cf_script)) === undefined) {
          return error(401, `The token cannot see this Worker (${s.cf_script}). Make sure it was created for the account this Worker lives in.`);
        }
        return this.session(s.cookie_key);
      }
      found = await cloudflare.discover(this.fetch, token, host);
    } catch (e) {
      if (e instanceof cfapi.CloudflareError) return error(401, e.message);
      throw e;
    }
    await this.fresh.updateSecrets({
      cf_token: token, cf_account_id: found.account_id, cf_script: found.script, cf_trigger: found.trigger, cf_branch: found.branch,
    });
    return this.session(s.cookie_key);
  }

  private async passwordLogin(password: string): Promise<Response> {
    const s = await this.fresh.secrets();
    if (this.oauthPath(s)) return error(400, "This Worker logs in with Cloudflare: it has no password.");
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
    return this.session(s.cookie_key);
  }

  /**
   * Saving the settings applies them to every GPU: Modal's downloads, each online PC's downloads,
   * and a LoRA copy. Warns about LoRAs not in storage.
   */
  private async saveConfig(req: Request): Promise<Response> {
    let cfg = await this.fresh.saveConfig((await bodyJson(req)).config);
    // Every stored LoRA keeps a group, also one the page's copy of the settings didn't know yet.
    const tagged = tagLooseLoras(cfg.pack_loras, Object.keys(await this.storedLoras()));
    if (tagged) cfg = await this.fresh.saveConfig({ ...cfg, pack_loras: tagged });
    const gpus = await this.gpus();
    const warnings: string[] = [];
    for (const gpu of gpus) {
      const admin = this.admin(gpu);
      if (admin) warnings.push(...(await this.applyToModal(admin, cfg, null)));
    }
    // As the extension does: a newly chosen pack starts downloading now.
    for (const pc of await this.onlinePcs(gpus)) {
      for (const pack of wantedPacks(cfg)) await this.control(pc, "download", { pack: packNeeds(pack) });
    }
    warnings.push(...(await this.spreadLoras(new URL(req.url).origin)));
    if (wantedLoras(cfg).length) warnings.push(...missingLoras(cfg, await this.loraListing()));
    return json({ config: cfg, warnings });
  }

  /**
   * The LoRA files in storage and on each GPU, for the settings page: {backends: ["storage", gpu
   * ids…], gpus: [{id, name, kind}], files: {name: {backend: size}}, syncing: the agents' copies in
   * progress, errors: {backend: message}, offline: PCs not connected now}.
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
    add("storage", await this.storedLoras());
    for (const gpu of gpus) {
      out.backends.push(gpu.id);
      if (gpu.kind === "pc") {
        const r = (await this.status(gpu)).online ? await this.control(gpu, "loras") : null;
        if (!r || (!r.ok && r.message === offlineMessage([gpu]))) {
          out.offline.push(gpu.id);
        } else if (r.ok) {
          add(gpu.id, r.data?.files ?? {});
          for (const [name, job] of Object.entries((r.data?.syncing ?? {}) as Record<string, any>)) out.syncing[name] = { ...job, to: job.to === "storage" ? "storage" : gpu.id }; // a push goes to storage
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

  /** Give each of *names* (LoRAs in storage) a group if it has none: *group*, else the default. */
  private async tagStored(names: string[], group?: unknown): Promise<void> {
    const cfg = await this.fresh.config();
    const tagged = tagLooseLoras(cfg.pack_loras, names, group);
    if (tagged) await this.fresh.saveConfig({ ...cfg, pack_loras: tagged });
  }

  /** LoRA files on every backend, uploads into R2 from the settings page, delete. */
  private async loras(req: Request, url: URL, sub: string, s: Secrets): Promise<Response> {
    if (sub === "/loras" && req.method === "GET") {
      const listing = await this.loraListing();
      await this.tagStored(Object.keys(listing.files).filter((n) => "storage" in listing.files[n]));
      return json(listing);
    }
    if (sub.startsWith("/loras/uploads")) return this.loraUploads(req, url, sub, s);
    if (sub.startsWith("/loras/") && req.method === "DELETE") return this.deleteLora(decodeURIComponent(sub.slice("/loras/".length)));
    return error(404, "not found");
  }

  /**
   * The upload protocol (web/src/lib/upload.js, and the agent's pushes): POST {filename, size} opens
   * a session; PUT <id>/<index> streams one chunk into R2 and answers its ETag (the chunk's MD5, for
   * the uploader to check); POST <id>/finish {parts} joins them. Once joined, the
   * LoRA is copied to every GPU.
   */
  private async loraUploads(req: Request, url: URL, sub: string, s: Secrets): Promise<Response> {
    const uploads = new loras.LoraUploads(this.bucket, this.fresh, this.p.now);
    const base = sub.startsWith("/loras/uploads") ? "/api/loras/uploads" : "/agent/loras/uploads";
    const m = /^\/loras\/uploads\/([\w-]+)(?:\/(\d+|finish))?$/.exec(sub);
    try {
      if (sub === "/loras/uploads" && req.method === "POST") {
        const body = await bodyJson(req);
        const session = await uploads.start(body.filename, body.size);
        return json({ ...session, upload_url: `${base}/${session.id}` });
      }
      if (m && m[2] === "finish" && req.method === "POST") {
        const body = await bodyJson(req);
        const done = await uploads.finish(m[1], body.parts);
        // Into the LoRA group it was uploaded for (the page's open tab), switched off until the page
        // saves it on; a push from a PC names none, and lands in the default group.
        await this.tagStored([done.name], body.group);
        const deleted = (await this.fresh.setup()).lora_deleted ?? {};
        if (done.name in deleted) await this.fresh.updateSetup({ lora_deleted: { ...deleted, [done.name]: undefined } });
        await this.spreadLoras(url.origin);
        return json(done);
      }
      if (m && m[2] !== undefined && m[2] !== "finish" && req.method === "PUT") return json(await uploads.chunk(m[1], Number(m[2]), req));
    } catch (e) {
      if (e instanceof UploadError) return error(e.status, e.message);
      throw e;
    }
    return error(404, "not found");
  }

  /**
   * Copy what R2 holds to every GPU (best effort): Modal fetches the LoRAs its Volume lacks from
   * storage links; each online PC is told to sync. Returns warnings.
   */
  private async spreadLoras(origin: string): Promise<string[]> {
    const warnings: string[] = [];
    const gpus = await this.gpus();
    const s = await this.fresh.secrets();
    let inR2: Record<string, number> | null = null;
    for (const gpu of gpus) {
      const admin = this.admin(gpu);
      if (!admin) continue;
      try {
        inR2 ??= await this.storedLoras();
        const onModal = Object.keys(inR2).length ? await admin.loras() : {};
        for (const name of Object.keys(inR2).filter((n) => !(n in onModal)).slice(0, SYNC_MAX_FILES)) {
          await admin.fetchLora(name, await this.storeUrl(origin, hmacKey(s), loras.loraKey(name)), inR2[name]);
        }
      } catch (e) {
        if (!(e instanceof modalAdmin.ModalAdminError)) throw e;
        warnings.push(`Could not copy LoRAs to ${gpu.name}: ${e.message}`);
      }
    }
    for (const pc of await this.onlinePcs(gpus)) await this.control(pc, "sync");
    return warnings;
  }

  /**
   * A PC's own settings page on this Worker (design §9, "A page per PC"): one call of its API,
   * relayed as it is (path, query, a JSON body as text; no parsing here). The agent refuses only
   * pairing. Binary bodies (the page's LoRA uploads) are not relayed: LoRAs come in on this
   * Worker's page and are synced. A restart waits for ComfyUI to come up, a stop for it to go.
   */
  private async managePc(req: Request, gpus: Gpu[], id: string, path: string): Promise<Response> {
    const gpu = gpus.find((g) => g.id === id && g.kind === "pc");
    if (!gpu) return error(404, "no such PC");
    const type = req.headers.get("content-type") ?? "";
    if (req.body && type && !/^(application\/json|text\/)/.test(type)) return error(415, "Only JSON goes to the PC from here.");
    if (!(await this.status(gpu)).online) return error(503, offlineMessage([gpu]));
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
    const call = path.split("?")[0];
    const timeoutS = req.method === "POST" && call === "/comfyui/restart" ? 300 : req.method === "POST" && call === "/comfyui/stop" ? 60 : 30;
    const r = await this.p.relays(gpu.id).control("machine", { method: req.method, path, body }, timeoutS);
    if (r.offline) return error(503, offlineMessage([gpu]));
    if (r.status === 200) return new Response(r.body as unknown as BodyInit, { headers: { "Content-Type": "application/json" } });
    // Refusals come as text from the agent, its page's errors as {error}: the page reads {error}.
    const text = fromUtf8(r.body);
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      // plain text
    }
    return error(r.status, `${gpu.name}: ${message}`);
  }

  /** Delete a LoRA from R2 and every GPU that has it (one way in, one way out). A PC that is
   * offline drops its copy at its next sync: the name is kept as deleted until it is uploaded again. */
  private async deleteLora(name: string): Promise<Response> {
    const from: string[] = [];
    const errors: string[] = [];
    if (this.p.bucket && (await this.p.bucket.head(loras.loraKey(name)))) {
      await this.p.bucket.delete(loras.loraKey(name));
      from.push("storage");
    }
    const setup = await this.fresh.setup();
    await this.fresh.updateSetup({ lora_deleted: { ...(setup.lora_deleted ?? {}), [name]: this.p.now() } });
    const cfg = await this.fresh.config();
    const packLoras = withoutLora(cfg.pack_loras, name);
    if (packLoras) await this.fresh.saveConfig({ ...cfg, pack_loras: packLoras });
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
    const pending: string[] = []; // PCs whose ComfyUI still has the file open (Windows): deleted when it stops
    for (const pc of await this.onlinePcs(gpus)) {
      const r = await this.p.relays(pc.id).control("lora_delete", { name });
      if (r.status === 200) {
        from.push(pc.id);
        const done = relay.controlResult(r.status, r.body);
        if (done.ok && done.data?.pending) pending.push(pc.name);
      } else if (r.status !== 404) errors.push(`${pc.name}: ${fromUtf8(r.body)}`);
    }
    if (!from.length && !errors.length) return error(404, `no LoRA named ${name}`);
    return json({ deleted: name, from, errors, pending });
  }

  /**
   * Download state of the wanted packs (selected, and their families) on each GPU, for the pages to poll: {gpus: [{id, name,
   * kind}], packs: [{name, display_name, tool_name, size, on: {gpu id: status}}]}. ?gpu= limits it
   * to one. A PC's answer also tells routing which packs it has ready.
   */
  private async models(url: URL): Promise<Response> {
    const only = url.searchParams.get("gpu");
    // The watermark and background removal models download in the background, never listed.
    const packs = wantedPacks(await this.fresh.config()).filter((p) => !isModelSet(p));
    const on: Record<string, any>[] = packs.map(() => ({}));
    const gpus = (await this.gpus()).filter((g) => !only || g.id === only);
    for (const gpu of gpus) {
      if (gpu.kind === "pc") {
        const r = (await this.status(gpu)).online ? await this.control(gpu, "models", { packs: packs.map(packNeeds) }) : null;
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
      packs: packs.map((p, i) => ({ ...packRow(p), on: on[i] })),
    });
  }

  /** Start downloading a pack on one GPU: {pack, gpu: id}. */
  private async seedPack(req: Request): Promise<Response> {
    const body = await bodyJson(req);
    const pack = PACKS.find((p) => p.name === body.pack);
    if (!pack) return error(400, "no such pack");
    const gpu = (await this.gpus()).find((g) => g.id === body.gpu);
    if (!gpu) return error(400, "no such GPU");
    if (gpu.kind === "pc") {
      return this.controlResponse(gpu, await this.control(gpu, "download", { pack: packNeeds(pack) }));
    }
    const admin = this.admin(gpu);
    if (!admin) return error(400, "this Modal has no admin API: deploy it again from the Setup tab");
    try {
      return json(await admin.seed(pack));
    } catch (e) {
      if (e instanceof modalAdmin.ModalAdminError) return error(502, e.message);
      throw e;
    }
  }

  /** Modal's deploy on the build path: a Workers Build, with *token* stored in the build's secrets
   * (null: the one stored with the last deploy). */
  private async startBuild(url: URL, s: Secrets, token: ModalToken | null): Promise<Response> {
    if (!s.cf_token) return error(400, "set up the Cloudflare token first");
    const nonce = tokenUrlsafe(24);
    await cloudflare.setBuildVars(
      this.fetch, s.cf_token, s.cf_account_id, s.cf_trigger,
      { COMFY_GEN_NONCE: nonce, MODAL_TOKEN_ID: token?.id, MODAL_TOKEN_SECRET: token?.secret },
      { COMFY_GEN_CALLBACK: `${url.origin}/build-callback` },
    );
    const build = await cloudflare.startBuild(this.fetch, s.cf_token, s.cf_account_id, s.cf_trigger, s.cf_branch || "main");
    await this.fresh.updateSetup({ build, build_nonce: nonce, modal_error: null });
    return json({ build });
  }

  /** The last build's log since *cursor*, and whether it is done: {build, lines, cursor, done,
   * status, outcome}. */
  private async buildState(cursor: string | null, s: Secrets): Promise<Response> {
    const build = (await this.fresh.setup()).build;
    if (!build || !s.cf_token) return json({ build: null });
    const [status, logs] = await Promise.all([
      cloudflare.buildStatus(this.fetch, s.cf_token, s.cf_account_id, build),
      cloudflare.buildLogs(this.fetch, s.cf_token, s.cf_account_id, build, cursor || null),
    ]);
    return json({ build, ...status, ...logs, done: status.status === "stopped" });
  }
}

/** Warnings for configured LoRAs that no listed backend has. One on some backend but not another
 * gets none: the agent copies it. */
function missingLoras(
  cfg: Config,
  listing: { backends: string[]; gpus: { id: string; name: string }[]; files: Record<string, unknown>; errors: Record<string, string> },
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

/** A failure upstream (Cloudflare's API, a release, Modal's API) as the page's answer, else null. */
function upstream(e: unknown): JobResult | null {
  if (e instanceof GrpcError) return { status: 502, body: { error: `Modal: ${e.message}` } };
  if (e instanceof cfapi.CloudflareError) return { status: 502, body: { error: e.message } };
  return null;
}
