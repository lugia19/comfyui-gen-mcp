// uv, pinned, downloaded from its GitHub release into the install's bin folder. It installs Python,
// ComfyUI's dependencies and the right PyTorch build for the GPU (--torch-backend).

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fetchFile } from "./fetchfile.ts";
import type { Paths } from "./paths.ts";
import { run } from "./proc.ts";

export const UV_VERSION = "0.12.20";

const WIN = process.platform === "win32";

/** uv's release target for this machine, or null where it publishes none. */
export function uvTarget(platform = process.platform, arch = process.arch): string | null {
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!cpu) return null;
  if (platform === "win32") return `${cpu}-pc-windows-msvc`;
  if (platform === "darwin") return `${cpu}-apple-darwin`;
  if (platform === "linux") return `${cpu}-unknown-linux-gnu`;
  return null;
}

export function uvPath(p: Paths): string {
  return join(p.bin, WIN ? "uv.exe" : "uv");
}

/** The environment uv runs in: its Python builds and its cache inside the install folder, so the
 * venv's files hardlink from the cache and removing the folder removes everything. */
export function uvEnv(p: Paths): Record<string, string> {
  return {
    UV_PYTHON_INSTALL_DIR: join(p.home, "python"),
    UV_CACHE_DIR: join(p.home, "uv-cache"),
    UV_NO_CONFIG: "1", // a user's uv.toml must not redirect our installs
    UV_PYTHON_PREFERENCE: "only-managed",
  };
}

/** The pinned uv, downloading it the first time. */
export async function ensureUv(p: Paths, onLine: (l: string) => void = () => {}): Promise<string> {
  const exe = uvPath(p);
  if (existsSync(exe)) {
    const { code, output } = await run(exe, ["--version"], { timeoutMs: 15_000 });
    if (code === 0 && output.includes(` ${UV_VERSION} `)) return exe;
  }
  const target = uvTarget();
  if (!target) throw new Error(`uv has no build for ${process.platform} ${process.arch}`);
  const asset = `uv-${target}${WIN ? ".zip" : ".tar.gz"}`;
  const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`;
  onLine(`Downloading uv ${UV_VERSION}`);
  const sums = await fetch(`${base}.sha256`, { headers: { "User-Agent": "comfy-gen-local" } });
  if (!sums.ok) throw new Error(`${base}.sha256: HTTP ${sums.status}`);
  const sha256 = (await sums.text()).trim().split(/\s+/)[0];
  const tmp = join(p.bin, "uv-download");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const archive = join(tmp, asset);
  await fetchFile(base, archive, { sha256 });
  // tar reads both: GNU tar the .tar.gz, Windows' bsdtar (tar.exe, Windows 10 and later) the .zip.
  const { code, output } = await run("tar", ["-xf", archive, "-C", tmp], { timeoutMs: 60_000 });
  if (code !== 0) throw new Error(`Unpacking uv failed: ${output.trim()}`);
  const found = findFile(tmp, WIN ? "uv.exe" : "uv");
  if (!found) throw new Error("The uv download did not contain uv");
  rmSync(exe, { force: true });
  renameSync(found, exe);
  rmSync(tmp, { recursive: true, force: true });
  return exe;
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const inner = findFile(path, name);
      if (inner) return inner;
    } else if (entry === name) {
      return path;
    }
  }
  return null;
}
