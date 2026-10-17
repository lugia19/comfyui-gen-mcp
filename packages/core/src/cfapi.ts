// The Cloudflare API calls that create and update a Worker without wrangler or Workers Builds
// (design §6, "Setup without a repository"): the setup Worker uses them to create the user's Worker,
// and that Worker to upload new versions of itself. Also Cloudflare OAuth (PKCE). Web APIs only.
//
// Everything a Worker version needs comes from the release's worker-manifest.json (WorkerManifest),
// which the release build writes from packages/worker/wrangler.jsonc, so the two never drift.

import type { Fetch } from "./comfyui.ts";
import { sha256, toBase64Url, tokenUrlsafe, utf8 } from "./bytes.ts";

export const CF_API = "https://api.cloudflare.com/client/v4";
export const CF_OAUTH_AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth";
export const CF_OAUTH_TOKEN = "https://dash.cloudflare.com/oauth2/token";
/** What setup and self-update need; offline_access brings the refresh token. */
export const CF_OAUTH_SCOPES = ["workers-scripts.write", "workers-r2.write", "account-settings.read", "offline_access"];

/** A Cloudflare API call failed. *code* is the first API error code, when there is one. The base
 * of the sign-in's and a release's errors too (OAuthError, releases.ReleaseError): one check
 * catches every failure whose message is for the page. */
export class CloudflareError extends Error {
  name = "CloudflareError";
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/** One API call: JSON in (or a FormData body), the envelope's result out. */
export async function cfCall(fetch: Fetch, token: string, method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const resp = await fetch(CF_API + path, { method, headers, body: payload });
  let json: any;
  try {
    json = await resp.json();
  } catch {
    throw new CloudflareError(`${method} ${path}: HTTP ${resp.status}`);
  }
  if (!json?.success) {
    const errors: { code: number; message: string }[] = json?.errors ?? [];
    const text = errors.map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new CloudflareError(`${method} ${path}: ${text || `HTTP ${resp.status}`}`, errors[0]?.code);
  }
  return json.result;
}

// ── The release's description of a Worker version ───────────────────────────

export type WorkerManifest = {
  version: string;
  module: { name: string; sha256: string; size: number };
  compatibility_date: string;
  compatibility_flags: string[];
  durable_objects: { name: string; class_name: string }[];
  migrations: { tag: string; new_sqlite_classes?: string[]; [k: string]: unknown }[];
  /** The R2 binding's name; the bucket is the Worker's own (`<script>-storage`). */
  r2_binding: string;
  assets: { binding: string; config: Record<string, unknown>; files: Record<string, { hash: string; size: number }> };
  crons: string[];
};

export const bucketName = (script: string) => `${script}-storage`;

// ── Account, R2, workers.dev, cron ──────────────────────────────────────────

export async function listAccounts(fetch: Fetch, token: string): Promise<{ id: string; name: string }[]> {
  return ((await cfCall(fetch, token, "GET", "/accounts?per_page=50")) ?? []).map((a: any) => ({ id: a.id, name: a.name }));
}

/** Create the Worker's bucket. "off": R2 isn't enabled on the account yet (it needs a card on file,
 * error 10042), so the Worker goes up without the binding and adds it later. */
export async function createBucket(fetch: Fetch, token: string, account: string, name: string): Promise<"created" | "exists" | "off"> {
  try {
    await cfCall(fetch, token, "POST", `/accounts/${account}/r2/buckets`, { name });
    return "created";
  } catch (e) {
    if (!(e instanceof CloudflareError)) throw e;
    if (e.code === 10042) return "off";
    if (e.code === 10004) return "exists";
    throw e;
  }
}

/** As deploy.py set them: images expire after a year, unfinished multipart uploads after a day. */
export async function setLifecycle(fetch: Fetch, token: string, account: string, bucket: string): Promise<void> {
  await cfCall(fetch, token, "PUT", `/accounts/${account}/r2/buckets/${bucket}/lifecycle`, {
    rules: [
      { id: "expire-images", enabled: true, conditions: { prefix: "img/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 365 * 86400 } } },
      { id: "abort-multipart", enabled: true, conditions: { prefix: "" }, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86400 } } },
    ],
  });
}

/** The account's workers.dev subdomain, or null on an account that never registered one. */
export async function workersSubdomain(fetch: Fetch, token: string, account: string): Promise<string | null> {
  try {
    return (await cfCall(fetch, token, "GET", `/accounts/${account}/workers/subdomain`))?.subdomain || null;
  } catch (e) {
    if (e instanceof CloudflareError && (e.code === 10007 || /not.?found/i.test(e.message))) return null; // not registered yet
    throw e;
  }
}

export async function registerSubdomain(fetch: Fetch, token: string, account: string, name: string): Promise<string> {
  return (await cfCall(fetch, token, "PUT", `/accounts/${account}/workers/subdomain`, { subdomain: name })).subdomain;
}

export async function enableWorkersDev(fetch: Fetch, token: string, account: string, script: string): Promise<void> {
  await cfCall(fetch, token, "POST", `/accounts/${account}/workers/scripts/${script}/subdomain`, { enabled: true, previews_enabled: false });
}

export async function setCrons(fetch: Fetch, token: string, account: string, script: string, crons: string[]): Promise<void> {
  await cfCall(fetch, token, "PUT", `/accounts/${account}/workers/scripts/${script}/schedules`, crons.map((cron) => ({ cron })));
}

/** The migration tag a script is at, or null when it doesn't exist (yet). */
export async function scriptMigrationTag(fetch: Fetch, token: string, account: string, script: string): Promise<string | null | undefined> {
  const scripts: any[] = (await cfCall(fetch, token, "GET", `/accounts/${account}/workers/scripts`)) ?? [];
  const found = scripts.find((s) => s.id === script);
  return found ? (found.migration_tag ?? null) : undefined;
}

// ── Uploading a version ─────────────────────────────────────────────────────

/** Content types by extension, as wrangler sends them: Cloudflare serves each file with the type it
 * was uploaded with (none at all for an unknown one, and a browser won't run a script without one). */
const TYPES: Record<string, string> = {
  html: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", map: "application/json",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", ico: "image/x-icon",
  txt: "text/plain", xml: "application/xml", woff: "font/woff", woff2: "font/woff2", wasm: "application/wasm",
};
export const contentType = (path: string) => TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

/** Static assets through an upload session: Cloudflare names the files it lacks, only those are
 * sent (*files(hashes)* gives each one's base64 content), and the final token goes with the script. */
export async function uploadAssets(
  fetch: Fetch, token: string, account: string, script: string, manifest: WorkerManifest,
  files: (hashes: string[]) => Promise<Record<string, string>>,
): Promise<{ jwt: string; uploaded: number }> {
  const session = await cfCall(fetch, token, "POST", `/accounts/${account}/workers/scripts/${script}/assets-upload-session`, {
    manifest: manifest.assets.files,
  });
  const types = Object.fromEntries(Object.entries(manifest.assets.files).map(([path, f]) => [f.hash, contentType(path)]));
  let jwt: string = session.jwt;
  let uploaded = 0;
  for (const batch of (session.buckets ?? []) as string[][]) {
    const content = await files(batch);
    const form = new FormData();
    for (const hash of batch) form.append(hash, new Blob([content[hash]], { type: types[hash] }), hash);
    const result = await cfCall(fetch, jwt, "POST", `/accounts/${account}/workers/assets/upload?base64=true`, form);
    jwt = result?.jwt || jwt;
    uploaded += batch.length;
  }
  return { jwt, uploaded };
}

export type VersionOptions = {
  /** The bucket, or null to go up without the R2 binding (R2 not enabled yet). */
  bucket: string | null;
  /** Plain-text vars: VERSION, SETUP_MODE… */
  vars: Record<string, string>;
  /** Secret vars set with this upload (the setup's CLAIM); existing secrets are always kept. */
  secrets?: Record<string, string>;
  assetsJwt: string;
  /** The migration tag the script is at now: undefined for a new script. */
  fromTag?: string | null;
};

/** The script's metadata, as wrangler builds it from wrangler.jsonc. */
export function versionMetadata(m: WorkerManifest, o: VersionOptions): Record<string, unknown> {
  const bindings: Record<string, unknown>[] = [
    ...m.durable_objects.map((d) => ({ type: "durable_object_namespace", name: d.name, class_name: d.class_name })),
    { type: "assets", name: m.assets.binding },
    ...Object.entries(o.vars).map(([name, text]) => ({ type: "plain_text", name, text })),
    ...Object.entries(o.secrets ?? {}).map(([name, text]) => ({ type: "secret_text", name, text })),
  ];
  if (o.bucket) bindings.push({ type: "r2_bucket", name: m.r2_binding, bucket_name: o.bucket });
  const last = m.migrations.at(-1)?.tag;
  const done = o.fromTag ? m.migrations.findIndex((s) => s.tag === o.fromTag) : -1;
  const steps = m.migrations.slice(done + 1).map(({ tag: _, ...step }) => step);
  return {
    main_module: m.module.name,
    compatibility_date: m.compatibility_date,
    compatibility_flags: m.compatibility_flags,
    bindings,
    keep_bindings: ["secret_text"],
    migrations: o.fromTag === undefined || o.fromTag === null ? { new_tag: last, steps } : { old_tag: o.fromTag, new_tag: last, steps },
    observability: { enabled: true },
    assets: { jwt: o.assetsJwt, config: m.assets.config },
  };
}

export async function uploadScript(
  fetch: Fetch, token: string, account: string, script: string, m: WorkerManifest, module: Uint8Array, o: VersionOptions,
): Promise<void> {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(versionMetadata(m, o))], { type: "application/json" }));
  form.append(m.module.name, new Blob([module as Uint8Array<ArrayBuffer>], { type: "application/javascript+module" }), m.module.name);
  await cfCall(fetch, token, "PUT", `/accounts/${account}/workers/scripts/${script}`, form);
}


// ── OAuth (authorization code with PKCE; no client secret) ──────────────────

export type OAuthTokens = { access_token: string; refresh_token: string; expires_in: number; scope?: string };

/** The token endpoint refused: *error* is OAuth's code ("invalid_grant": the refresh token is gone,
 * the user must connect again). */
export class OAuthError extends CloudflareError {
  name = "OAuthError";
  readonly error: string;
  constructor(error: string, description: string) {
    super(`Cloudflare sign-in: ${error}${description ? ` (${description})` : ""}`);
    this.error = error;
  }
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = tokenUrlsafe(32);
  const challenge = toBase64Url(await sha256(utf8(verifier)));
  return { verifier, challenge };
}

export function authorizeUrl(clientId: string, redirect: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: "code", scope: CF_OAUTH_SCOPES.join(" "),
    state, code_challenge: challenge, code_challenge_method: "S256",
  });
  return `${CF_OAUTH_AUTHORIZE}?${q}`;
}

async function tokenCall(fetch: Fetch, form: Record<string, string>): Promise<OAuthTokens> {
  const resp = await fetch(CF_OAUTH_TOKEN, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(),
  });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) throw new OAuthError(json.error || `HTTP ${resp.status}`, json.error_description || "");
  return json;
}

export const exchangeCode = (fetch: Fetch, clientId: string, code: string, redirect: string, verifier: string) =>
  tokenCall(fetch, { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier });

/** Each refresh rotates the refresh token: store the new one before using the access token. */
export const refreshTokens = (fetch: Fetch, clientId: string, refreshToken: string) =>
  tokenCall(fetch, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
