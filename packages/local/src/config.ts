// The config file, config.json: core's config plus the keys only a local install has.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPlainObject, normalize, tokenUrlsafe, type Config } from "@comfy-gen/core";
import { log } from "./log.ts";

export const DEFAULT_MCP_PORT = 9247;

export type LocalConfig = Config & {
  mcp_path: string; // the MCP route's secret path, "/mcp/<token>"
  mcp_port: number;
  comfyui_url: string; // a ComfyUI the user runs; empty: the managed one
  extra_models_dir: string; // another models folder to read from
  gpu: string; // "nvidia" | "amd" | "mac" | "cpu", chosen at install; empty until then
};

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

/** Read the config, filling it in; the file is written back when that changed it.
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
  const cfg = withLocalDefaults(raw);
  if (canonical(cfg) !== canonical(raw)) saveConfig(path, cfg);
  return cfg;
}

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (isPlainObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
}

/**
 * Write *text* to *path* atomically: a crash mid-write must not lose the MCP path or the settings.
 * Each process writes its own temporary file, and a rename Windows refuses for a moment (another
 * process has the file open) is retried: Claude Desktop starts several copies of the extension at
 * once, and on a first run they all write the new config (one crashed, leaving a .tmp, 2026-10-02).
 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // a short, synchronous wait
    }
  }
}

export function saveConfig(path: string, cfg: Record<string, any>): void {
  writeFileAtomic(path, JSON.stringify(cfg, null, 2));
}
