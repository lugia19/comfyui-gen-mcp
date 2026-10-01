// Starting the MCPB's local server in this process: config, the machine (managed ComfyUI, install,
// downloads; local's Machine), the settings app, and node:http on 0.0.0.0 at the configured port.
// The port is the single-instance lock: when another extension process holds it, start() fails with
// EADDRINUSE and the caller relays to that one instead (design §2, "The MCPB process").

import type { Server } from "node:http";
import { listen, loadConfig, log, logTo, Machine, paths, saveConfig, type LocalConfig, type Paths, type WebFiles } from "@comfy-gen/local";
import { LocalApp, selectedPacks } from "./app.ts";

export type ServerOptions = {
  version: string;
  waitExtension: string; // comfy_node/__init__.py
  web: WebFiles;
  paths?: Paths;
  port?: number; // overrides the config (tests)
  host?: string;
};

export type RunningServer = { app: LocalApp; server: Server; port: number; close(): Promise<void> };

/** Start serving. Rejects with the listen error (EADDRINUSE: another process owns the port). */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const p = opts.paths ?? paths();
  logTo(p.logs);
  let cfg: LocalConfig = loadConfig(p.config);
  const config = () => (cfg = loadConfig(p.config)); // re-read: a hand edit takes effect at once
  const port = opts.port ?? cfg.mcp_port;

  // The selected packs' models download as soon as there is a ComfyUI to put them in, as the Worker
  // seeds Modal after setup: at start, after an install, and when the selection changes.
  const downloadSelected = () => {
    const comfy = machine.comfy;
    if (comfy.state === "external" || comfy.state === "not_installed") return;
    comfy.models.sources(true); // look again: a folder may have appeared
    for (const pack of selectedPacks(config())) if (pack.models?.length) machine.downloads.start(pack.name, pack.models);
  };
  const machine = new Machine({
    paths: p,
    settings: () => config(),
    saveGpu: (gpu) => saveConfig(p.config, { ...config(), gpu }),
    waitExtension: opts.waitExtension,
    onInstalled: downloadSelected,
  });
  await machine.comfy.refresh();

  const app = new LocalApp({
    version: opts.version,
    port,
    config,
    saveConfig: (next) => {
      saveConfig(p.config, next);
      return config();
    },
    machine,
    downloadSelected,
    web: opts.web,
  });

  const server = await listen((req, remote) => app.handle(req, remote), port, opts.host ?? "0.0.0.0");
  const bound = (server.address() as { port: number }).port;
  downloadSelected();
  // LoRAs a model uses are ours, also those configured before uploads were the one way in (v1.3.6).
  const adopted = machine.loraRegistry.adopt(Object.values(config().pack_loras).flat().map((l) => l.name));
  if (adopted.length) log.info(`LoRAs in use, now listed: ${adopted.join(", ")}`);
  log.info(`Comfy-Gen-MCP ${opts.version} serving on port ${bound} (settings: http://127.0.0.1:${bound}/)`);
  return {
    app,
    server,
    port: bound,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await machine.comfy.stop();
    },
  };
}
