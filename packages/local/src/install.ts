// Installing ComfyUI: the pinned release's source, a venv made by uv, and PyTorch for the GPU.
// No comfy-cli and no git: comfy-cli's install broke on Windows paths and code pages in the old
// extension, and needed git; uv picks the PyTorch build for the GPU itself (--torch-backend auto).
// Only our own installs count (they carry a marker file); anything else in the folder is replaced by
// an install, which keeps its models, outputs and inputs.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The workspace, if it holds a ComfyUI. */
export function comfyDir(workspace: string): string | null {
  return existsSync(join(workspace, "main.py")) && existsSync(join(workspace, "models")) ? workspace : null;
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
 * 2026-10-02).
 */
export async function clearWorkspace(ws: string): Promise<void> {
  if (!existsSync(ws)) return;
  for (const entry of readdirSync(ws)) if (!KEEP.includes(entry)) await removeDir(join(ws, entry));
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
