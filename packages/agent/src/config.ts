// The agent's settings, agent.json in the folder it shares with the MCPB (~/.comfy-gen-mcp). The
// pack settings live on the Worker; this holds the pairing and the machine's own settings.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "@comfy-gen/core";
import { saveConfig, type ComfySettings, type Paths } from "@comfy-gen/local";

export const DEFAULT_AGENT_PORT = 9248; // the MCPB's is 9247

export type AgentConfig = ComfySettings & {
  worker_url: string; // https://<worker>, from the pairing link
  secret: string;
  port: number;
};

export function agentConfigPath(p: Paths): string {
  return join(p.home, "agent.json");
}

export function loadAgentConfig(p: Paths): AgentConfig {
  let raw: Record<string, any> = {};
  const path = agentConfigPath(p);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (isPlainObject(parsed)) raw = parsed;
    } catch {
      // a broken file: start unpaired rather than not at all
    }
  }
  const str = (k: string) => (typeof raw[k] === "string" ? raw[k].trim() : "");
  const keepWarm = Number.isInteger(raw.keep_warm_minutes) && raw.keep_warm_minutes > 0 ? raw.keep_warm_minutes : 5;
  const port = Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : DEFAULT_AGENT_PORT;
  return {
    worker_url: str("worker_url"), secret: str("secret"), port,
    comfyui_url: str("comfyui_url").replace(/\/+$/, ""), extra_models_dir: str("extra_models_dir"), gpu: str("gpu"),
    keep_warm_minutes: keepWarm,
  };
}

export function saveAgentConfig(p: Paths, cfg: AgentConfig): void {
  saveConfig(agentConfigPath(p), cfg);
}

/** The Worker's pairing link, https://<worker>/agent#<secret>, as [worker_url, secret]. Throws a
 * message for the user if it is not one. */
export function parsePairingLink(link: string): [string, string] {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error("That is not a link. Copy the pairing link from your Worker's settings page (Setup, Your PC).");
  }
  const secret = url.hash.slice(1);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(url.host))) {
    throw new Error("The pairing link must be an https link to your Worker.");
  }
  if (url.pathname !== "/agent" || secret.length < 32) {
    throw new Error("That is not a pairing link. Copy it from your Worker's settings page (Setup, Your PC).");
  }
  return [url.origin, secret];
}
