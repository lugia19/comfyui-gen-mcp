// Upgrading an install in place, once idle (design §2, "The managed ComfyUI"): ComfyUI below
// COMFYUI_VERSION, or a PyTorch below TORCH_MIN or that can't run on this PC's cards.
//
// Built beside it, in <comfyui>.next, while the old one keeps serving: the new source, a new venv
// (relocatable: it is moved in afterwards; an unchanged torch comes from uv's cache), the node
// packages fresh from the registry. Checked with ComfyUI stopped: torch sees the GPU and multiplies
// on it, and ComfyUI's own --quick-test-for-ci passes with our nodes loaded. Then swapped: the old
// code (everything but KEEP) goes to <comfyui>.prev, the new one in, the marker last. The old one is
// kept until the new one has launched, and comes back if it doesn't. Machine runs the stages.

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { backendOf, EXTENSION_PACKAGES, fetchComfyUI, KEEP, moveDir, PYTHON_VERSION, readTorch, removeDir, torchArgs, uvSteps, writeMarker, type Install } from "./install.ts";
import { log } from "./log.ts";
import { installNodePackage, WAIT_EXTENSION_DIR, writeWaitExtension, type ExtensionFiles } from "./nodes.ts";
import { venvBin, type Paths } from "./paths.ts";
import { pythonEnv, run } from "./proc.ts";
import { canRun, compareVersions, COMFYUI_VERSION, TORCH_MIN, type Build, type NvidiaInfo } from "./versions.ts";

/** What an upgrade changes: ComfyUI's version (null: kept), and the PyTorch build to install (null:
 * the installed one, kept). */
export type UpgradeNeed = { comfyui: string | null; torch: Build | null };

export type UpgradeState = {
  state: "idle" | "building" | "checking" | "swapping" | "starting" | "done" | "failed";
  from: string | null;
  to: string | null;
  lines: string[];
  error: string | null;
  at: number | null; // when it last finished or failed
};

/** What *inst* needs to reach the targets on this PC (*build*: chooseBuild's for it), or null. A
 * working torch is never moved sideways: only one below the minimum or that can't run here. */
export function needsUpgrade(inst: Install, build: Build, nvidia: NvidiaInfo | null): UpgradeNeed | null {
  const comfyui = !inst.version || compareVersions(inst.version, COMFYUI_VERSION) < 0 ? COMFYUI_VERSION : null;
  const torchBad = !inst.torch || compareVersions(inst.torch.version, TORCH_MIN) < 0 || !canRun(inst.torch.version, nvidia);
  const torch = torchBad && !build.blocked ? build : null;
  return comfyui || torch ? { comfyui, torch } : null;
}

/** "ComfyUI 0.44.2, PyTorch cu130": what an upgrade goes to, for the page and its failure hold. */
export function describeTarget(inst: Install, need: UpgradeNeed): string {
  const torch = need.torch ? `PyTorch ${need.torch.backend === "auto" ? "(new)" : need.torch.backend}` : `PyTorch ${inst.torch?.version ?? "?"}`;
  return `ComfyUI ${need.comfyui ?? inst.version ?? "?"}, ${torch}`;
}

export const nextDir = (p: Paths) => `${p.comfyui}.next`;
export const prevDir = (p: Paths) => `${p.comfyui}.prev`;

/** Stage 1: the new ComfyUI in <comfyui>.next, beside *inst*. Returns it as an Install there. */
export async function buildNext(
  p: Paths, inst: Install, need: UpgradeNeed, files: ExtensionFiles, onLine: (l: string) => void, fetchSource = fetchComfyUI,
): Promise<Install> {
  const dir = nextDir(p);
  await removeDir(dir);
  mkdirSync(dir, { recursive: true });
  const uvRun = await uvSteps(p, dir, onLine);
  await fetchSource(dir, need.comfyui ?? inst.version ?? COMFYUI_VERSION, onLine);

  const python = venvBin(join(dir, ".venv"), "python");
  await uvRun(`Creating a Python ${PYTHON_VERSION} environment`, ["venv", "--relocatable", "--python", PYTHON_VERSION, "--seed", join(dir, ".venv")]);
  // The same torch from uv's cache when it stays; else the new build's newest in range
  const torchSpec = need.torch
    ? ["--torch-backend", need.torch.backend, `torch${need.torch.spec}`]
    : ["--torch-backend", inst.torch!.backend, `torch==${inst.torch!.version}`];
  await uvRun(need.torch ? `Installing PyTorch (${need.torch.backend})` : `Installing PyTorch ${inst.torch!.version}`,
    ["pip", "install", "--python", python, ...torchSpec, "torchvision", "torchaudio"]);
  const torch = await readTorch(python);
  if (!torch) throw new Error("PyTorch was installed but doesn't import");
  const hold = torchArgs(dir, torch);
  await uvRun("Installing ComfyUI's requirements", ["pip", "install", "--python", python, ...hold, "-r", join(dir, "requirements.txt")]);
  await uvRun("Installing the extension's packages", ["pip", "install", "--python", python, ...hold, ...Object.values(EXTENSION_PACKAGES)]);

  const next: Install = { dir, python, gpu: inst.gpu, version: need.comfyui ?? inst.version, torch };
  // The node packages the install has, fresh (a new ComfyUI may break old ones); ours is written
  // at each launch. One the registry can't give is copied as it is.
  const oldNodes = join(inst.dir, "custom_nodes");
  for (const id of existsSync(oldNodes) ? readdirSync(oldNodes, { withFileTypes: true }) : []) {
    if (!id.isDirectory() || id.name.startsWith(".") || id.name === "__pycache__" || id.name === WAIT_EXTENSION_DIR) continue;
    try {
      await installNodePackage(p, next, id.name, onLine);
    } catch (e) {
      onLine(`${id.name}: kept as it was (${(e as Error).message})`);
      cpSync(join(oldNodes, id.name), join(dir, "custom_nodes", id.name), { recursive: true });
    }
  }
  writeWaitExtension(next, files);
  return next;
}

/** The device *next*'s torch should use: its build's, else the Mac's. */
function deviceOf(next: Install): string {
  const backend = backendOf(next.torch?.version ?? "");
  if (/^(cu|rocm)/.test(backend)) return "cuda"; // ROCm builds use torch.cuda too
  if (backend === "xpu") return "xpu";
  return next.gpu === "mac" ? "mps" : "cpu";
}

const PROBE = `
import json, sys, torch
dev = sys.argv[1]
ok = {"cuda": lambda: torch.cuda.is_available(), "xpu": lambda: hasattr(torch, "xpu") and torch.xpu.is_available(),
      "mps": lambda: torch.backends.mps.is_available()}.get(dev, lambda: True)()
if not ok:
    sys.exit(f"PyTorch {torch.__version__} doesn't see the GPU ({dev})")
x = torch.ones(256, 256, device=dev)
total = (x @ x).sum().item()
if dev == "cuda":
    torch.cuda.synchronize()
if total != 256.0 ** 3:
    sys.exit(f"PyTorch {torch.__version__} miscalculated on {dev}: {total}")
print(json.dumps({"torch": torch.__version__, "device": dev}))
`;

/** Stage 2, ComfyUI stopped: *next*'s torch works on this PC's GPU, and ComfyUI starts with our
 * nodes and its node packages loaded. Throws what failed. */
export async function checkNext(next: Install, onLine: (l: string) => void): Promise<void> {
  const dev = deviceOf(next);
  onLine(`Checking PyTorch ${next.torch?.version} on the ${dev === "cpu" ? "CPU" : `GPU (${dev})`}`);
  const probe = await run(next.python, ["-c", PROBE, dev], { cwd: next.dir, env: pythonEnv(), timeoutMs: 300_000 });
  if (probe.code !== 0) throw new Error(`The new PyTorch doesn't work here: ${probe.output.trim().split("\n").slice(-3).join(" ")}`);
  onLine("Checking that ComfyUI starts");
  const args = ["main.py", "--quick-test-for-ci", ...(dev === "cpu" ? ["--cpu"] : [])];
  const test = await run(next.python, args, { cwd: next.dir, env: pythonEnv(), timeoutMs: 600_000 });
  const failedNodes = /IMPORT FAILED/.test(test.output);
  if (test.code !== 0 || failedNodes) {
    throw new Error(`The new ComfyUI ${failedNodes ? "didn't load a node package" : "doesn't start"}: ${test.output.trim().split("\n").slice(-4).join(" ")}`);
  }
}

/** The entries of a ComfyUI folder that are code, not the user's (KEEP). */
const codeEntries = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((e) => !KEEP.includes(e)) : []);

/** Stage 3: the old code to <comfyui>.prev, *next*'s in. Returns the install in its place. Any
 * failure moves everything back, then throws. */
export async function swapIn(p: Paths, next: Install): Promise<Install> {
  const ws = p.comfyui;
  const prev = prevDir(p);
  await removeDir(prev);
  mkdirSync(prev, { recursive: true });
  const out: string[] = [];
  const into: string[] = [];
  try {
    for (const e of codeEntries(ws)) {
      await moveDir(join(ws, e), join(prev, e));
      out.push(e);
    }
    for (const e of codeEntries(next.dir)) {
      await moveDir(join(next.dir, e), join(ws, e));
      into.push(e);
    }
    const inst: Install = { ...next, dir: ws, python: venvBin(join(ws, ".venv"), "python") };
    writeMarker(inst);
    return inst;
  } catch (e) {
    log.error("Swapping in the new ComfyUI failed; putting the old one back:", e);
    for (const x of into) await moveDir(join(ws, x), join(next.dir, x)).catch(() => removeDir(join(ws, x)));
    for (const x of out) await moveDir(join(prev, x), join(ws, x));
    throw e;
  }
}

/** The new ComfyUI didn't launch: its code goes, the old one comes back from <comfyui>.prev. */
export async function swapBack(p: Paths): Promise<void> {
  const ws = p.comfyui;
  const prev = prevDir(p);
  if (!existsSync(prev)) return;
  for (const e of codeEntries(ws)) await removeDir(join(ws, e));
  for (const e of codeEntries(prev)) await moveDir(join(prev, e), join(ws, e));
  await removeDir(prev);
}
