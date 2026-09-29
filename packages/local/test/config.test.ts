import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_PORT, loadConfig } from "../src/config.ts";

const dir = () => mkdtempSync(join(tmpdir(), "cfg-"));

describe("loadConfig", () => {
  it("creates a config with a secret MCP path", () => {
    const path = join(dir(), "local_config.json");
    const cfg = loadConfig(path);
    expect(cfg.mcp_path).toMatch(/^\/mcp\/[A-Za-z0-9_-]{43}$/);
    expect(cfg.mcp_port).toBe(DEFAULT_MCP_PORT);
    expect(JSON.parse(readFileSync(path, "utf8")).mcp_path).toBe(cfg.mcp_path);
    expect(loadConfig(path).mcp_path).toBe(cfg.mcp_path);
  });

  it("migrates the old extension's file and keeps its settings", () => {
    const d = dir();
    const wf = { "1": { class_type: "KSampler", inputs: {} } };
    writeFileSync(join(d, "wf.json"), JSON.stringify(wf));
    const path = join(d, "local_config.json");
    writeFileSync(path, JSON.stringify({
      mcp_path: "/mcp/oldsecret", mcp_port: 9300, use_tunnel: true, setup_version: 3,
      comfyui_url: "http://127.0.0.1:8188", extra_models_dir: "D:/models",
      custom_workflow: join(d, "wf.json"), custom_workflow_prompt_node: "Prompt",
      pack_selections: { generate_image: "anima" }, pack_loras: { anima: [{ name: "a.safetensors", strength: 0.8 }] },
    }));
    const cfg = loadConfig(path);
    expect(cfg.mcp_path).toBe("/mcp/oldsecret");
    expect(cfg.mcp_port).toBe(9300);
    expect(cfg.comfyui_url).toBe("");
    expect(cfg.extra_models_dir).toBe("D:/models");
    expect(cfg.custom_workflow).toEqual({ workflow: wf, prompt_node_title: "Prompt" });
    expect(cfg.pack_selections).toEqual({ generate_image: "anima" });
    expect(cfg.pack_loras.anima[0]).toMatchObject({ name: "a.safetensors", strength: 0.8 });
    expect(cfg.setup_version).toBe(3); // unknown keys are kept
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved).not.toHaveProperty("use_tunnel");
    expect(saved).not.toHaveProperty("custom_workflow_prompt_node");
  });

  it("drops an unreadable old custom workflow and keeps a custom ComfyUI URL", () => {
    const path = join(dir(), "local_config.json");
    writeFileSync(path, JSON.stringify({ custom_workflow: "/nowhere.json", comfyui_url: "http://box:8188/" }));
    const cfg = loadConfig(path);
    expect(cfg.custom_workflow).toBeNull();
    expect(cfg.comfyui_url).toBe("http://box:8188");
  });

  it("does not rewrite a file that needs nothing", () => {
    const path = join(dir(), "local_config.json");
    loadConfig(path);
    const before = statSync(path).mtimeMs;
    const text = readFileSync(path, "utf8");
    loadConfig(path);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("keeps a broken file aside", () => {
    const path = join(dir(), "local_config.json");
    writeFileSync(path, "{nope");
    loadConfig(path);
    expect(readFileSync(`${path}.broken`, "utf8")).toBe("{nope");
  });
});
