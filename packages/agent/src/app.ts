// The agent's settings page and API, on 127.0.0.1 only: the machine (install, ComfyUI, models,
// folders; local's Machine, as in the MCPB) and the pairing with a Worker. Pack settings live on the
// Worker's page.

import {
  bodyJson, checkMachineSettings, error, fromThisMachine, json, log, webFile, type Machine, type WebFiles,
} from "@comfy-gen/local";
import { parsePairingLink, type AgentConfig } from "./config.ts";
import type { RelayClient } from "./relay-client.ts";

export type AgentServices = {
  version: string;
  port: number;
  machine: Machine;
  config(): AgentConfig;
  saveConfig(cfg: AgentConfig): void;
  /** (Re)connect with the current pairing, or disconnect if there is none. */
  reconnect(): void;
  relay(): RelayClient | null;
  /** Paused from the tray: not taking image requests. */
  paused?(): boolean;
  web: WebFiles;
};

export class AgentApp {
  readonly s: AgentServices;

  constructor(s: AgentServices) {
    this.s = s;
  }

  get settingsUrl(): string {
    return `http://127.0.0.1:${this.s.port}/`;
  }

  async handle(req: Request, remote: string): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/alive") return json({ version: this.s.version, pid: process.pid, agent: true });
    if (!fromThisMachine(req, remote)) return error(403, "the settings page answers only on this computer");
    if (path.startsWith("/api/")) {
      try {
        return (await this.s.machine.api(req, path.slice(4))) ?? (await this.api(req, path.slice(4)));
      } catch (e) {
        log.error(`${req.method} ${path} failed:`, e);
        return error(500, (e as Error).message);
      }
    }
    return webFile(this.s.web, req, path);
  }

  private async api(req: Request, sub: string): Promise<Response> {
    const m = req.method;
    if (sub === "/state" && m === "GET") return json(await this.state());
    if (sub === "/config" && m === "PUT") {
      const incoming = (await bodyJson(req)).config ?? {};
      const cfg = this.s.config();
      const next = {
        ...cfg,
        comfyui_url: String(incoming.comfyui_url ?? cfg.comfyui_url).trim().replace(/\/+$/, ""),
        extra_models_dir: String(incoming.extra_models_dir ?? cfg.extra_models_dir).trim(),
      };
      const bad = checkMachineSettings(next);
      if (bad) return error(400, bad);
      this.s.saveConfig(next);
      const warnings = this.s.machine.comfy.state === "running" ? ["Restart ComfyUI for the change to take effect."] : [];
      return json({ config: next, warnings });
    }
    if (sub === "/pair" && m === "POST") {
      let worker: string, secret: string;
      try {
        [worker, secret] = parsePairingLink(String((await bodyJson(req)).link ?? ""));
      } catch (e) {
        return error(400, (e as Error).message);
      }
      this.s.saveConfig({ ...this.s.config(), worker_url: worker, secret });
      this.s.reconnect();
      return json({ ok: true, worker_url: worker });
    }
    if (sub === "/pair" && m === "DELETE") {
      this.s.saveConfig({ ...this.s.config(), worker_url: "", secret: "" });
      this.s.reconnect();
      return json({ ok: true });
    }
    if (sub === "/models" && m === "GET") {
      // The packs the Worker asked for so far, with their downloads.
      const packs = this.s.machine.downloads.jobs().map((j) => ({ name: j.key, display_name: j.label, size: j.total, ...j }));
      return json({ packs });
    }
    return error(404, "not found");
  }

  private async state() {
    const cfg = this.s.config();
    const client = this.s.relay();
    return {
      mode: "agent",
      version: this.s.version,
      ...(await this.s.machine.state(cfg.gpu)),
      worker: {
        url: cfg.worker_url || null,
        paired: Boolean(cfg.worker_url && cfg.secret),
        state: client?.state ?? "unpaired",
        error: client?.lastError ?? null,
        since: client?.connectedSince ?? null,
        paused: this.s.paused?.() ?? false,
      },
      config: { comfyui_url: cfg.comfyui_url, extra_models_dir: cfg.extra_models_dir },
    };
  }
}
