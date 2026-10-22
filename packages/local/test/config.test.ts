import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_PORT, loadConfig } from "../src/config.ts";

const dir = () => mkdtempSync(join(tmpdir(), "cfg-"));

describe("loadConfig", () => {
  it("creates a config with a secret MCP path", () => {
    const path = join(dir(), "config.json");
    const cfg = loadConfig(path);
    expect(cfg.mcp_path).toMatch(/^\/mcp\/[A-Za-z0-9_-]{43}$/);
    expect(cfg.mcp_port).toBe(DEFAULT_MCP_PORT);
    expect(JSON.parse(readFileSync(path, "utf8")).mcp_path).toBe(cfg.mcp_path);
    expect(loadConfig(path).mcp_path).toBe(cfg.mcp_path);
  });

  it("keeps unknown keys, and drops a ComfyUI of the user's own (removed) from the file", () => {
    const path = join(dir(), "config.json");
    writeFileSync(path, JSON.stringify({ comfyui_url: "http://box:8188/", mcp_port: 9300, someday: 1, pack_selections: { generate_illustrated_image: "anima" } }));
    const cfg = loadConfig(path);
    expect("comfyui_url" in cfg).toBe(false);
    expect("comfyui_url" in JSON.parse(readFileSync(path, "utf8"))).toBe(false);
    expect(cfg.mcp_port).toBe(9300);
    expect(cfg.someday).toBe(1);
    expect(cfg.pack_selections).toEqual({ generate_illustrated_image: "anima" });
  });

  it("keeps ComfyUI flags that pass, and drops ones that don't (edited in by hand)", () => {
    const path = join(dir(), "config.json");
    expect(loadConfig(path).comfy_args).toEqual([]);
    writeFileSync(path, JSON.stringify({ comfy_args: ["--lowvram"] }));
    expect(loadConfig(path).comfy_args).toEqual(["--lowvram"]);
    writeFileSync(path, JSON.stringify({ comfy_args: "--lowvram" }));
    expect(loadConfig(path).comfy_args).toEqual([]);
  });

  it("does not rewrite a file that needs nothing", () => {
    const path = join(dir(), "config.json");
    loadConfig(path);
    const before = statSync(path).mtimeMs;
    const text = readFileSync(path, "utf8");
    loadConfig(path);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("keeps a broken file aside", () => {
    const path = join(dir(), "config.json");
    writeFileSync(path, "{nope");
    loadConfig(path);
    expect(readFileSync(`${path}.broken`, "utf8")).toBe("{nope");
  });
});
