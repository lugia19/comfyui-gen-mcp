// Installing ComfyUI: the pinned release's source, a venv made by uv, and PyTorch for the GPU.
// No comfy-cli and no git: comfy-cli's install broke on Windows paths and code pages in the old
// extension, and needed git; uv picks the PyTorch build for the GPU itself (--torch-backend auto).
// Only our own installs count (they carry a marker file); anything else in the folder is replaced by
// an install, which keeps its models, outputs and inputs.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchFile } from "./fetchfile.ts";
import { log } from "./log.ts";
import { venvBin, type Paths } from "./paths.ts";
import { pythonEnv, run } from "./proc.ts";
import { ensureUv, uvEnv } from "./uv.ts";

export const COMFYUI_VERSION = "0.37.0"; // as on Modal
export const PYTHON_VERSION = "3.12";
export const GPUS = ["nvidia", "amd", "intel", "mac", "cpu"] as const;
export type Gpu = (typeof GPUS)[number];

const WIN = process.platform === "win32";
const MARKER = ".comfy-gen.json"; // written by our installs: {version, gpu, python}
// Folders that hold the user's files, kept across a reinstall.
const KEEP = ["models", "output", "input", "user"];

export function isGpu(v: unknown): v is Gpu {
  return typeof v === "string" && (GPUS as readonly string[]).includes(v);
}

/** The GPU kind, best guess; the user can change it before installing. */
export async function detectGpu(): Promise<Gpu> {
  if (process.platform === "darwin") return "mac";
  if ((await run("nvidia-smi", [], { timeoutMs: 10_000 })).code !== null) return "nvidia"; // it exists
  if ((await run("rocminfo", [], { timeoutMs: 10_000 })).code === 0) return "amd";
  if (WIN) {
    const { output } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }"], { timeoutMs: 15_000 });
    if (/nvidia/i.test(output)) return "nvidia";
    if (/\b(amd|radeon)\b/i.test(output)) return "amd";
    if (/\bintel\b.*\barc\b/i.test(output)) return "intel";
  }
  return "cpu";
}

/** uv's --torch-backend for a GPU kind. "auto" reads the NVIDIA driver version (every OS) or the
 * AMD GPU architecture (Linux); Intel is only detected on Linux, so it is named. AMD on Windows gets
 * CPU wheels, as it did with comfy-cli in practice. */
export function torchBackend(gpu: Gpu): string {
  return gpu === "cpu" ? "cpu" : gpu === "intel" ? "xpu" : "auto";
}

export type Install = { dir: string; python: string; gpu: Gpu | null; version: string | null };

/** The ComfyUI folder in a workspace: the workspace itself, or ComfyUI/ inside it (some comfy-cli
 * versions nest it). */
export function comfyDir(workspace: string): string | null {
  for (const d of [workspace, join(workspace, "ComfyUI")]) {
    if (existsSync(join(d, "main.py")) && existsSync(join(d, "models"))) return d;
  }
  return null;
}

function readMarker(dir: string): Partial<Install> | null {
  try {
    return JSON.parse(readFileSync(join(dir, MARKER), "utf8"));
  } catch {
    return null;
  }
}

/** The installed ComfyUI and its Python, or null if there is none of ours. */
export async function findInstall(p: Paths): Promise<Install | null> {
  const dir = comfyDir(p.comfyui);
  const marker = dir ? readMarker(dir) : null;
  if (!dir || !marker?.python || !existsSync(marker.python)) return null;
  return { dir, python: marker.python, gpu: isGpu(marker.gpu) ? marker.gpu : null, version: marker.version ?? null };
}

/** Install (or reinstall) ComfyUI for *gpu*. The models, outputs, inputs and user settings of an
 * existing install are kept. The caller stops ComfyUI first. */
export async function install(p: Paths, gpu: Gpu, onLine: (l: string) => void = () => {}): Promise<Install> {
  const uv = await ensureUv(p, onLine);
  const env = pythonEnv(uvEnv(p));
  const ws = p.comfyui;
  if (comfyDir(ws)) onLine("Keeping models and outputs, removing the old ComfyUI");
  await clearWorkspace(ws);

  onLine(`Downloading ComfyUI ${COMFYUI_VERSION}`);
  const tarball = join(p.home, `ComfyUI-${COMFYUI_VERSION}.tar.gz`);
  await fetchFile(`https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v${COMFYUI_VERSION}.tar.gz`, tarball);
  mkdirSync(ws, { recursive: true });
  const untar = await run("tar", ["-xzf", tarball, "-C", ws, "--strip-components=1"], { timeoutMs: 300_000 });
  rmSync(tarball, { force: true });
  if (untar.code !== 0) throw new Error(`Unpacking ComfyUI failed: ${untar.output.trim()}`);

  await restoreKept(ws, join(p.home, "reinstall-kept"), onLine);

  const uvRun = async (what: string, args: string[]) => {
    onLine(what);
    const { code, output } = await run(uv, args, { cwd: ws, env, onLine, timeoutMs: 3_600_000 });
    if (code !== 0) throw new Error(`${what} failed: ${output.trim().split("\n").slice(-5).join("\n")}`);
  };
  const venv = join(ws, ".venv");
  const python = venvBin(venv, "python");
  const backend = ["--torch-backend", torchBackend(gpu)];
  await uvRun(`Creating a Python ${PYTHON_VERSION} environment`, ["venv", "--python", PYTHON_VERSION, "--seed", venv]);
  await uvRun(`Installing PyTorch (${gpu})`, ["pip", "install", "--python", python, ...backend, "torch", "torchvision", "torchaudio"]);
  await uvRun("Installing ComfyUI's requirements", ["pip", "install", "--python", python, ...backend, "-r", join(ws, "requirements.txt")]);

  const done: Install = { dir: ws, python, gpu, version: COMFYUI_VERSION };
  writeFileSync(join(ws, MARKER), JSON.stringify({ version: COMFYUI_VERSION, gpu, python }, null, 2));
  onLine("ComfyUI is installed");
  return done;
}

/**
 * Empty the workspace for a new ComfyUI, leaving the kept folders (KEEP) where they are. They were
 * moved aside and back, and on Windows moving `models` failed while anything had a file in it open
 * (EPERM: a download, an Explorer window, the other program's ComfyUI; a user's reinstall,
 * 2026-10-02). In the old extension's layout, ComfyUI one folder down, they are moved up first.
 */
export async function clearWorkspace(ws: string): Promise<void> {
  const old = comfyDir(ws);
  if (old && old !== ws) {
    for (const name of KEEP) {
      if (existsSync(join(old, name)) && !existsSync(join(ws, name))) await moveDir(join(old, name), join(ws, name));
    }
  }
  if (!existsSync(ws)) return;
  for (const entry of readdirSync(ws)) if (!KEEP.includes(entry)) await removeDir(join(ws, entry));
}

/** A reinstall from before 1.6.5 that failed midway left the kept folders in *kept*: put each
 * back, unless the workspace's own already holds files (then both stay, and the user is told). */
export async function restoreKept(ws: string, kept: string, onLine: (l: string) => void = () => {}): Promise<void> {
  if (!existsSync(kept)) return;
  for (const name of KEEP) {
    const from = join(kept, name);
    const to = join(ws, name);
    if (!existsSync(from)) continue;
    if (holdsFiles(to)) {
      onLine(`Left ${from} from an earlier reinstall as it is: ${to} has files of its own`);
      continue;
    }
    await removeDir(to);
    await moveDir(from, to);
  }
  if (readdirSync(kept).length === 0) rmSync(kept, { recursive: true, force: true });
}

/** Whether *dir* holds a file with something in it (ComfyUI's placeholders are empty). */
function holdsFiles(dir: string, budget = { dirs: 2000 }): boolean {
  if (budget.dirs-- <= 0) return true; // too big to look through: assume so
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory() ? holdsFiles(path, budget) : statSafe(path) > 0) return true;
  }
  return false;
}

const statSafe = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/** Rename a folder, retrying for a while: on Windows it fails while a file in it is open. */
async function moveDir(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= 4) {
        throw new Error(`Could not move ${from} to ${to}: ${(e as Error).message}. Close whatever has it open (an Explorer window, another ComfyUI), then try again.`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** Remove a folder, retrying: on Windows a process that just exited can hold files for a moment,
 * and a leftover ComfyUI started from it is killed first. */
export async function removeDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch (e) {
      if (attempt >= 4) throw new Error(`Could not remove ${dir}: ${(e as Error).message}`);
      if (WIN) await killProcessesUnder(dir);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** Windows: kill every process whose executable or command line is under *dir* (a ComfyUI we lost
 * track of holds its .pyd files open, and the folder cannot be removed). */
async function killProcessesUnder(dir: string): Promise<void> {
  const ps = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)|$($_.CommandLine)\" }";
  const { output } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeoutMs: 20_000 });
  const needle = dir.toLowerCase();
  for (const line of output.split(/\r?\n/)) {
    const [pid, ...rest] = line.split("|");
    if (/^\d+$/.test(pid.trim()) && Number(pid) !== process.pid && rest.join("|").toLowerCase().includes(needle)) {
      log.info(`Killing process ${pid.trim()}, which runs from ${dir}`);
      await run("taskkill", ["/PID", pid.trim(), "/T", "/F"], { timeoutMs: 10_000 });
    }
  }
}
