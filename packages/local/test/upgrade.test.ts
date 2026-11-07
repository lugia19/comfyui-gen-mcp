import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findInstall, writeMarker } from "../src/install.ts";
import { Machine } from "../src/machine.ts";
import { paths, type Paths } from "../src/paths.ts";
import { describeTarget, needsUpgrade } from "../src/upgrade.ts";
import { UV_VERSION, uvPath } from "../src/uv.ts";
import { chooseBuild, COMFYUI_VERSION } from "../src/versions.ts";

const POSIX = process.platform !== "win32";
const write = (path: string, text: string, exec = false) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  if (exec) chmodSync(path, 0o755);
};

// A ComfyUI main.py (run by Node through the fake Python): notes which one started, and answers.
const mainPy = (which: string, flags: string) => `
  const fs = require("node:fs");
  if (fs.existsSync(${JSON.stringify(join(flags, "launch-fails"))}) && ${JSON.stringify(which)} === "new") process.exit(1);
  const args = process.argv.slice(2);
  fs.appendFileSync(${JSON.stringify(join(flags, "starts.log"))}, ${JSON.stringify(which)} + "\\n");
  const port = Number(args[args.indexOf("--port") + 1]);
  require("node:http").createServer((req, res) => res.end(JSON.stringify({ queue_running: [], queue_pending: [] }))).listen(port, "127.0.0.1");
`;

/** A home with an installed ComfyUI (marker *version* and *torch*), and stand-ins for uv, Python and
 * ComfyUI's source: uv's venv makes a fake Python, its pip install records torch's version. */
function world(version: string, torch: string) {
  const home = mkdtempSync(join(tmpdir(), "upgrade-"));
  const p = paths({ COMFY_GEN_HOME: home });
  const flags = join(home, "flags");
  mkdirSync(flags, { recursive: true });
  const log = join(home, "uv.log");
  const fakePy = join(home, "fake-python");
  write(fakePy, `#!/bin/sh
here=$(dirname "$0")
case "$*" in
  *"import torch; print"*) cat "$here/../torch-version"; exit 0;;
  *"import json, sys, torch"*)
    [ -f '${flags}/probe-fails' ] && { echo "RuntimeError: CUDA error: no kernel image is available" >&2; exit 1; }
    [ -f '${flags}/probe-slow' ] && sleep 2
    echo '{"torch": "x"}'; exit 0;;
  *"--quick-test-for-ci"*) exit 0;;
  "-c "*) exit 0;;
esac
exec "${process.execPath}" "$@"
`, true);
  write(uvPath(p), `#!/bin/sh
if [ "$1" = --version ]; then echo "uv ${UV_VERSION} (test)"; exit 0; fi
echo "uv $*" >> '${log}'
if [ "$1" = venv ]; then for a; do last="$a"; done; mkdir -p "$last/bin"; cp '${fakePy}' "$last/bin/python"; exit 0; fi
py=""; prev=""; for a; do [ "$prev" = --python ] && py="$a"; prev="$a"; done
venv=$(dirname "$(dirname "$py")")
for a; do case "$a" in torch==*) echo "\${a#torch==}" > "$venv/torch-version";; "torch>="*) echo "2.15.0+cpu" > "$venv/torch-version";; esac; done
exit 0
`, true);

  // The installed ComfyUI: its code, its venv with torch, the user's files
  const ws = p.comfyui;
  write(join(ws, "main.py"), mainPy("old", flags));
  write(join(ws, "comfy", "old.txt"), "old code");
  write(join(ws, "models", "checkpoints", "mine.safetensors"), "weights");
  write(join(ws, "output", "img.png"), "picture");
  const python = join(ws, ".venv", "bin", "python");
  write(python, readFileSync(fakePy, "utf8"), true);
  write(join(ws, ".venv", "torch-version"), torch);
  writeMarker({ dir: ws, python, gpu: "cpu", version, torch: { backend: torch.split("+")[1] ?? "auto", version: torch } });

  const fetchSource = async (dir: string, v: string) => {
    write(join(dir, "main.py"), mainPy("new", flags));
    write(join(dir, "comfy", "version.txt"), v);
    write(join(dir, "requirements.txt"), "aiohttp\n");
    mkdirSync(join(dir, "models", "checkpoints"), { recursive: true }); // the release's placeholders
  };
  const machine = new Machine({
    paths: p,
    settings: () => ({ extra_models_dir: "", keep_warm_minutes: 1, gpu: "cpu" }),
    saveGpu: () => {},
    waitExtension: { "__init__.py": "# ours" },
    fetchSource,
    freeBytes: () => 1e12,
  });
  const uvCalls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const starts = () => (existsSync(join(flags, "starts.log")) ? readFileSync(join(flags, "starts.log"), "utf8").trim().split("\n") : []);
  const flag = (name: string, on = true) => (on ? writeFileSync(join(flags, name), "") : rmSync(join(flags, name), { force: true }));
  return { p, ws, machine, uvCalls, starts, flags, flag };
}

const settled = async (m: Machine, timeoutMs = 20_000) => {
  const end = Date.now() + timeoutMs;
  while (!["done", "failed"].includes(m.upgrade.state) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return m.upgrade;
};
const marker = async (p: Paths) => (await findInstall(p))!;

describe("what an install needs", () => {
  const inst = (version: string, torch: string) => ({ dir: "", python: "", gpu: "nvidia" as const, version, torch: { backend: "cu130", version: torch } });
  it("a ComfyUI below the target; a torch below the minimum or that can't run here; never a working one sideways", () => {
    const rtx = { computeCap: 8.9, driver: 610 };
    const gtx = { computeCap: 6.1, driver: 610 };
    expect(needsUpgrade(inst(COMFYUI_VERSION, "2.14.1+cu130"), chooseBuild("nvidia", rtx), rtx)).toBeNull();
    expect(needsUpgrade(inst("0.30.0", "2.14.1+cu130"), chooseBuild("nvidia", rtx), rtx)).toEqual({ comfyui: COMFYUI_VERSION, torch: null });
    expect(needsUpgrade(inst(COMFYUI_VERSION, "2.8.0+cu128"), chooseBuild("nvidia", rtx), rtx)?.torch?.backend).toBe("cu130");
    // uv's auto gave this GTX 10-series a CUDA 13 build without its kernels: moved to cu126
    expect(needsUpgrade(inst(COMFYUI_VERSION, "2.15.0+cu132"), chooseBuild("nvidia", gtx), gtx)?.torch?.backend).toBe("cu126");
    // A driver too old for any fitting build: nothing to move torch to
    const old = { computeCap: 12, driver: 560 };
    expect(needsUpgrade(inst(COMFYUI_VERSION, "2.14.1+cu126"), chooseBuild("nvidia", old), old)).toBeNull();
    expect(describeTarget(inst("0.30.0", "2.14.1+cu130"), { comfyui: "0.44.2", torch: null })).toBe("ComfyUI 0.44.2, PyTorch 2.14.1+cu130");
  });
});

describe.skipIf(!POSIX)("upgrading in place, once idle", () => {
  let home: string | undefined;
  let machines: Machine[] = [];
  beforeEach(() => {
    home = process.env.HOME;
    machines = [];
  });
  afterEach(async () => {
    for (const m of machines) await m.comfy.stop();
    process.env.HOME = home;
  });
  const setup = (version: string, torch: string) => {
    const w = world(version, torch);
    process.env.HOME = w.p.home; // ComfyUI's start announces it in ~/.comfy-registry: not the real one
    machines.push(w.machine);
    return w;
  };

  it("a newer ComfyUI: built beside, checked, swapped in, the user's files and the same torch kept", async () => {
    const { p, ws, machine, uvCalls, starts } = setup("0.30.0", "2.14.1+cu130");
    expect((await machine.checkUpgrade()).state).toBe("building"); // never used since start: idle
    const done = await settled(machine);
    expect([done.state, done.error]).toEqual(["done", null]);
    expect(done.to).toBe(`ComfyUI ${COMFYUI_VERSION}, PyTorch 2.14.1+cu130`);
    const inst = await marker(p);
    expect([inst.version, inst.torch]).toEqual([COMFYUI_VERSION, { backend: "cu130", version: "2.14.1+cu130" }]);
    expect(inst.python).toBe(join(ws, ".venv", "bin", "python"));
    expect(readFileSync(join(ws, "comfy", "version.txt"), "utf8")).toBe(COMFYUI_VERSION);
    expect(existsSync(join(ws, "comfy", "old.txt"))).toBe(false);
    expect(readFileSync(join(ws, "models", "checkpoints", "mine.safetensors"), "utf8")).toBe("weights");
    expect(readFileSync(join(ws, "output", "img.png"), "utf8")).toBe("picture");
    expect(existsSync(`${ws}.next`) || existsSync(`${ws}.prev`)).toBe(false);
    expect(uvCalls()).toContain("venv --relocatable");
    expect(uvCalls()).toContain("--torch-backend cu130 torch==2.14.1+cu130"); // the same torch, from uv's cache
    expect(uvCalls()).toMatch(/--constraint \S+\.next\/\.comfy-gen-constraints\.txt -r/); // held through the requirements
    expect(starts()).toEqual(["new"]); // started once it was in place
    expect((await machine.checkUpgrade()).state).toBe("done"); // nothing more to do
  });

  it("a torch below the minimum: the build's newest in range", async () => {
    const { p, machine, uvCalls } = setup(COMFYUI_VERSION, "2.8.0+cpu");
    await machine.checkUpgrade();
    expect((await settled(machine)).state).toBe("done");
    expect(uvCalls()).toContain("--torch-backend cpu torch>=2.9 torchvision torchaudio");
    expect((await marker(p)).torch).toEqual({ backend: "cpu", version: "2.15.0+cpu" });
  });

  it("a new torch that doesn't work on the GPU: the old install stays as it was, not tried again for a day", async () => {
    const { p, ws, machine, flag, starts } = setup("0.30.0", "2.14.1+cu130");
    flag("probe-fails");
    await machine.checkUpgrade();
    const failed = await settled(machine);
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/doesn't work here: .*no kernel image/);
    expect((await marker(p)).version).toBe("0.30.0");
    expect(readFileSync(join(ws, "comfy", "old.txt"), "utf8")).toBe("old code");
    expect(existsSync(`${ws}.next`) || existsSync(`${ws}.prev`)).toBe(false);
    expect(starts()).toEqual([]);
    const at = failed.at;
    expect((await machine.checkUpgrade()).at).toBe(at); // held
    // Try again (the page) runs it now, hold or not
    flag("probe-fails", false);
    await machine.checkUpgrade(true);
    expect((await settled(machine)).state).toBe("done");
  });

  it("a new ComfyUI that doesn't start: the old one is put back, and starts", async () => {
    const { p, ws, machine, flag, starts } = setup("0.30.0", "2.14.1+cu130");
    flag("launch-fails");
    await machine.checkUpgrade();
    const failed = await settled(machine, 60_000);
    expect(failed.state).toBe("failed");
    expect((await marker(p)).version).toBe("0.30.0");
    expect(readFileSync(join(ws, "comfy", "old.txt"), "utf8")).toBe("old code");
    expect(existsSync(join(ws, "comfy", "version.txt"))).toBe(false);
    expect(existsSync(`${ws}.prev`)).toBe(false);
    await machine.comfy.ensureRunning();
    expect(starts().at(-1)).toBe("old");
  }, 90_000);

  it("a call during the check waits for it, and gets the new ComfyUI", async () => {
    const { machine, flag, starts } = setup("0.30.0", "2.14.1+cu130");
    flag("probe-slow");
    await machine.checkUpgrade();
    while (machine.upgrade.state !== "checking") await new Promise((r) => setTimeout(r, 20));
    const url = await machine.comfy.ensureRunning(); // an image asked for meanwhile
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await settled(machine)).state).toBe("done");
    expect(starts()).not.toContain("old");
  });

  it("not while ComfyUI is in use; an install meanwhile is refused", async () => {
    const { machine } = setup("0.30.0", "2.14.1+cu130");
    let finish!: () => void;
    const job = machine.comfy.job(() => new Promise<void>((r) => (finish = r)));
    expect((await machine.checkUpgrade()).state).toBe("idle");
    finish();
    await job;
    await new Promise((r) => setTimeout(r, 10));
    expect(machine.idleFor(5)).toBe(true);
    await machine.checkUpgrade(true);
    expect(machine.busyInstalling).toBe(true);
    expect(() => machine.startInstall("cpu")).toThrow(/being upgraded/);
    await settled(machine);
  });
});
