import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backendOf, clearWorkspace, ensureExtensionPackages, EXTENSION_PACKAGES, findInstall, holdTorch, writeMarker } from "../src/install.ts";
import { WAIT_EXTENSION_DIR, writeWaitExtension } from "../src/nodes.ts";
import { paths } from "../src/paths.ts";
import { UV_VERSION, uvPath } from "../src/uv.ts";

const dir = () => mkdtempSync(join(tmpdir(), "install-"));
const file = (path: string, text = "data") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

describe("reinstalling", () => {
  it("empties the workspace but leaves models, outputs, inputs and user settings in place", async () => {
    const ws = dir();
    file(join(ws, "main.py"));
    file(join(ws, "models", "checkpoints", "mine.safetensors"));
    file(join(ws, "output", "img.png"));
    file(join(ws, "user", "default", "comfy.settings.json"));
    file(join(ws, ".venv", "bin", "python"));
    file(join(ws, "comfy", "sd.py"));
    await clearWorkspace(ws);
    expect(readdirSync(ws).sort()).toEqual(["models", "output", "user"]);
    expect(readFileSync(join(ws, "models", "checkpoints", "mine.safetensors"), "utf8")).toBe("data");
  });
});

describe("our extension's files", () => {
  it("writes every file into custom_nodes, over the last release's", () => {
    const ws = dir();
    const inst = { dir: ws, python: "", gpu: null, version: null, torch: null };
    writeWaitExtension(inst, { "__init__.py": "old" });
    writeWaitExtension(inst, { "__init__.py": "nodes", "lllite.py": "model code", "LICENSE-lllite.txt": "Apache" });
    const ext = join(ws, "custom_nodes", WAIT_EXTENSION_DIR);
    expect(readdirSync(ext).sort()).toEqual(["LICENSE-lllite.txt", "__init__.py", "lllite.py"]);
    expect(readFileSync(join(ext, "__init__.py"), "utf8")).toBe("nodes");
  });
});

describe("the extension's packages", () => {
  // A stand-in Python and uv: each logs its arguments; the Python has torch 2.14.1+cu130, and finds
  // the extension's packages when told to.
  const setup = (found: boolean) => {
    const p = paths({ COMFY_GEN_HOME: dir() });
    mkdirSync(p.comfyui, { recursive: true });
    const log = join(p.home, "calls.log");
    const python = join(p.home, "python");
    file(python, `#!/bin/sh\necho "python $*" >> '${log}'\ncase "$*" in *"import torch"*) echo 2.14.1+cu130; exit 0;; esac\nexit ${found ? 0 : 1}\n`);
    file(uvPath(p), `#!/bin/sh\nif [ "$1" = --version ]; then echo "uv ${UV_VERSION} (test)"; exit 0; fi\necho "uv $*" >> '${log}'\n`);
    chmodSync(python, 0o755);
    chmodSync(uvPath(p), 0o755);
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
    return { p, inst: { dir: p.comfyui, python, gpu: "nvidia" as const, version: "0.37.0", torch: null }, calls };
  };

  it.skipIf(process.platform === "win32")("are installed when an older install lacks them, torch held as it is", async () => {
    const { p, inst, calls } = setup(false);
    await ensureExtensionPackages(p, inst);
    // The install's torch, read once (a marker from before it was recorded) and written down
    expect(calls()[2]).toBe(`python -c import torch; print(torch.__version__)`);
    const held = `--torch-backend cu130 --constraint ${join(p.comfyui, ".comfy-gen-constraints.txt")}`;
    expect(calls()[3]).toBe(`uv pip install --python ${inst.python} ${held} ${Object.values(EXTENSION_PACKAGES).join(" ")}`);
    expect(readFileSync(join(p.comfyui, ".comfy-gen-constraints.txt"), "utf8")).toBe("torch==2.14.1+cu130\n");
  });

  it.skipIf(process.platform === "win32")("torch: recorded in the marker once, then read from it", async () => {
    const { p, inst, calls } = setup(true);
    file(join(p.comfyui, "main.py"));
    mkdirSync(join(p.comfyui, "models"), { recursive: true });
    writeMarker(inst); // an install from before the marker had torch
    const old = (await findInstall(p))!;
    expect(old.torch).toBeNull();
    await holdTorch(old);
    expect((await findInstall(p))!.torch).toEqual({ backend: "cu130", version: "2.14.1+cu130" });
    const n = calls().length;
    expect(await holdTorch((await findInstall(p))!)).toContain("cu130");
    expect(calls()).toHaveLength(n); // from the marker: torch not imported again
  });

  it("names a torch's build by its tag", () => {
    expect(backendOf("2.14.1+cu130")).toBe("cu130");
    expect(backendOf("2.9.1+rocm6.4")).toBe("rocm6.4");
    expect(backendOf("2.15.0+xpu")).toBe("xpu");
    expect(backendOf("2.15.0")).toBe("auto"); // macOS, Linux PyPI
  });

  it.skipIf(process.platform === "win32")("are left alone when present", async () => {
    const { p, inst, calls } = setup(true);
    await ensureExtensionPackages(p, inst);
    expect(calls()).toHaveLength(2);
    expect(calls()[0]).toContain("find_spec(\"ultralytics\")");
    expect(calls()[1]).toContain("find_spec(\"onnxruntime\")");
  });
});
