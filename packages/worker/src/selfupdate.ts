// A Worker created by the setup Worker updates itself (design §6/§7): it uploads a release's
// worker bundle as a new version of its own script, through the Cloudflare API with its OAuth
// token, no Workers Build (core releases.ts). About 3.5 s, so the page waits for it.

import { cfapi, releases } from "@comfy-gen/core";
import type { Fetch } from "./platform.ts";

/** Vars every version carries over from the one before (the setup Worker set them); VERSION is the
 * new one's. COMFY_GEN_RELEASES: a development base for bundles instead of GitHub's releases. */
export const CARRIED_VARS = ["SETUP_MODE", "CF_OAUTH_CLIENT", "COMFY_GEN_SETUP", "COMFY_GEN_RELEASES"] as const;

export function carriedVars(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(CARRIED_VARS.filter((k) => env[k]).map((k) => [k, env[k]!]));
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

/** Upload *tag* as this Worker's new version. Throws releases.ReleaseError, cfapi.CloudflareError. */
export async function selfUpdate(fetch: Fetch, u: SelfUpdate): Promise<{ uploaded: number }> {
  const [release, fromTag] = await Promise.all([
    releases.loadRelease(fetch, u.env.COMFY_GEN_RELEASES, u.tag),
    cfapi.scriptMigrationTag(fetch, u.token, u.account, u.script),
  ]);
  return releases.uploadRelease(fetch, u.token, u.account, u.script, release, { bucket: u.bucket, vars: carriedVars(u.env), fromTag: fromTag ?? null });
}
