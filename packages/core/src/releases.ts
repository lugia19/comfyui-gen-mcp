// Releases: which one is the latest, and a release's Worker bundle (worker-manifest.json,
// worker-bundle.js, worker-assets.json; packages/worker/build-bundle.mjs) uploaded as a version of a
// Worker. The setup Worker creates Workers from it, and a Worker it created updates itself (design §6).
// A development base (packages/setup serves one at /dev/) stands in for GitHub's releases in tests.

import type { Fetch } from "./comfyui.ts";
import { sha256Hex } from "./bytes.ts";
import * as cfapi from "./cfapi.ts";

const GITHUB = "https://github.com/lugia19/comfyui-gen-mcp/releases";

/**
 * The latest release's tag, from the redirect github.com/<repo>/releases/latest answers with
 * (…/releases/tag/<tag>). Not the REST API: its unauthenticated limit is 60 requests an hour per IP,
 * and Workers share their outgoing IPs, so from a Worker it often answers 403 (seen live: the
 * v1.0.0 cron check logged "no release found").
 */
async function latestRelease(fetch: Fetch): Promise<string | null> {
  const resp = await fetch(`${GITHUB}/latest`, { redirect: "manual" });
  const m = /\/releases\/tag\/([^/?#]+)$/.exec(resp.headers.get("location") ?? "");
  return m ? decodeURIComponent(m[1]) : null;
}

export const trim = (base: string) => base.replace(/\/$/, "");

/** The plain-text vars the setup Worker sets on a Worker it creates, which every version it uploads
 * of itself carries over (VERSION is each version's own): the answer to "where should images be
 * made?", the OAuth client it signs in with, the setup site's address (for Reconnect Cloudflare),
 * and in development a release base instead of GitHub's. */
export const WORKER_VARS = ["SETUP_MODE", "CF_OAUTH_CLIENT", "COMFY_GEN_SETUP", "COMFY_GEN_RELEASES"] as const;
export type WorkerVars = Partial<Record<(typeof WORKER_VARS)[number], string>>;

/** The WORKER_VARS set in *env*. */
export function workerVars(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(WORKER_VARS.filter((k) => env[k]).map((k) => [k, env[k]!]));
}

/** Where *tag*'s files are: GitHub's release downloads, or the tag's folder under *base*. */
function releaseFiles(base: string | undefined, tag: string): string {
  return base ? `${trim(base)}/${tag}/` : `${GITHUB}/download/${tag}/`;
}

/** The latest tag: GitHub's, or the development base's latest.txt. */
export async function latestTag(fetch: Fetch, base: string | undefined): Promise<string | null> {
  if (!base) return latestRelease(fetch);
  const r = await fetch(`${trim(base)}/latest.txt`);
  return r.ok ? (await r.text()).trim() || null : null;
}

/** A release's files are missing or don't add up. */
export class ReleaseError extends cfapi.CloudflareError {
  name = "ReleaseError";
}

export type Release = { tag: string; files: string; manifest: cfapi.WorkerManifest; module: Uint8Array };

async function get(fetch: Fetch, url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new ReleaseError(`${url}: HTTP ${r.status} (is the release complete?)`);
  return r;
}

/** *tag*'s manifest and module, the module checked against the manifest. */
export async function loadRelease(fetch: Fetch, base: string | undefined, tag: string): Promise<Release> {
  const files = releaseFiles(base, tag);
  const [manifest, module] = await Promise.all([
    get(fetch, files + "worker-manifest.json").then((r) => r.json() as Promise<cfapi.WorkerManifest>),
    get(fetch, files + "worker-bundle.js").then(async (r) => new Uint8Array(await r.arrayBuffer())),
  ]);
  if ((await sha256Hex(module)) !== manifest.module.sha256) throw new ReleaseError(`${tag}: the bundle doesn't match its manifest`);
  return { tag, files, manifest, module };
}

/** Upload *r* as a new version of *script* (created if missing): the static files Cloudflare lacks
 * (worker-assets.json is fetched only if it lacks any), then the module with VERSION set to the tag.
 * Throws ReleaseError, cfapi.CloudflareError. */
export async function uploadRelease(
  fetch: Fetch, token: string, account: string, script: string, r: Release, o: Omit<cfapi.VersionOptions, "assetsJwt">,
): Promise<{ uploaded: number }> {
  let assets: Promise<Record<string, string>> | null = null;
  const { jwt, uploaded } = await cfapi.uploadAssets(fetch, token, account, script, r.manifest, async (hashes) => {
    assets ??= get(fetch, r.files + "worker-assets.json").then((x) => x.json());
    const all = await assets;
    return Object.fromEntries(hashes.map((h) => [h, all[h]]));
  });
  await cfapi.uploadScript(fetch, token, account, script, r.manifest, r.module, { ...o, vars: { ...o.vars, VERSION: r.tag }, assetsJwt: jwt });
  return { uploaded };
}
