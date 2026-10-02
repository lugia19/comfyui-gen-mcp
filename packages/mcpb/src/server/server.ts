// Starting the MCPB's local server in this process: config, the machine (managed ComfyUI, install,
// downloads; local's Machine), the settings app, and node:http at the configured port: on 127.0.0.1,
// or on every interface when the user lets other computers use the MCP route (mcp_network).
// The port is the single-instance lock: when another extension process holds it, start() fails with
// EADDRINUSE and the caller relays to that one instead (design §2, "The MCPB process").

import { closeSync, openSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { listen, loadConfig, log, logTo, Machine, openExternal, paths, saveConfig, type LocalConfig, type Paths, type WebFiles } from "@comfy-gen/local";
import { withoutLora } from "@comfy-gen/core";
import type { Pack } from "@comfy-gen/core";
import { LocalApp } from "./app.ts";

export type ServerOptions = {
  version: string;
  waitExtension: string; // comfy_node/__init__.py
  web: WebFiles;
  paths?: Paths;
  port?: number; // overrides the config (tests)
  host?: string;
  openSettings?: boolean; // false: never open the browser (tests)
};

export type RunningServer = { app: LocalApp; server: Server; port: number; close(): Promise<void> };

/** Start serving. Rejects with the listen error (EADDRINUSE: another process owns the port). */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const p = opts.paths ?? paths();
  logTo(p.logs);
  let cfg: LocalConfig = loadConfig(p.config);
  const config = () => (cfg = loadConfig(p.config)); // re-read: a hand edit takes effect at once
  const port = opts.port ?? cfg.mcp_port;
  const network = cfg.mcp_network;

  // A model downloads at its first use, or when it is chosen on the settings page. Not every selected
  // one up front: that was 22 GB before the first image on a new install (seen 2026-10-02).
  const download = (packs: Pack[]) => {
    const comfy = machine.comfy;
    if (comfy.state === "external" || comfy.state === "not_installed" || !packs.length) return;
    comfy.models.sources(true); // look again: a folder may have appeared
    for (const pack of packs) if (pack.models?.length) machine.downloads.start(pack.name, pack.models);
  };
  const machine = new Machine({
    paths: p,
    settings: () => config(),
    saveGpu: (gpu) => saveConfig(p.config, { ...config(), gpu }),
    waitExtension: opts.waitExtension,
    onLoraDeleted: (name) => {
      const packLoras = withoutLora(config().pack_loras, name);
      if (packLoras) saveConfig(p.config, { ...config(), pack_loras: packLoras });
    },
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
    download,
    web: opts.web,
    network,
  });

  const server = await listen((req, remote) => app.handle(req, remote), port, opts.host ?? (network ? "0.0.0.0" : "127.0.0.1"));
  const bound = (server.address() as { port: number }).port;
  // LoRAs a model uses are ours, also those configured before uploads were the one way in (v1.3.6).
  const adopted = machine.loraRegistry.adopt(Object.values(config().pack_loras).flat().map((l) => l.name));
  if (adopted.length) log.info(`LoRAs in use, now listed: ${adopted.join(", ")}`);
  log.info(`Comfy-Gen-MCP ${opts.version} serving on port ${bound} in process ${process.pid} (settings: http://127.0.0.1:${bound}/)`);
  // A new install opens its settings page once, as the agent does: nothing else tells a new user
  // where it is (seen 2026-10-02). Claude Desktop starts several copies at once; the marker file,
  // created exclusively, lets only the first open it.
  if (machine.comfy.state === "not_installed" && opts.openSettings !== false) {
    try {
      closeSync(openSync(join(p.home, "settings-opened"), "wx"));
      openExternal(`http://127.0.0.1:${bound}/`);
    } catch {
      // opened before (or another copy is opening it)
    }
  }
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
