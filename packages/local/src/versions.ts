// What ComfyUI and PyTorch a PC runs, and which PyTorch build its GPU can use (design §2, "The
// managed ComfyUI"). An install below these targets upgrades itself once idle (upgrade.ts).
//
// The build is picked here, not by uv's --torch-backend auto, which reads only the NVIDIA driver:
// a GTX 10-series card on a new driver got torch 2.15's CUDA 13 build, which has no kernels for it
// (research, 2026-11-07). PyTorch's NVIDIA builds by compute capability:
//   cu126  5.0-9.0 (Maxwell to Hopper; Ada and Ampere run 8.6's code), last release 2.14.1
//   cu128  7.5-12.0 (Turing to Blackwell), up to 2.11; needs driver 525+ (570+ on Blackwell)
//   cu130  7.5-12.0, from 2.9; needs driver 580+. ComfyUI asks it of RTX 20-series and newer.
// torch 2.15 (2026-10-28) is the first without Maxwell, Pascal or Volta in any build.

import type { Gpu } from "./install.ts";
import { run } from "./proc.ts";

export const COMFYUI_VERSION = "0.37.0"; // as on Modal (app.py MODAL_VERSIONS)
export const TORCH_MIN = "2.9"; // below it, an install's torch is upgraded

/** The lowest compute capability among the PC's NVIDIA cards (one build serves them all) and the
 * driver version, from nvidia-smi. */
export type NvidiaInfo = { computeCap: number; driver: number };
/** uv's --torch-backend, the torch versions to take from it, and a note for the user (an old
 * driver). *blocked*: no build fits until they act (the reason). */
export type Build = { backend: string; spec: string; note: string | null; blocked: string | null };

const NEW_DRIVER = "Updating the NVIDIA driver would let it use a newer PyTorch build.";

/** The torch versions a build may install: within its index, and runnable where it is chosen. */
export function torchSpec(backend: string): string {
  if (backend === "cu126") return `>=${TORCH_MIN},<2.15`; // 2.15 dropped Maxwell to Volta; cu126 ends at 2.14.1
  if (backend === "cu128") return `>=${TORCH_MIN},<2.12`; // the cu128 index ends at 2.11
  return `>=${TORCH_MIN}`;
}

const build = (backend: string, note: string | null = null, blocked: string | null = null): Build => ({ backend, spec: torchSpec(backend), note, blocked });

/** The PyTorch build for a GPU kind on *platform*: for NVIDIA by its compute capability and driver
 * (*nvidia*; null when nvidia-smi didn't say: uv's auto, as before). */
export function chooseBuild(kind: Gpu, nvidia: NvidiaInfo | null, platform: string = process.platform): Build {
  if (kind === "cpu") return build("cpu");
  if (kind === "intel") return build("xpu");
  if (kind === "mac") return build("auto"); // PyPI's macOS wheels are the MPS build
  // AMD: ROCm wheels exist for Linux only. Named "cpu" on Windows rather than auto, which picks the
  // Intel build where the PC also has Intel graphics.
  if (kind === "amd") return build(platform === "win32" ? "cpu" : "auto");
  if (!nvidia) return build("auto");
  const { computeCap: cap, driver } = nvidia;
  if (cap < 5) return build("cpu", "This NVIDIA GPU is too old for PyTorch's CUDA builds: images are made on the CPU, very slowly.");
  // CUDA 12 builds run on 525+ (minor-version compatibility); cu118, for older drivers, ends at 2.7
  if (driver < 525) return build("cu126", null, `PyTorch needs NVIDIA driver 525 or newer (this PC has ${driver}). Update the driver, then try again.`);
  if (cap >= 12 && driver < 570) {
    return build("cu128", null, `This GPU needs NVIDIA driver 570 or newer (this PC has ${driver}). Update the driver, then try again.`);
  }
  if (cap < 7.5) return build("cu126");
  if (driver >= 580) return build("cu130");
  if (driver >= 570) return build("cu128", NEW_DRIVER);
  return build("cu126", NEW_DRIVER);
}

/** "2.14.1+cu130" as [2, 14, 1] and its build ("cu130"; "" without one). */
export function parseTorch(version: string): { release: number[]; local: string } {
  const [release, local = ""] = version.trim().split("+");
  return { release: release.split(".").map((n) => parseInt(n, 10) || 0), local };
}

/** -1, 0 or 1 as version *a* is below, equal to or above *b* ("2.9" is 2.9.0). */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseTorch(a).release, parseTorch(b).release];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Whether installed torch *version* (with its build tag, "2.14.1+cu130") can run on this PC's
 * NVIDIA cards. Other GPUs, or no tag or info to go by: assumed yes. */
export function canRun(version: string, nvidia: NvidiaInfo | null): boolean {
  if (!nvidia) return true;
  const { local } = parseTorch(version);
  const cuda = /^cu(\d+)$/.exec(local);
  if (!cuda) return true;
  const cu = Number(cuda[1]);
  const { computeCap: cap, driver } = nvidia;
  if (cap < 5) return false; // no CUDA build has it
  if (cap < 7.5 && (cu >= 128 || compareVersions(version, "2.15") >= 0)) return false; // Maxwell to Volta's code is gone
  if (cap >= 12 && (cu < 128 || driver < 570)) return false; // Blackwell needs CUDA 12.8+
  if (cu >= 130 && driver < 580) return false;
  if (cu >= 120 && driver < 525) return false;
  return true;
}

let probed: Promise<NvidiaInfo | null> | null = null;

/** probeNvidia, once per process (cards and drivers don't change under a running agent). */
export function nvidiaInfo(): Promise<NvidiaInfo | null> {
  probed ??= probeNvidia().catch(() => null);
  return probed;
}

/** The lowest compute capability and the driver, from nvidia-smi; null without one that answers
 * (its compute_cap field came with driver 510). */
export async function probeNvidia(): Promise<NvidiaInfo | null> {
  const { code, output } = await run("nvidia-smi", ["--query-gpu=compute_cap,driver_version", "--format=csv,noheader"], { timeoutMs: 15_000 });
  if (code !== 0) return null;
  return parseNvidiaSmi(output);
}

export function parseNvidiaSmi(output: string): NvidiaInfo | null {
  const rows = output.split(/\r?\n/).map((l) => l.split(",").map((s) => s.trim())).filter((r) => r.length >= 2 && /^\d+(\.\d+)?$/.test(r[0]));
  if (!rows.length) return null;
  const computeCap = Math.min(...rows.map((r) => Number(r[0])));
  const driver = parseInt(rows[0][1], 10);
  return Number.isFinite(driver) ? { computeCap, driver } : null;
}
