import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearWorkspace, ensureExtensionPackages, EXTENSION_PACKAGES } from "../src/install.ts";
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

describe("the extension's packages", () => {
  // A stand-in Python and uv: each logs its arguments; the Python finds the package when told to.
  const setup = (found: boolean) => {
    const p = paths({ COMFY_GEN_HOME: dir() });
    const log = join(p.home, "calls.log");
    const python = join(p.home, "python");
    file(python, `#!/bin/sh\necho "python $*" >> '${log}'\nexit ${found ? 0 : 1}\n`);
    file(uvPath(p), `#!/bin/sh\nif [ "$1" = --version ]; then echo "uv ${UV_VERSION} (test)"; exit 0; fi\necho "uv $*" >> '${log}'\n`);
    chmodSync(python, 0o755);
    chmodSync(uvPath(p), 0o755);
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
    return { p, inst: { dir: p.comfyui, python, gpu: "nvidia" as const, version: null }, calls };
  };

  it.skipIf(process.platform === "win32")("are installed when an older install lacks them", async () => {
    const { p, inst, calls } = setup(false);
    await ensureExtensionPackages(p, inst);
    expect(calls()[2]).toBe(`uv pip install --python ${inst.python} --torch-backend auto ${Object.values(EXTENSION_PACKAGES).join(" ")}`);
  });

  it.skipIf(process.platform === "win32")("are left alone when present", async () => {
    const { p, inst, calls } = setup(true);
    await ensureExtensionPackages(p, inst);
    expect(calls()).toHaveLength(2);
    expect(calls()[0]).toContain("find_spec(\"ultralytics\")");
    expect(calls()[1]).toContain("find_spec(\"onnxruntime\")");
  });
});
