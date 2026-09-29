// Daily update check: a newer GitHub release starts a Workers Build, which fetches that release.
// Nothing to sync in the user's copy of the template: its deploy command downloads the latest
// release's deploy.sh on every build (design §7).

import * as cloudflare from "./cloudflare.ts";
import type { Fetch } from "./platform.ts";
import type { Store } from "./store.ts";

const REPO = "lugia19/comfyui-gen-mcp";

export function parseVersion(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((tag || "").trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * The latest release's tag, from the redirect github.com/<repo>/releases/latest answers with
 * (…/releases/tag/<tag>). Not the REST API: its unauthenticated limit is 60 requests an hour per IP,
 * and Workers share their outgoing IPs, so from a Worker it often answers 403 (seen live: the
 * v1.0.0 cron check logged "no release found").
 */
export async function latestRelease(fetch: Fetch): Promise<string | null> {
  const resp = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual" });
  const m = /\/releases\/tag\/([^/?#]+)$/.exec(resp.headers.get("location") ?? "");
  return m ? decodeURIComponent(m[1]) : null;
}

/** Start a build if a newer release exists. Returns what happened, for the log. */
export async function check(fetch: Fetch, store: Store, current: string): Promise<string> {
  const latest = await latestRelease(fetch);
  const next = parseVersion(latest ?? "");
  const cur = parseVersion(current);
  if (!next) return "no release found";
  if (cur && !newer(next, cur)) return `up to date (${current})`;
  const setup = await store.setup();
  if (setup.update_tried === latest) return `already tried ${latest}`;
  const s = await store.secrets();
  if (!s.cf_token || !s.cf_trigger) return "no Cloudflare token: updates are off";
  let build: string;
  try {
    build = await cloudflare.startBuild(fetch, s.cf_token, s.cf_account_id, s.cf_trigger, s.cf_branch || "main");
  } catch (e) {
    if (e instanceof cloudflare.CloudflareError) return `could not start the update build: ${e.message}`;
    throw e;
  }
  await store.updateSetup({ update_tried: latest, build });
  return `updating ${current} -> ${latest} (build ${build})`;
}
