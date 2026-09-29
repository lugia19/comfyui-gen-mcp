// Finding the model folders already on this machine, so nothing is downloaded twice (models.ts has
// the why). Sources, besides ours and the user's extra folder:
//   - ComfyUI installs: comfy-cli's workspaces (its config.ini), the ComfyUI Desktop app (its
//     config.json and extra_models_config.yaml), the newer Comfy Desktop app (installations.json,
//     settings.json's modelsDirs, shared_model_paths.yaml), the ~/.comfy-registry entries, and a
//     shallow scan of the usual places (home, Desktop, Documents, Downloads, and on Windows each
//     drive's root) for folders named like ComfyUI
// Sources whose folders are all empty are dropped (a stale registry entry in a temp folder, seen
// live), as are folders that are the same folder by another name (junctions, symlinks).
//   - for each install, the folders its own extra_model_paths.yaml names: that is where a big
//     model drive usually is
// Found folders are only read; ours is where downloads go.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  canonType, folderKey, hasEntries, isDir, mergeFolders, parseExtraModelPaths, registryDir, registryEntries, SHARED_SUBFOLDERS, standardFolders,
  type ModelFolders, type ModelSource,
} from "./models.ts";

export type DiscoverOptions = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  registry?: string;
  roots?: string[]; // scan roots; default: the usual places
};

const MAX_DIRS_READ = 400; // the scan's budget: it runs at every ComfyUI start
const SKIP = /^(\$|\.|windows$|program ?files|programdata$|appdata$|system volume information$|node_modules$|library$)/i;

/** The ComfyUI folder at *dir* (itself, or ComfyUI/ inside, as in the Windows portable build). */
export function comfyAt(dir: string): string | null {
  for (const d of [dir, join(dir, "ComfyUI")]) {
    if (existsSync(join(d, "main.py")) && isDir(join(d, "models"))) return d;
  }
  return null;
}

function comfyCliWorkspaces(home: string, platform: NodeJS.Platform): string[] {
  const configDir =
    platform === "win32" ? join(home, "AppData", "Local", "comfy-cli")
    : platform === "darwin" ? join(home, "Library", "Application Support", "comfy-cli")
    : join(home, ".config", "comfy-cli");
  const out = [platform === "linux" ? join(home, "comfy", "ComfyUI") : join(home, "Documents", "comfy", "ComfyUI")];
  try {
    for (const line of readFileSync(join(configDir, "config.ini"), "utf8").split(/\r?\n/)) {
      const m = /^\s*(default_workspace|recent_workspace)\s*=\s*(.+?)\s*$/.exec(line);
      if (m) out.push(m[2]);
    }
  } catch {
    // no comfy-cli
  }
  return out;
}

/** An app's settings folder: %APPDATA%\<name>, ~/Library/Application Support/<name>, ~/.config/<name>. */
function appDataDir(name: string, home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), name);
  if (platform === "darwin") return join(home, "Library", "Application Support", name);
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), name);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Every string under a key named *key*, anywhere in *data*. The newer Comfy Desktop's files are
 * not documented; this reads them without assuming more of their shape than the key. */
function stringsUnder(data: unknown, key: string, out: string[] = []): string[] {
  if (Array.isArray(data)) data.forEach((d) => stringsUnder(d, key, out));
  else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) {
      if (k === key && typeof v === "string") out.push(v);
      else if (k === key && Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === "string"));
      else stringsUnder(v, key, out);
    }
  }
  return out;
}

function scanRoots(home: string, platform: NodeJS.Platform): string[] {
  const roots = [home, join(home, "Desktop"), join(home, "Documents"), join(home, "Downloads")];
  if (platform === "win32") {
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") if (existsSync(`${letter}:\\`)) roots.push(`${letter}:\\`);
  }
  return roots;
}

/** ComfyUI folders under *roots*: children named like "comfy", and grandchildren so named (as in
 * D:\AI\ComfyUI_windows_portable). Bounded by MAX_DIRS_READ. */
function scan(roots: string[]): string[] {
  const found: string[] = [];
  let budget = MAX_DIRS_READ;
  const list = (dir: string): string[] => {
    if (budget-- <= 0) return [];
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP.test(e.name)).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const root of roots) {
    for (const child of list(root)) {
      const path = join(root, child);
      if (/comfy/i.test(child)) {
        const c = comfyAt(path);
        if (c) found.push(c);
        // A folder of installs, as Comfy Desktop's ComfyUI-Installs\<name>\ComfyUI.
        else for (const inner of list(path)) {
          const ci = comfyAt(join(path, inner));
          if (ci) found.push(ci);
        }
        continue;
      }
      for (const grandchild of list(path)) {
        if (!/comfy/i.test(grandchild)) continue;
        const c = comfyAt(join(path, grandchild));
        if (c) found.push(c);
      }
    }
  }
  return found;
}

function yamlSources(yaml: string, from: string): ModelSource[] {
  let text: string;
  try {
    text = readFileSync(yaml, "utf8");
  } catch {
    return [];
  }
  // One source per section, each named: a yaml often has several, and the settings page lists them.
  return parseExtraModelPaths(text, dirname(yaml)).map(({ name, folders }) => ({ from: `${from} [${name}]`, path: yaml, folders }));
}

/** Model folders on this machine besides *own* (our models folder and ComfyUI folder), in the
 * order they are searched. Folders inside ours are left out (another app's yaml may list ours). */
export function discoverModelSources(own: { models: string; comfy: string | null }, extraDir = "", opts: DiscoverOptions = {}): ModelSource[] {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const sources: ModelSource[] = [];
  const models = (dir: string, from: string) => sources.push({ from, path: dir, folders: standardFolders(dir) });

  if (extraDir && isDir(extraDir)) models(extraDir, "your extra models folder");

  const installs = new Map<string, [string, string]>(); // canonical ComfyUI folder -> [folder, from]
  const addInstall = (dir: string | null, from: string) => {
    if (dir && !installs.has(folderKey(dir))) installs.set(folderKey(dir), [dir, from]);
  };
  for (const e of registryEntries(opts.registry ?? registryDir())) {
    const c = comfyAt(e.install);
    if (c) addInstall(c, `${e.app} (registry)`);
    else if (isDir(e.models)) models(e.models, `${e.app} (registry)`);
  }
  for (const ws of comfyCliWorkspaces(home, platform)) addInstall(comfyAt(ws), "comfy-cli");
  // The ComfyUI Desktop app: its base folder and its extra models file.
  const desktop = appDataDir("ComfyUI", home, env, platform);
  for (const basePath of stringsUnder(readJson(join(desktop, "config.json")), "basePath")) {
    if (isDir(join(basePath, "models"))) models(join(basePath, "models"), "ComfyUI Desktop");
  }
  sources.push(...yamlSources(join(desktop, "extra_models_config.yaml"), "ComfyUI Desktop's extra models"));
  // The newer Comfy Desktop app: its installs, its models folders, its shared model paths.
  const comfyDesktop = appDataDir("Comfy Desktop", home, env, platform);
  for (const installPath of stringsUnder(readJson(join(comfyDesktop, "installations.json")), "installPath")) {
    addInstall(comfyAt(installPath), "Comfy Desktop");
  }
  for (const dir of stringsUnder(readJson(join(comfyDesktop, "settings.json")), "modelsDirs")) {
    if (isDir(dir)) models(dir, "Comfy Desktop");
  }
  sources.push(...yamlSources(join(comfyDesktop, "shared_model_paths.yaml"), "Comfy Desktop's shared models"));
  for (const dir of scan(opts.roots ?? scanRoots(home, platform))) addInstall(dir, "found on disk");

  const ownComfy = own.comfy ? folderKey(own.comfy) : null;
  for (const [key, [dir, from]] of installs) {
    if (key === ownComfy) continue;
    const label = `${from}: ${basename(dir) === "ComfyUI" ? basename(dirname(dir)) + "/ComfyUI" : basename(dir)}`;
    models(join(dir, "models"), label);
    sources.push(...yamlSources(join(dir, "extra_model_paths.yaml"), `${label}, its extra_model_paths.yaml`));
  }

  // Ours is searched first anyway; drop it (and anything inside it) from the others. Then each
  // folder once (by its real path), and sources with nothing in them.
  const ownPrefix = folderKey(own.models);
  const sep = platform === "win32" ? "\\" : "/";
  const seen = new Set<string>();
  const keep = (d: string) => {
    const k = folderKey(d);
    if (k === ownPrefix || k.startsWith(ownPrefix + sep) || !hasEntries(d)) return false;
    return true;
  };
  const first = (type: string, d: string) => {
    const k = `${canonType(type)}\n${folderKey(d)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  return sources
    .map((s) => ({
      ...s,
      folders: Object.fromEntries(
        Object.entries(s.folders).map(([t, ds]) => [t, ds.filter((d) => keep(d) && first(t, d))]).filter(([, ds]) => ds.length),
      ) as ModelFolders,
    }))
    .filter((s) => Object.keys(s.folders).length);
}

/** Our models folder and every other source, discovered at most once a minute (the scan reads a
 * few hundred folders; the settings page polls). */
export class ModelLocator {
  private own: () => { models: string; comfy: string | null };
  private extra: () => string;
  private opts: DiscoverOptions;
  private cached: { at: number; key: string; sources: ModelSource[] } | null = null;

  constructor(own: () => { models: string; comfy: string | null }, extra: () => string, opts: DiscoverOptions = {}) {
    this.own = own;
    this.extra = extra;
    this.opts = opts;
  }

  get ownModels(): string {
    return this.own().models;
  }

  /** The other sources, ours excluded. */
  sources(fresh = false): ModelSource[] {
    const own = this.own();
    const key = `${own.models}\n${own.comfy}\n${this.extra()}`;
    if (fresh || !this.cached || this.cached.key !== key || Date.now() - this.cached.at > 60_000) {
      this.cached = { at: Date.now(), key, sources: discoverModelSources(own, this.extra(), this.opts) };
    }
    return this.cached.sources;
  }

  /** Ours first (its subfolders searched even before they exist), then the others. */
  folders(fresh = false): ModelFolders {
    const own = Object.fromEntries(SHARED_SUBFOLDERS.map((s) => [s, [join(this.ownModels, s)]]));
    return mergeFolders([own, ...this.sources(fresh).map((s) => s.folders)]);
  }
}
