// Updates (design §7), from the daily check or the settings page's Update now. A Worker made from a
// repository starts a Workers Build, which fetches the release (nothing to sync in the user's copy
// of the template: its deploy command downloads the latest release's deploy.sh on every build). A
// Worker made by the setup Worker uploads the release as a new version of itself (App.uploadSelf).

import { cfapi, releases } from "@comfy-gen/core";
import * as cloudflare from "./cloudflare.ts";
import type { Fetch } from "./platform.ts";
import type { Store } from "./store.ts";

export function parseVersion(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((tag || "").trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// Right after a release, GitHub's caches disagree for a few minutes: some answer the new tag, some
// still the old one, and a Worker's requests go out through many IPs. Seen 2026-10-13: the page
// showed "Update to v1.12.0", and a reload hid it again.
const SEEN_FOR_S = 3600;
export type Seen = { tag: string; at: number };

/** The latest release for the settings page: GitHub's answer, unless a newer one was seen within
 * the last hour (*seen*). Also what to remember, or null when nothing changes. Only an hour, so a
 * release deleted after it was seen stops being offered. */
export function steadyLatest(fetched: string | null, seen: Seen | null, now: number): [string | null, Seen | null] {
  if (seen && now - seen.at < SEEN_FOR_S && (!fetched || isNewer(seen.tag, fetched))) return [seen.tag, null];
  if (!fetched || (seen && seen.tag === fetched && now - seen.at < SEEN_FOR_S)) return [fetched, null];
  return [fetched, { tag: fetched, at: now }];
}

/** Start a build now, which deploys *latest* (the Worker, and the Modal app if set up). Recorded as
 * the current build, so the setup page shows its log. Throws CloudflareError. */
export async function startUpdate(fetch: Fetch, store: Store, latest: string): Promise<string> {
  const s = await store.secrets();
  const build = await cloudflare.startBuild(fetch, s.cf_token, s.cf_account_id, s.cf_trigger, s.cf_branch || "main");
  await store.updateSetup({ update_tried: latest, build, update_build: build });
  return build;
}

/** Whether *latest* is newer than *current*. A development build ("dev") is never up to date. */
export function isNewer(latest: string | null, current: string): boolean {
  const next = parseVersion(latest ?? "");
  const cur = parseVersion(current);
  return Boolean(next) && (!cur || newer(next!, cur));
}

/**
 * How a Worker installs a release. A Worker made from a repository starts a Workers Build of it
 * (buildUpdater); one made by the setup Worker uploads it as a new version of itself (App, design §6).
 */
export type Updater = {
  path: "build" | "oauth";
  /** The latest release's tag. */
  latest(): Promise<string | null>;
  /** Why it can't update now (no token to start builds with, Cloudflare connection lost), or null. */
  blocked(): Promise<string | null>;
  /** Install *tag* (also the running version again: the storage check, *modal* false: Modal's app
   * stays as it is). {build}: a Workers Build started, which finishes later (and deploys Modal
   * too); {storage}: the version is live, with R2 bound or not. Throws cfapi.CloudflareError. */
  install(tag: string, o?: { modal?: boolean }): Promise<{ build?: string; storage?: boolean }>;
};

export function buildUpdater(fetch: Fetch, store: Store): Updater {
  return {
    path: "build",
    latest: () => releases.latestTag(fetch, undefined),
    async blocked() {
      const s = await store.secrets();
      return s.cf_token && s.cf_trigger ? null : "Log in again with a Cloudflare token: this Worker has none to start builds with.";
    },
    install: async (tag) => ({ build: await startUpdate(fetch, store, tag) }),
  };
}

/** The daily check: install a newer release, once per release. Returns what happened, for the log.
 * A development build (a branch or "dev", not a release tag) never updates itself: whoever made it
 * decides when it goes back to releases. */
export async function check(store: Store, current: string, u: Updater): Promise<string> {
  const cur = parseVersion(current);
  if (!cur) return `development build (${current}): no automatic updates`;
  const latest = await u.latest();
  const next = parseVersion(latest ?? "");
  if (!next) return "no release found";
  if (!newer(next, cur)) return `up to date (${current})`;
  if ((await store.setup()).update_tried === latest) return `already tried ${latest}`;
  const blocked = await u.blocked();
  if (blocked) return `not updating: ${blocked}`;
  await store.updateSetup({ update_tried: latest });
  try {
    const r = await u.install(latest!);
    await store.updateSetup({ update_error: null });
    return `updating ${current} -> ${latest}${r.build ? ` (build ${r.build})` : ": done"}`;
  } catch (e) {
    if (!(e instanceof cfapi.CloudflareError)) throw e;
    await store.updateSetup({ update_error: e.message });
    return `could not update to ${latest}: ${e.message}`;
  }
}
