import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearWorkspace, restoreKept } from "../src/install.ts";

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

  it("brings the kept folders up from the old extension's layout, ComfyUI one folder down", async () => {
    const ws = dir();
    file(join(ws, "ComfyUI", "main.py"));
    file(join(ws, "ComfyUI", "models", "loras", "a.safetensors"));
    await clearWorkspace(ws);
    expect(readdirSync(ws)).toEqual(["models"]);
    expect(existsSync(join(ws, "models", "loras", "a.safetensors"))).toBe(true);
  });

  it("puts back what an earlier failed reinstall left aside, unless the workspace has its own", async () => {
    const home = dir();
    const ws = join(home, "comfyui");
    const kept = join(home, "reinstall-kept");
    file(join(kept, "models", "checkpoints", "mine.safetensors"));
    file(join(kept, "output", "old.png"));
    file(join(ws, "models", "checkpoints", "put_checkpoints_here"), ""); // a new ComfyUI's placeholders
    file(join(ws, "output", "new.png")); // real files: this one stays as it is
    const lines: string[] = [];
    await restoreKept(ws, kept, (l) => lines.push(l));
    expect(existsSync(join(ws, "models", "checkpoints", "mine.safetensors"))).toBe(true);
    expect(existsSync(join(ws, "output", "new.png"))).toBe(true);
    expect(existsSync(join(kept, "output", "old.png"))).toBe(true);
    expect(lines.join()).toContain("has files of its own");
  });
});
