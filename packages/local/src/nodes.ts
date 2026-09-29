// Custom nodes: the packs' node packages from the Comfy Registry, and our /comfy-gen/wait extension.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchFile, USER_AGENT } from "./fetchfile.ts";
import type { Install } from "./install.ts";
import { log } from "./log.ts";
import type { Paths } from "./paths.ts";
import { pythonEnv, run } from "./proc.ts";
import { ensureUv, uvEnv } from "./uv.ts";

const REGISTRY = "https://api.comfy.org";
export const WAIT_EXTENSION_DIR = "comfy-gen";

/** Write our /comfy-gen/wait extension (packages/modal_app/.../comfy_node) into custom_nodes, so
 * waits are held there as on Modal. Written at every launch: a new release may change it. */
export function writeWaitExtension(inst: Install, source: string): void {
  const dir = join(inst.dir, "custom_nodes", WAIT_EXTENSION_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "__init__.py"), source);
}

/** Folder names in custom_nodes, lowercased (a node package installed by the old extension's
 * ComfyUI-Manager may differ in case from the registry id). */
export function installedNodePackages(inst: Install): Set<string> {
  const dir = join(inst.dir, "custom_nodes");
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).map((n) => n.toLowerCase()));
}

/** Install a node package from the Comfy Registry by id (a pack's required_nodes value), with its
 * Python dependencies. ComfyUI must be restarted to load it. */
export async function installNodePackage(p: Paths, inst: Install, id: string, onLine: (l: string) => void = () => {}): Promise<void> {
  const resp = await fetch(`${REGISTRY}/nodes/${encodeURIComponent(id)}/install`, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) throw new Error(`The Comfy Registry has no node package ${id} (HTTP ${resp.status})`);
  const info = (await resp.json()) as { downloadUrl?: string; version?: string; dependencies?: string[] };
  if (!info.downloadUrl) throw new Error(`The Comfy Registry gave no download for ${id}`);
  onLine(`Installing ${id} ${info.version ?? ""}`.trim());

  const nodes = join(inst.dir, "custom_nodes");
  const tmp = join(nodes, `.${id}.download`);
  rmSync(tmp, { recursive: true, force: true });
  const zip = `${tmp}.zip`;
  await fetchFile(info.downloadUrl, zip);
  // Python unpacks zips everywhere; GNU tar (Linux) does not.
  const unzip = await run(inst.python, ["-m", "zipfile", "-e", zip, tmp], { env: pythonEnv(), timeoutMs: 120_000 });
  rmSync(zip, { force: true });
  if (unzip.code !== 0) throw new Error(`Unpacking ${id} failed: ${unzip.output.trim()}`);
  const dest = join(nodes, id);
  rmSync(dest, { recursive: true, force: true });
  renameSync(tmp, dest);

  const deps = info.dependencies?.length ? info.dependencies : null;
  const requirements = join(dest, "requirements.txt");
  if (deps || existsSync(requirements)) {
    const uv = await ensureUv(p, onLine);
    const args = ["pip", "install", "--python", inst.python, ...(deps ?? ["-r", requirements])];
    const { code, output } = await run(uv, args, { env: pythonEnv(uvEnv(p)), onLine, timeoutMs: 1_800_000 });
    if (code !== 0) throw new Error(`Installing ${id}'s dependencies failed: ${output.trim().split("\n").slice(-5).join("\n")}`);
  }
  log.info(`Installed node package ${id}`);
}
