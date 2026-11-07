// Installing ComfyUI: the pinned release's source, a venv made by uv, and PyTorch for the GPU.
// No comfy-cli and no git: comfy-cli's install broke on Windows paths and code pages in the old
// extension, and needed git. The PyTorch build is picked per card (versions.ts chooseBuild), and
// every later install into the venv keeps it (holdTorch): an unpinned dependency once could have
// swapped it for PyPI's, CPU-only on Windows. Only our own installs count (they carry a marker
// file); anything else in the folder is replaced by an install, which keeps its models, outputs
// and inputs.

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchFile } from "./fetchfile.ts";
import { log } from "./log.ts";
import { venvBin, type Paths } from "./paths.ts";
import { pythonEnv, run, untar } from "./proc.ts";
import { ensureUv, uvEnv } from "./uv.ts";
import { chooseBuild, COMFYUI_VERSION, nvidiaInfo } from "./versions.ts";

export const PYTHON_VERSION = "3.12";
export const GPUS = ["nvidia", "amd", "intel", "mac", "cpu"] as const;
export type Gpu = (typeof GPUS)[number];

const WIN = process.platform === "win32";
const MARKER = ".comfy-gen.json"; // written by our installs: {version, gpu, python, torch: {backend, version}}
const CONSTRAINTS = ".comfy-gen-constraints.txt"; // torch at its installed version, for every later install
// Folders that hold the user's files, kept across a reinstall and an upgrade.
export const KEEP = ["models", "output", "input", "user"];
// Our extension's Python packages, by module: the watermark removal's detector, and the runtime for
// redraw's face detector. The nodes import them when first used, so a ComfyUI without them starts
// (removal then passes images through unchanged; redraw needs them only to find a face). As on Modal.
export const EXTENSION_PACKAGES: Record<string, string> = { ultralytics: "ultralytics==8.4.177", onnxruntime: "onnxruntime==1.30.0" };

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

/** uv's --torch-backend for a GPU kind when nothing more is known (no nvidia-smi answer, no torch
 * to read): chooseBuild's, by kind and OS. */
export function torchBackend(gpu: Gpu): string {
  return chooseBuild(gpu, null).backend;
}

/** An install's PyTorch: uv's --torch-backend it came from, and its version with the build tag
 * ("2.14.1+cu130"). */
export type TorchBuild = { backend: string; version: string };
export type Install = { dir: string; python: string; gpu: Gpu | null; version: string | null; torch: TorchBuild | null };

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
  const t = marker.torch as Partial<TorchBuild> | null | undefined;
  const torch = t && typeof t.backend === "string" && typeof t.version === "string" ? { backend: t.backend, version: t.version } : null;
  return { dir, python: marker.python, gpu: isGpu(marker.gpu) ? marker.gpu : null, version: marker.version ?? null, torch };
}

/** Record *inst* in its folder's marker: from then on it counts as installed (findInstall). */
export function writeMarker(inst: Install): void {
  const { version, gpu, python, torch } = inst;
  writeFileSync(join(inst.dir, MARKER), JSON.stringify({ version, gpu, python, torch }, null, 2));
}

/** The uv --torch-backend a torch version came from, by its build tag ("+cu130"); "auto" without one
 * (macOS and Linux PyPI wheels carry none). */
export function backendOf(version: string): string {
  const local = version.split("+")[1] ?? "";
  return /^(cu\d+|rocm[\d.]+|xpu|cpu)$/.test(local) ? local : "auto";
}

/** The torch a venv's *python* has, or null when it has none that imports. */
export async function readTorch(python: string): Promise<TorchBuild | null> {
  const { code, output } = await run(python, ["-c", "import torch; print(torch.__version__)"], { env: pythonEnv(), timeoutMs: 180_000 });
  const version = output.trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (code !== 0 || !/^\d+\.\d+/.test(version)) return null;
  return { backend: backendOf(version), version };
}

/** *inst*'s torch: from its marker, or read once from its Python and written there (an install from
 * before the marker had it). */
export async function installedTorch(inst: Install): Promise<TorchBuild | null> {
  if (inst.torch) return inst.torch;
  const torch = await readTorch(inst.python);
  if (torch) {
    inst.torch = torch;
    writeMarker(inst);
    log.info(`Recorded the install's PyTorch: ${torch.version} (${torch.backend})`);
  }
  return torch;
}

/** uv pip install's arguments that keep *torch* as it is in the install at *dir*: its build's index,
 * and torch held at its version (a constraints file there). */
export function torchArgs(dir: string, torch: TorchBuild): string[] {
  const file = join(dir, CONSTRAINTS);
  writeFileSync(file, `torch==${torch.version}\n`);
  return ["--torch-backend", torch.backend, "--constraint", file];
}

/** torchArgs for *inst*; without a torch it can read, its GPU kind's build as before. */
export async function holdTorch(inst: Install): Promise<string[]> {
  const torch = await installedTorch(inst);
  if (torch) return torchArgs(inst.dir, torch);
  return inst.gpu ? ["--torch-backend", torchBackend(inst.gpu)] : [];
}

/** Install (or reinstall) ComfyUI for *gpu*. The models, outputs, inputs and user settings of an
 * existing install are kept. The caller stops ComfyUI first. */
export async function install(p: Paths, gpu: Gpu, onLine: (l: string) => void = () => {}): Promise<Install> {
  const nvidia = gpu === "nvidia" ? await nvidiaInfo() : null;
  const build = chooseBuild(gpu, nvidia);
  if (build.blocked) throw new Error(build.blocked);
  if (build.note) onLine(build.note);
  const uvRun = await uvSteps(p, p.comfyui, onLine);
  const ws = p.comfyui;
  if (comfyDir(ws)) onLine("Keeping models and outputs, removing the old ComfyUI");
  await clearWorkspace(ws);
  await fetchComfyUI(ws, COMFYUI_VERSION, onLine);

  const venv = join(ws, ".venv");
  const python = venvBin(venv, "python");
  await uvRun(`Creating a Python ${PYTHON_VERSION} environment`, ["venv", "--python", PYTHON_VERSION, "--seed", venv]);
  await uvRun(`Installing PyTorch (${gpu}, ${build.backend})`,
    ["pip", "install", "--python", python, "--torch-backend", build.backend, `torch${build.spec}`, "torchvision", "torchaudio"]);
  const torch = await readTorch(python);
  if (!torch) throw new Error("PyTorch was installed but doesn't import");
  const hold = torchArgs(ws, torch);
  await uvRun("Installing ComfyUI's requirements", ["pip", "install", "--python", python, ...hold, "-r", join(ws, "requirements.txt")]);
  await uvRun("Installing the extension's packages", ["pip", "install", "--python", python, ...hold, ...Object.values(EXTENSION_PACKAGES)]);

  const done: Install = { dir: ws, python, gpu, version: COMFYUI_VERSION, torch };
  writeMarker(done);
  onLine(`ComfyUI is installed (PyTorch ${torch.version})`);
  return done;
}

/** Download ComfyUI *version*'s source and unpack it into *dir*. */
export async function fetchComfyUI(dir: string, version: string, onLine: (l: string) => void): Promise<void> {
  onLine(`Downloading ComfyUI ${version}`);
  const tarball = join(dir, `ComfyUI-${version}.tar.gz`); // unpacked where it is, then gone
  await fetchFile(`https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v${version}.tar.gz`, tarball);
  try {
    await untar(tarball, ["--strip-components=1"], 300_000);
  } finally {
    rmSync(tarball, { force: true });
  }
}

/** A runner of uv steps in *cwd*: each says what it does, and a failed one throws with uv's last
 * lines. */
export async function uvSteps(p: Paths, cwd: string, onLine: (l: string) => void): Promise<(what: string, args: string[]) => Promise<void>> {
  const uv = await ensureUv(p, onLine);
  const env = pythonEnv(uvEnv(p));
  return async (what, args) => {
    onLine(what);
    const { code, output } = await run(uv, args, { cwd, env, onLine, timeoutMs: 3_600_000 });
    if (code !== 0) throw new Error(`${what} failed: ${output.trim().split("\n").slice(-5).join("\n")}`);
  };
}

let extending: Promise<void> | null = null;

/** Add the extension packages an install lacks (one from before they were needed), once at a time.
 * Never throws: without them, images go out uncleaned. ComfyUI need not restart (see above). */
export function ensureExtensionPackages(p: Paths, inst: Install): Promise<void> {
  extending ??= addExtensionPackages(p, inst)
    .catch((e) => log.warn(`Installing the extension's packages failed: ${(e as Error).message}`))
    .finally(() => (extending = null));
  return extending;
}

async function addExtensionPackages(p: Paths, inst: Install): Promise<void> {
  const missing: string[] = [];
  for (const [module, spec] of Object.entries(EXTENSION_PACKAGES)) {
    const probe = `import importlib.util, sys; sys.exit(importlib.util.find_spec(${JSON.stringify(module)}) is None)`;
    if ((await run(inst.python, ["-c", probe], { env: pythonEnv(), timeoutMs: 60_000 })).code !== 0) missing.push(spec);
  }
  if (!missing.length) return;
  log.info(`Installing the extension's packages (${missing.join(", ")})`);
  const uv = await ensureUv(p);
  const { code, output } = await run(uv, ["pip", "install", "--python", inst.python, ...(await holdTorch(inst)), ...missing], { env: pythonEnv(uvEnv(p)), timeoutMs: 1_800_000 });
  if (code !== 0) throw new Error(output.trim().split("\n").slice(-5).join("\n"));
  log.info("Installed the extension's packages");
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

/** Move *from* to *to* (a rename: the same disk), retrying as removeDir does. */
export async function moveDir(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= 4) throw new Error(`Could not move ${from} to ${to}: ${(e as Error).message}`);
      if (WIN) await killProcessesUnder(from);
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
