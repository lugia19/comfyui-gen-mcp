// A Worker created by the setup Worker updates itself (design §6/§7): it uploads a release's
// worker-bundle.js as a new version of its own script, through the Cloudflare API with its OAuth
// token, no Workers Build. The release's worker-manifest.json says the rest (bindings, migrations,
// static assets); the static files are uploaded only when Cloudflare lacks them (most releases ask
// for one or two). About 3.5 s, so the page waits for it.

import { cfapi } from "@comfy-gen/core";
import type { Fetch } from "./platform.ts";
import { latestRelease } from "./updates.ts";

const RELEASES = "https://github.com/lugia19/comfyui-gen-mcp/releases";

/** Vars every version carries over from the one before (the setup Worker set them); VERSION is the
 * new one's. COMFY_GEN_RELEASES: a development base for bundles instead of GitHub's releases. */
export const CARRIED_VARS = ["SETUP_MODE", "CF_OAUTH_CLIENT", "COMFY_GEN_SETUP", "COMFY_GEN_RELEASES"] as const;

export function carriedVars(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(CARRIED_VARS.filter((k) => env[k]).map((k) => [k, env[k]!]));
}

/** Where *tag*'s files are: GitHub's release downloads, or the development base. */
export function releaseFiles(env: Record<string, string | undefined>, tag: string): string {
  return env.COMFY_GEN_RELEASES ? `${env.COMFY_GEN_RELEASES.replace(/\/$/, "")}/${tag}/` : `${RELEASES}/download/${tag}/`;
}

/** The latest release's tag; under a development base, its latest.txt. */
export async function latestTag(fetch: Fetch, env: Record<string, string | undefined>): Promise<string | null> {
  if (!env.COMFY_GEN_RELEASES) return latestRelease(fetch);
  const r = await fetch(`${env.COMFY_GEN_RELEASES.replace(/\/$/, "")}/latest.txt`);
  return r.ok ? (await r.text()).trim() || null : null;
}

export class UpdateError extends Error {
  name = "UpdateError";
}

async function get(fetch: Fetch, url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new UpdateError(`${url}: HTTP ${r.status} (is the release complete?)`);
  return r;
}

export type SelfUpdate = {
  token: string;
  account: string;
  script: string;
  tag: string;
  /** The bucket to bind, or null while R2 is off. */
  bucket: string | null;
  env: Record<string, string | undefined>;
};

/** Upload *tag* as this Worker's new version. Throws UpdateError, cfapi.CloudflareError. */
export async function selfUpdate(fetch: Fetch, u: SelfUpdate): Promise<{ uploaded: number }> {
  const base = releaseFiles(u.env, u.tag);
  const manifest: cfapi.WorkerManifest = await (await get(fetch, base + "worker-manifest.json")).json();
  const module = new Uint8Array(await (await get(fetch, base + "worker-bundle.js")).arrayBuffer());
  if ((await cfapi.sha256Hex(module)) !== manifest.module.sha256) throw new UpdateError(`${u.tag}: the bundle doesn't match its manifest`);
  let assets: Record<string, string> | null = null; // fetched only if Cloudflare asks for files
  const { jwt, uploaded } = await cfapi.uploadAssets(fetch, u.token, u.account, u.script, manifest, async (hashes) => {
    assets ??= await (await get(fetch, base + "worker-assets.json")).json();
    return Object.fromEntries(hashes.map((h) => [h, assets![h]]));
  });
  const fromTag = await cfapi.scriptMigrationTag(fetch, u.token, u.account, u.script);
  await cfapi.uploadScript(fetch, u.token, u.account, u.script, manifest, module, {
    bucket: u.bucket, vars: { ...carriedVars(u.env), VERSION: u.tag }, assetsJwt: jwt, fromTag: fromTag ?? null,
  });
  return { uploaded };
}
