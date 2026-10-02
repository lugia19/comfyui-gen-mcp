// The entry point of both local programs: the Claude Desktop extension's server (the .mcpb runs
// this file) and, with `--app agent`, the PC agent (the launcher, packages/launcher, runs it). It
// loads the newest bundle it has (comfy-gen.mjs, which holds both), cached in
// ~/.comfy-gen-mcp/app/<tag>/ or shipped in the .mcpb, and starts the app in this process. At most
// once a day it looks up the latest release (the github.com/<repo>/releases/latest redirect, as the
// Worker's update check does) and downloads that release's bundle in the background, for the next
// start. The agent checks at every start and then hourly while it runs (it is one process, so one
// request an hour), and a newer bundle is handed to updateReady(), which restarts into it. Keep
// this file small and stable: it only changes when users reinstall the extension or the launcher.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "lugia19/comfyui-gen-mcp";
const RELEASES = process.env.COMFY_GEN_RELEASES_URL || `https://github.com/${REPO}/releases`;
const APP = process.argv.includes("--app") ? process.argv[process.argv.indexOf("--app") + 1] : "server";
const BUNDLE = "comfy-gen.mjs";
const CHECK_EVERY_MS = 24 * 3600 * 1000;
const KEEP = 2; // cached bundles kept: the newest and one to fall back to
const UA = { "User-Agent": "comfy-gen-shim" };

const home = process.env.COMFY_GEN_HOME || join(homedir(), ".comfy-gen-mcp");
const appDir = join(home, "app");
const shipped = join(dirname(fileURLToPath(import.meta.url)), "bundle"); // <tag>/comfy-gen.mjs

const say = (msg: string) => process.stderr.write(`[comfy-gen shim] ${msg}\n`); // the server's stdout is MCP

type Tag = [string, number[]];
function parseTag(tag: string): Tag | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? [tag, [Number(m[1]), Number(m[2]), Number(m[3])]] : null;
}
const newer = (a: Tag, b: Tag) => {
  for (let i = 0; i < 3; i++) if (a[1][i] !== b[1][i]) return a[1][i] > b[1][i];
  return false;
};

/** Bundles on disk, newest first: [tag, path]. */
function bundles(): [string, string][] {
  const found: [Tag, string][] = [];
  for (const dir of [appDir, shipped]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const tag = parseTag(name);
      const path = join(dir, name, BUNDLE);
      if (tag && existsSync(path)) found.push([tag, path]);
    }
  }
  found.sort((a, b) => (newer(a[0], b[0]) ? -1 : newer(b[0], a[0]) ? 1 : 0));
  return found.map(([t, path]) => [t[0], path]);
}

async function latestTag(): Promise<string | null> {
  const resp = await fetch(`${RELEASES}/latest`, { redirect: "manual", headers: UA, signal: AbortSignal.timeout(15_000) });
  const tag = /\/tag\/([^/?#]+)/.exec(resp.headers.get("location") ?? "")?.[1];
  return tag && parseTag(decodeURIComponent(tag)) ? decodeURIComponent(tag) : null;
}

/** Download *tag*'s bundle into the cache. HTTPS guards its content; the length check catches a
 * cut-off download, and a bundle that fails to load is skipped for an older one anyway. */
async function download(tag: string): Promise<void> {
  const url = `${RELEASES}/download/${tag}/${BUNDLE}`;
  const resp = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const data = Buffer.from(await resp.arrayBuffer());
  const length = resp.headers.get("content-encoding") ? null : resp.headers.get("content-length");
  if (!data.length || (length !== null && Number(length) !== data.length)) throw new Error(`${url}: incomplete download`);
  const dir = join(appDir, tag);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${BUNDLE}.part`), data);
  renameSync(join(dir, `${BUNDLE}.part`), join(dir, BUNDLE));
}

/** Once a day: fetch the latest release's bundle if we lack it; prune old ones. */
async function update(force: boolean): Promise<void> {
  const stamp = join(appDir, "checked");
  let last = 0;
  try {
    last = Number(readFileSync(stamp, "utf8")) || 0;
  } catch {
    // never checked
  }
  if (!force && Date.now() - last < CHECK_EVERY_MS) return;
  mkdirSync(appDir, { recursive: true });
  writeFileSync(stamp, String(Date.now()));
  const tag = await latestTag();
  if (!tag) throw new Error("could not read the latest release tag");
  if (!bundles().some(([t]) => t === tag)) {
    say(`downloading ${tag}`);
    await download(tag);
  }
  const cached = readdirSync(appDir).map(parseTag).filter((t): t is Tag => t !== null);
  cached.sort((a, b) => (newer(a, b) ? -1 : 1));
  for (const [old] of cached.slice(KEEP)) rmSync(join(appDir, old), { recursive: true, force: true });
}

const failed = (e: unknown) => void say(`update check failed: ${(e as Error).message}`);

type Bundle = { start?: (app: string) => Promise<void>; updateReady?: (tag: string) => void };
const broken = new Set<string>(); // bundles that failed to load in this process: never offered

/** For a long-running bundle (the agent): tell it when the first check brought a newer bundle, and
 * repeat the check hourly while it runs. */
function watchUpdates(running: string, mod: Bundle, first: Promise<void>): void {
  const current = parseTag(running);
  const notify = mod.updateReady;
  if (!current || !notify) return;
  const offer = () => {
    const newest = parseTag(bundles().find(([t]) => !broken.has(t))?.[0] ?? "");
    if (newest && newer(newest, current)) notify(newest[0]);
  };
  void first.then(offer);
  setInterval(() => void update(true).then(offer, failed), 3600 * 1000).unref();
}

async function run(): Promise<void> {
  if (APP !== "server" && APP !== "agent") throw new Error(`unknown app ${APP}`);
  const override = process.env.COMFY_GEN_BUNDLE; // development: a local build
  let candidates = override ? [["dev", override] as [string, string]] : bundles();
  let checking = Promise.resolve();
  if (!override) {
    const first = update(APP === "agent" || !candidates.length); // the agent: at every start
    if (!candidates.length) {
      await first; // nothing to run yet: this one we wait for
      candidates = bundles();
    }
    checking = first.catch(failed);
  }
  for (const [tag, path] of candidates) {
    let mod: Bundle;
    try {
      mod = await import(pathToFileURL(path).href);
    } catch (e) {
      say(`bundle ${tag} failed to load, trying an older one: ${(e as Error).message}`);
      broken.add(tag);
      continue;
    }
    say(`running ${APP} ${tag}`);
    await mod.start!(APP);
    if (APP === "agent") watchUpdates(tag, mod, checking);
    return;
  }
  throw new Error("no bundle could be loaded");
}

run().catch((e) => {
  say(`cannot start: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
