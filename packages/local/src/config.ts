// The config file, local_config.json: core's config plus the keys only a local install has.
// The old extension's file is read as it is; its few differing keys are migrated on load.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPlainObject, normalize, tokenUrlsafe, type Config } from "@comfy-gen/core";
import { log } from "./log.ts";

export const DEFAULT_MCP_PORT = 9247;
// The old extension's default ComfyUI URL meant "the managed one", as an empty value does now.
const OLD_DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188";

export type LocalConfig = Config & {
  mcp_path: string; // the MCP route's secret path, "/mcp/<token>"
  mcp_port: number;
  comfyui_url: string; // a ComfyUI the user runs; empty: the managed one
  extra_models_dir: string; // another models folder to read from
  gpu: string; // "nvidia" | "amd" | "mac" | "cpu", chosen at install; empty until then
};

/** The old extension's keys in the new shape. Returns whether anything changed. */
export function migrate(raw: Record<string, any>): boolean {
  let changed = false;
  if ("use_tunnel" in raw) {
    delete raw.use_tunnel; // the tunnel mode is gone: remote use goes through a Worker
    changed = true;
  }
  if (raw.comfyui_url === OLD_DEFAULT_COMFYUI_URL) {
    raw.comfyui_url = "";
    changed = true;
  }
  // The old custom workflow was a file path plus a prompt node title; now the workflow itself.
  if (typeof raw.custom_workflow === "string" || "custom_workflow_prompt_node" in raw) {
    const path = typeof raw.custom_workflow === "string" ? raw.custom_workflow.trim() : "";
    const title = typeof raw.custom_workflow_prompt_node === "string" ? raw.custom_workflow_prompt_node.trim() : "";
    raw.custom_workflow = null;
    if (path) {
      try {
        const workflow = JSON.parse(readFileSync(path, "utf8"));
        if (isPlainObject(workflow)) raw.custom_workflow = { workflow, prompt_node_title: title };
      } catch (e) {
        log.warn(`The old custom workflow ${path} could not be read, so it is dropped:`, (e as Error).message);
      }
    }
    delete raw.custom_workflow_prompt_node;
    changed = true;
  }
  return changed;
}

function withLocalDefaults(raw: Record<string, any>): LocalConfig {
  const cfg = normalize(raw) as LocalConfig;
  if (typeof cfg.mcp_path !== "string" || !cfg.mcp_path.startsWith("/mcp/")) cfg.mcp_path = `/mcp/${tokenUrlsafe(32)}`;
  if (!Number.isInteger(cfg.mcp_port) || cfg.mcp_port <= 0 || cfg.mcp_port > 65535) cfg.mcp_port = DEFAULT_MCP_PORT;
  for (const key of ["comfyui_url", "extra_models_dir", "gpu"] as const) {
    if (typeof cfg[key] !== "string") cfg[key] = "";
  }
  cfg.comfyui_url = cfg.comfyui_url.trim().replace(/\/+$/, "");
  return cfg;
}

/** Read the config, migrating and filling it in; the file is written back when that changed it.
 * A missing or unreadable file gives the defaults (an unreadable one is kept aside, not lost). */
export function loadConfig(path: string): LocalConfig {
  let raw: Record<string, any> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (isPlainObject(parsed)) raw = parsed;
    } catch (e) {
      log.error(`${path} is not valid JSON; moved to ${path}.broken and starting from defaults:`, (e as Error).message);
      renameSync(path, `${path}.broken`);
    }
  }
  const migrated = migrate(raw);
  const cfg = withLocalDefaults(raw);
  if (migrated || canonical(cfg) !== canonical(raw)) saveConfig(path, cfg);
  return cfg;
}

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (isPlainObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
}

/** Write atomically: a crash mid-write must not lose the MCP path or the settings. */
export function saveConfig(path: string, cfg: Record<string, any>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, path);
}
