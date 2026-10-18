// The setup Worker (design §6), at comfy-setup.lugia19.com: serves the setup site (site/), signs the
// user in to Cloudflare (OAuth with PKCE, no client secret), and creates their Worker through the
// API from the latest release (core releases.ts). It stores nothing: the sign-in's verifier and the
// tokens wait in short-lived cookies sealed with COOKIE_KEY, and the tokens go on to the new Worker,
// which keeps them (its /api/claim).
//
//   GET  /oauth/start       sign in (the site's Connect Cloudflare)
//   GET  /login             Log in with Cloudflare, for an existing Worker (also how a lost
//                           connection comes back): ?worker=<its address>&code=<its one-time code>
//   GET  /reconnect         the same (the address Workers before v2.1.0 send)
//   GET  /move              the same for a Worker made from a repository (the Workers Build path):
//                           the latest release is uploaded over it first, then it takes the tokens
//   GET  /oauth/callback    Cloudflare sends the browser back here
//   GET  /api/accounts      the accounts the sign-in reaches, with their workers.dev subdomains
//   POST /api/create        {account_id, name, mode, subdomain?}: create the Worker, hand it over,
//                           answer {url, ticket} (the page opens url#ticket=…)
// Everything else is the site's static files, served without running the Worker.
//
// On its second address, grpc.lugia19.com, it passes Modal's client API through to our gRPC-web
// proxy (GRPC_UPSTREAM, Envoy on Cloud Run, which allows only the methods setup needs): how Workers
// reach Modal until Workers' own gRPC support is generally available (design §6).

import {
  bodyJson, cfapi, concat, error, fromBase64Url, fromHex, fromUtf8, json, randomBytes, readCookie, releases, safeEqual, toBase64Url, tokenUrlsafe, utf8,
  type Fetch,
} from "@comfy-gen/core";

export type Env = {
  CF_OAUTH_CLIENT: string;
  /** Secret, 64 hex characters: seals the cookies. */
  COOKIE_KEY: string;
  /** Development: a release base (this site's /dev) instead of GitHub's releases. */
  COMFY_GEN_RELEASES?: string;
  /** The gRPC-web proxy behind grpc.lugia19.com. */
  GRPC_UPSTREAM?: string;
};

const GRPC_HOST = "grpc.lugia19.com";
const GRPC_SERVICE = "/modal.client.ModalClient/";

export type Deps = { fetch: Fetch; now: () => number; sleep: (s: number) => Promise<void> };

const MODES = ["cloud", "pc", "both"];
/** Worker and workers.dev names: lowercase letters, digits and dashes, not at the ends. */
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const USER_AGENT = "comfy-gen-setup";
/** How long a new workers.dev address may take to answer (seen: a few seconds). */
const CLAIM_WAIT_S = 30;

// ── Sealed cookies ──────────────────────────────────────────────────────────

async function key(env: Env, use: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromHex(env.COOKIE_KEY) as BufferSource, "AES-GCM", false, [use]);
}

/** *value*, encrypted and authenticated, readable by open() until *exp*. */
export async function seal(env: Env, value: unknown, exp: number): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, await key(env, "encrypt"), utf8(JSON.stringify({ v: value, exp })) as BufferSource);
  return toBase64Url(concat([iv, new Uint8Array(ct)]));
}

export async function open<T>(env: Env, sealed: string | null, now: number): Promise<T | null> {
  if (!sealed) return null;
  try {
    const data = fromBase64Url(sealed);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, 12) as BufferSource }, await key(env, "decrypt"), data.subarray(12) as BufferSource);
    const { v, exp } = JSON.parse(fromUtf8(new Uint8Array(pt)));
    return exp > now ? (v as T) : null;
  } catch {
    return null;
  }
}

const cookie = (req: Request, name: string) => readCookie(req.headers.get("cookie"), name) || null;

const setCookie = (name: string, value: string, path: string, maxAge: number) =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

/** The sign-in in progress: PKCE verifier, state, and for an existing Worker (a login, or a move)
 * the Worker and its code. */
type Pending = { verifier: string; state: string; reconnect?: { worker: string; code: string; move?: boolean } };
/** What each existing-Worker sign-in is called on that Worker's page. */
const BUTTONS: Record<string, string> = { "/login": "Log in with Cloudflare", "/reconnect": "Reconnect Cloudflare", "/move": "Move to the new setup" };
const PENDING = "cg_oauth";
/** After it: the tokens, until the Worker is created (the access token lasts an hour). */
type Tokens = cfapi.OAuthTokens;
const TOKENS = "cg_tokens";
const TOKENS_S = 3000;

// ── Pages ───────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ "&": "amp", "<": "lt", ">": "gt", '"': "quot" })[c]};`);

/** A short page for what happens outside the site (a refused sign-in, a reconnect). */
function page(title: string, text: string, status = 400): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px}</style>
<h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Back to the setup page</a></p>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
};

// ── Routes ──────────────────────────────────────────────────────────────────

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (url.host === GRPC_HOST) {
    if (!env.GRPC_UPSTREAM || !path.startsWith(GRPC_SERVICE) || req.method !== "POST") return error(404, "not found");
    return deps.fetch(releases.trim(env.GRPC_UPSTREAM) + path, { method: "POST", headers: req.headers, body: req.body });
  }
  try {
    if (path === "/oauth/start" && req.method === "GET") return start(env, deps, url, undefined);
    if (BUTTONS[path] && req.method === "GET") {
      const worker = url.searchParams.get("worker") ?? "";
      const code = url.searchParams.get("code") ?? "";
      if (!workersDev(worker) || !code) return page("That link is incomplete", `Start again from your Worker's page: ${BUTTONS[path]}.`);
      return start(env, deps, url, { worker, code, move: path === "/move" });
    }
    if (path === "/oauth/callback" && req.method === "GET") return callback(req, env, deps, url);
    if (path === "/api/accounts" && req.method === "GET") return accounts(req, env, deps);
    if (path === "/api/create" && req.method === "POST") return create(req, env, deps, url);
    return error(404, "not found");
  } catch (e) {
    if (e instanceof cfapi.CloudflareError) {
      return path.startsWith("/api/") ? error(502, e.message) : page("Something went wrong", e.message, 502);
    }
    throw e;
  }
}

async function start(env: Env, deps: Deps, url: URL, reconnect: Pending["reconnect"]): Promise<Response> {
  const { verifier, challenge } = await cfapi.pkcePair();
  const state = tokenUrlsafe(16);
  const sealed = await seal(env, { verifier, state, reconnect } satisfies Pending, deps.now() + 600);
  const to = cfapi.authorizeUrl(env.CF_OAUTH_CLIENT, `${url.origin}/oauth/callback`, state, challenge);
  return redirect(to, [setCookie(PENDING, sealed, "/oauth", 600)]);
}

async function callback(req: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  const q = url.searchParams;
  if (q.get("error")) {
    const denied = q.get("error") === "access_denied";
    return page(denied ? "Not connected" : "Cloudflare refused the sign-in", denied ? "You chose not to allow access, so nothing changed. Comfy-Gen needs it to create your Worker, or to log you in to it." : `${q.get("error")}: ${q.get("error_description") ?? ""}`);
  }
  const p = await open<Pending>(env, cookie(req, PENDING), deps.now());
  if (!p || !safeEqual(q.get("state") ?? "", p.state)) return page("That sign-in expired", "Start again: sign-ins last ten minutes, in the same browser.");
  const tokens = await cfapi.exchangeCode(deps.fetch, env.CF_OAUTH_CLIENT, q.get("code") ?? "", `${url.origin}/oauth/callback`, p.verifier);
  const clear = setCookie(PENDING, "", "/oauth", 0);
  if (p.reconnect) return reconnect(env, deps, url, tokens, p.reconnect, clear);
  return redirect("/#connected", [clear, setCookie(TOKENS, await seal(env, tokens, deps.now() + TOKENS_S), "/api", TOKENS_S)]);
}

/** A Worker address on workers.dev: [script, subdomain], or null. */
function workersDev(worker: string): [string, string] | null {
  try {
    const u = new URL(worker);
    const m = /^([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev$/.exec(u.hostname);
    return u.protocol === "https:" && u.pathname === "/" && m ? [m[1], m[2]] : null;
  } catch {
    return null;
  }
}

/**
 * A sign-in for an existing Worker (Log in with Cloudflare, which also brings new tokens to one
 * that lost its connection): only if it is in an account this sign-in reaches (a link can name any
 * address; the tokens go only to the user's own Worker).
 * A move first uploads the latest release over that Worker (its version from the Workers Build):
 * the same bucket (named as the build named it), its Durable Objects' data (migrations from its
 * tag), and the new setup's vars; routes, the cron and workers.dev stay as they are. Then the new
 * version takes the tokens, and gives up its build.
 */
async function reconnect(env: Env, deps: Deps, url: URL, tokens: Tokens, r: NonNullable<Pending["reconnect"]>, clear: string): Promise<Response> {
  const [script, sub] = workersDev(r.worker)!;
  const t = tokens.access_token;
  const f = deps.fetch;
  const list = await cfapi.listAccounts(f, t);
  const subs = await Promise.all(list.map((a) => cfapi.workersSubdomain(f, t, a.id)));
  const a = list[subs.indexOf(sub)]; // workers.dev subdomains are unique
  const fromTag = a ? await cfapi.scriptMigrationTag(f, t, a.id, script) : undefined;
  if (!a || fromTag === undefined) return page("That Worker isn't in this account", `${r.worker} isn't a Worker in the Cloudflare account you signed in to. Sign in to the account it's in.`);
  const account = a.id;
  if (r.move) {
    const tag = await releases.latestTag(f, env.COMFY_GEN_RELEASES);
    if (!tag) return page("Something went wrong", "Could not find the latest release. Try again in a minute.", 502);
    await install(env, f, t, account, script, tag, url, { fromTag });
  }
  const resp = await claim(deps, r.worker, { reconnect: r.code, tokens, account_id: account }, r.move ? CLAIM_WAIT_S : 0);
  if (!resp.ok) return page("Your Worker refused", (await resp.json().catch(() => ({})) as any).error ?? `HTTP ${resp.status}`);
  const { ticket } = (await resp.json()) as { ticket: string };
  return redirect(`${r.worker}#ticket=${ticket}`, [clear]);
}

/** POST to the Worker's /api/claim. A new workers.dev address answers 404 (or not at all) for a
 * few seconds: retried for up to *waitS*. */
async function claim(deps: Deps, worker: string, body: unknown, waitS: number): Promise<Response> {
  for (let waited = 0; ; waited += 2) {
    const resp = await deps.fetch(`${worker}/api/claim`, {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT }, body: JSON.stringify(body),
    }).catch(() => null);
    if (resp && resp.status !== 404 && resp.status < 500) return resp;
    if (waited >= waitS) return resp ?? error(504, "Your Worker didn't answer.");
    await deps.sleep(2);
  }
}

async function tokensOf(req: Request, env: Env, deps: Deps): Promise<Tokens | null> {
  return open<Tokens>(env, cookie(req, TOKENS), deps.now());
}

const notConnected = () => error(401, "Connect Cloudflare first (sign-ins last 50 minutes).");

async function accounts(req: Request, env: Env, deps: Deps): Promise<Response> {
  const t = await tokensOf(req, env, deps);
  if (!t) return notConnected();
  const list = await cfapi.listAccounts(deps.fetch, t.access_token);
  const subs = await Promise.all(list.map((a) => cfapi.workersSubdomain(deps.fetch, t.access_token, a.id)));
  return json({ accounts: list.map((a, i) => ({ ...a, subdomain: subs[i] })) });
}

/**
 * Create the user's Worker: its R2 bucket (when R2 is on; else it adds the binding later, from its
 * storage step), the latest release uploaded with a one-time CLAIM secret, the daily cron, its
 * workers.dev address; then hand it the tokens (its /api/claim) for a login ticket.
 */
/**
 * Upload release *tag* as *script* (a new Worker, or over one: *fromTag* its migration tag), with the
 * new setup's vars and its bucket, created if missing and given its lifecycle rules. A Worker is
 * made without storage when R2 isn't turned on in the account.
 */
async function install(
  env: Env, f: Fetch, token: string, account: string, script: string, tag: string, url: URL,
  o: { mode?: string; secrets?: Record<string, string>; fromTag: string | null },
): Promise<{ release: releases.Release; storage: boolean }> {
  const bucket = cfapi.bucketName(script);
  const [release, made] = await Promise.all([releases.loadRelease(f, env.COMFY_GEN_RELEASES, tag), cfapi.createBucket(f, token, account, bucket)]);
  const storage = made !== "off";
  const vars: releases.WorkerVars = { SETUP_MODE: o.mode, CF_OAUTH_CLIENT: env.CF_OAUTH_CLIENT, COMFY_GEN_SETUP: url.origin, COMFY_GEN_RELEASES: env.COMFY_GEN_RELEASES };
  await Promise.all([
    storage && cfapi.setLifecycle(f, token, account, bucket),
    releases.uploadRelease(f, token, account, script, release, { bucket: storage ? bucket : null, vars: releases.workerVars(vars), secrets: o.secrets, fromTag: o.fromTag }),
  ]);
  return { release, storage };
}

async function create(req: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  const t = await tokensOf(req, env, deps);
  if (!t) return notConnected();
  const b = await bodyJson(req);
  const { account_id: account, name, mode } = b;
  if (typeof name !== "string" || !NAME.test(name)) return error(400, "The name: lowercase letters, digits and dashes (not at the start or end), up to 63.");
  if (!MODES.includes(mode)) return error(400, `mode: one of ${MODES.join(", ")}`);
  const token = t.access_token;
  const f = deps.fetch;
  if (!(await cfapi.listAccounts(f, token)).some((a) => a.id === account)) return error(400, "Choose one of your accounts.");
  const [existing, tag, sub0] = await Promise.all([
    cfapi.scriptMigrationTag(f, token, account, name),
    releases.latestTag(f, env.COMFY_GEN_RELEASES),
    cfapi.workersSubdomain(f, token, account),
  ]);
  if (existing !== undefined) return error(409, `This account already has a Worker named ${name}. Choose another name.`);
  if (!tag) return error(502, "Could not find the latest release. Try again in a minute.");
  let sub = sub0;
  if (!sub) {
    if (typeof b.subdomain !== "string" || !NAME.test(b.subdomain)) return error(400, "Choose your workers.dev subdomain: lowercase letters, digits and dashes.");
    sub = await cfapi.registerSubdomain(f, token, account, b.subdomain);
  }

  const secret = tokenUrlsafe(32);
  const { release, storage } = await install(env, f, token, account, name, tag, url, { mode, secrets: { CLAIM: secret }, fromTag: null });
  await Promise.all([cfapi.setCrons(f, token, account, name, release.manifest.crons), cfapi.enableWorkersDev(f, token, account, name)]);

  const worker = `https://${name}.${sub}.workers.dev`;
  const resp = await claim(deps, worker, { claim: secret, tokens: t, account_id: account, script: name }, CLAIM_WAIT_S);
  if (!resp.ok) return error(502, `Your Worker is created, but didn't take the hand-off (${(await resp.json().catch(() => ({})) as any).error ?? `HTTP ${resp.status}`}). Open ${worker} and log in with a Cloudflare token.`);
  const { ticket } = (await resp.json()) as { ticket: string };
  // new_address: the account's workers.dev subdomain was made just now, and its certificate takes a
  // few minutes, so browsers refuse the address until then (seen 2026-10-18).
  return json({ url: worker, ticket, version: tag, storage, new_address: !sub0 }, 200, { "Set-Cookie": setCookie(TOKENS, "", "/api", 0) });
}
