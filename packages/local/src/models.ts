// Model folders: ours, the ones other installs publish in ~/.comfy-registry (Visual-Novelist and
// the old extension use the same registry), and the user's extra folder. ComfyUI reads the others
// through extra_model_paths.yaml, so a model is downloaded once and visible everywhere.
//
// The registry format is shared with the other apps; keep it as it is: one JSON file per install,
// {app, install_path, models_dir, sees, updated_at}, named <app>-<sha1(canonical path)[:8]>.json.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";

export const APP_ID = "comfy-gen-mcp";

// ComfyUI's standard model subfolders, shared broadly: donor installs may hold anything useful.
export const SHARED_SUBFOLDERS = [
  "checkpoints", "clip", "clip_vision", "controlnet", "diffusion_models",
  "embeddings", "loras", "text_encoders", "unet", "upscale_models", "vae",
];

export function registryDir(): string {
  return join(homedir(), ".comfy-registry", "installs");
}

/** Canonical form for comparing paths (Python's normcase(normpath(abspath(p)))). */
export function canonPath(path: string): string {
  const p = normalize(resolve(path));
  return process.platform === "win32" ? p.toLowerCase().replace(/\//g, "\\") : p;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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

/** Every other models folder: registry entries, then *extra*. Existing folders only, deduplicated,
 * ours excluded. */
export function sharedModelDirs(ownModelsDir: string, extra = "", root = registryDir()): string[] {
  const own = canonPath(ownModelsDir);
  const found = new Map<string, string>();
  const add = (dir: unknown) => {
    if (typeof dir !== "string" || !dir || !isDir(dir)) return;
    const canon = canonPath(dir);
    if (canon !== own && !found.has(canon)) found.set(canon, dir);
  };
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((n) => n.endsWith(".json")).sort();
  } catch {
    // no registry yet
  }
  const fromRegistry: string[] = [];
  for (const name of names) {
    try {
      fromRegistry.push(JSON.parse(readFileSync(join(root, name), "utf8")).models_dir);
    } catch {
      // another app mid-write, or a broken entry
    }
  }
  fromRegistry.filter((d) => typeof d === "string").sort().forEach(add);
  add(extra);
  return [...found.values()];
}

/** extra_model_paths.yaml in the ComfyUI folder, which ComfyUI reads at start. Rewritten at every
 * launch; removed when there is nothing to share. */
export function writeExtraModelPaths(comfyDir: string, dirs: string[]): void {
  const path = join(comfyDir, "extra_model_paths.yaml");
  if (!dirs.length) {
    rmSync(path, { force: true });
    return;
  }
  const lines: string[] = [];
  dirs.forEach((dir, i) => {
    lines.push(`shared-${i + 1}:`, `    base_path: ${JSON.stringify(dir)}`);
    for (const sub of SHARED_SUBFOLDERS) lines.push(`    ${sub}: ${sub}`);
  });
  writeFileSync(path, lines.join("\n") + "\n");
}

/** Where a model file is, among *dirs* (ours first), or null. */
export function findModel(dirs: string[], subfolder: string, filename: string): string | null {
  for (const d of dirs) {
    const path = join(d, subfolder, filename);
    if (existsSync(path)) return path;
  }
  return null;
}
