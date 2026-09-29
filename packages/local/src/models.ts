// Model folders. Models are big, so every model already on the machine should be used where it is:
// ours (the managed ComfyUI's models/), other ComfyUI installs (found by discover.ts, with the extra
// folders their own extra_model_paths.yaml names), the ones other apps publish in ~/.comfy-registry
// (Visual-Novelist and the old extension use the same registry), and the user's extra folder.
// ComfyUI reads the others through our extra_model_paths.yaml; downloads go into ours.
//
// The registry format is shared with the other apps; keep it as it is: one JSON file per install,
// {app, install_path, models_dir, sees, updated_at}, named <app>-<sha1(canonical path)[:8]>.json.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

export const APP_ID = "comfy-gen-mcp";

// ComfyUI's standard model subfolders, shared broadly: other installs may hold anything useful.
export const SHARED_SUBFOLDERS = [
  "checkpoints", "clip", "clip_vision", "controlnet", "diffusion_models",
  "embeddings", "loras", "text_encoders", "unet", "upscale_models", "vae",
];
// Folder types ComfyUI searches together (its legacy names).
const ALIASES: Record<string, string[]> = {
  diffusion_models: ["unet"], unet: ["diffusion_models"], text_encoders: ["clip"], clip: ["text_encoders"],
};
const NOT_MODELS = new Set(["base_path", "is_default", "custom_nodes", "download_model_base"]);

/** Folder type ("loras") -> folders, in search order. */
export type ModelFolders = Record<string, string[]>;
/** Where some model folders come from, for the settings page. */
export type ModelSource = { from: string; path: string; folders: ModelFolders };

export function registryDir(): string {
  return join(homedir(), ".comfy-registry", "installs");
}

/** Canonical form for comparing paths (Python's normcase(normpath(abspath(p)))). */
export function canonPath(path: string): string {
  const p = normalize(resolve(path));
  return process.platform === "win32" ? p.toLowerCase().replace(/\//g, "\\") : p;
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A models folder in ComfyUI's standard layout: its subfolders that exist. */
export function standardFolders(modelsDir: string): ModelFolders {
  const out: ModelFolders = {};
  for (const sub of SHARED_SUBFOLDERS) if (isDir(join(modelsDir, sub))) out[sub] = [join(modelsDir, sub)];
  return out;
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
const expandHome = (s: string) => (s === "~" || s.startsWith("~/") || s.startsWith("~\\") ? join(homedir(), s.slice(1)) : s);

/** The sections of an extra_model_paths.yaml (ComfyUI's format), resolved as ComfyUI does: a
 * relative base_path is relative to the file, and each path to base_path. Folders that don't
 * exist are left out. A small parser for that one format, not general YAML. */
export function parseExtraModelPaths(text: string, yamlDir: string): ModelFolders[] {
  const sections: { base: string; entries: [string, string[]][] }[] = [];
  let current: (typeof sections)[number] | null = null;
  let block: { indent: number; list: string[] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "    ");
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (block) {
      if (trimmed && indent > block.indent) {
        if (!trimmed.startsWith("#")) block.list.push(unquote(trimmed));
        continue;
      }
      if (!trimmed) continue;
      block = null;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^([^:#]+):\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const [, key, rest] = m;
    if (indent === 0) {
      current = { base: "", entries: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const value = rest.replace(/\s+#.*$/, "");
    if (key.trim() === "base_path") {
      current.base = unquote(value);
    } else if (/^[|>][-+]?$/.test(value)) {
      const list: string[] = [];
      current.entries.push([key.trim(), list]);
      block = { indent, list };
    } else if (value) {
      current.entries.push([key.trim(), [unquote(value)]]);
    }
  }
  return sections.map(({ base, entries }) => {
    let b = base ? expandHome(base) : "";
    if (b && !isAbsolute(b)) b = join(yamlDir, b);
    const out: ModelFolders = {};
    for (const [key, paths] of entries) {
      if (NOT_MODELS.has(key)) continue;
      for (const p of paths) {
        const full = normalize(b ? join(b, expandHome(p)) : expandHome(p));
        if (isDir(full)) (out[key] ??= []).push(full);
      }
    }
    return out;
  });
}

/** All sources' folders in one map, first source first, each folder once. */
export function mergeFolders(sources: ModelFolders[]): ModelFolders {
  const out: ModelFolders = {};
  const seen = new Set<string>();
  for (const src of sources) {
    for (const [type, dirs] of Object.entries(src)) {
      for (const d of dirs) {
        const key = `${type}\n${canonPath(d)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        (out[type] ??= []).push(d);
      }
    }
  }
  return out;
}

/** Where a model file is, or null. Searches the type and ComfyUI's aliases of it. */
export function findModel(folders: ModelFolders, subfolder: string, filename: string): string | null {
  for (const type of [subfolder, ...(ALIASES[subfolder] ?? [])]) {
    for (const d of folders[type] ?? []) {
      const path = join(d, filename);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** extra_model_paths.yaml in the ComfyUI folder, which ComfyUI reads at start: one section per
 * source, with absolute paths. Rewritten at every launch; removed when there is nothing to share. */
export function writeExtraModelPaths(comfyDir: string, sources: ModelFolders[]): void {
  const path = join(comfyDir, "extra_model_paths.yaml");
  const lines: string[] = [];
  sources.filter((s) => Object.keys(s).length).forEach((src, i) => {
    lines.push(`shared-${i + 1}:`);
    for (const [type, dirs] of Object.entries(src)) {
      lines.push(`    ${type}: |`, ...dirs.map((d) => `        ${d}`));
    }
  });
  if (!lines.length) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, "# Written by Comfy-Gen-MCP at every start; edits are lost.\n" + lines.join("\n") + "\n");
}

/** Announce our install. Keyed by install path, so two installs of one app don't collide. */
export function publish(installPath: string, modelsDir: string, sees: string[], root = registryDir()): void {
  mkdirSync(root, { recursive: true });
  const digest = createHash("sha1").update(canonPath(installPath), "utf8").digest("hex").slice(0, 8);
  const entry = {
    app: APP_ID,
    install_path: installPath,
    models_dir: modelsDir,
    sees,
    updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
  };
  writeFileSync(join(root, `${APP_ID}-${digest}.json`), JSON.stringify(entry, null, 2));
}

/** The registry's entries: [app, install path, models folder], readable ones only. */
export function registryEntries(root = registryDir()): { app: string; install: string; models: string }[] {
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const e = JSON.parse(readFileSync(join(root, name), "utf8"));
      if (typeof e.models_dir === "string") out.push({ app: String(e.app ?? name), install: String(e.install_path ?? dirname(e.models_dir)), models: e.models_dir });
    } catch {
      // another app mid-write, or a broken entry
    }
  }
  return out;
}
