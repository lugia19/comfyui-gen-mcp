import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearWorkspace } from "../src/install.ts";

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
