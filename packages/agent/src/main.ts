// The agent process: started at boot by the launcher (through the shim), one per machine (its
// settings port is the lock). It runs the machine (local's Machine: ComfyUI, installs, downloads),
// its settings page on 127.0.0.1, the tray, and the relay connection to the paired Worker.

import { listen, log, logTo, Machine, machineTray, openExternal, paths, type Paths, type TrayColor, type WebFiles } from "@comfy-gen/local";
import { AgentApp } from "./app.ts";
import { loadAgentConfig, saveAgentConfig, type AgentConfig } from "./config.ts";
import { agentHandler } from "./handlers.ts";
import { RelayClient } from "./relay-client.ts";

export type AgentOptions = {
  version: string;
  waitExtension: string;
  web: WebFiles;
  trayIcons?: Record<TrayColor, Uint8Array>;
  paths?: Paths;
  exit?: (code: number) => void;
};

export async function startAgent(opts: AgentOptions): Promise<{ app: AgentApp; close(): Promise<void> }> {
  const p = opts.paths ?? paths();
  logTo(p.logs);
  let cfg: AgentConfig = loadAgentConfig(p);
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  const machine = new Machine({
    paths: p,
    settings: () => cfg,
    saveGpu: (gpu) => {
      cfg = { ...cfg, gpu };
      saveAgentConfig(p, cfg);
    },
    waitExtension: opts.waitExtension,
  });
  await machine.comfy.refresh();

  let client: RelayClient | null = null;
  const settingsUrl = `http://127.0.0.1:${cfg.port}/`;
  const handle = agentHandler({
    machine,
    setKeepWarm: (minutes) => {
      if (minutes !== cfg.keep_warm_minutes) {
        cfg = { ...cfg, keep_warm_minutes: minutes };
        saveAgentConfig(p, cfg);
      }
    },
    settingsNote: `${settingsUrl} on your PC (the Comfy-Gen tray icon opens it)`,
  });
  const reconnect = () => {
    client?.stop();
    client = null;
    if (!cfg.worker_url || !cfg.secret) return;
    client = new RelayClient({
      workerUrl: cfg.worker_url,
      secret: cfg.secret,
      handle,
      hello: () => ({ version: opts.version, platform: process.platform, gpu: machine.comfy.install?.gpu ?? cfg.gpu ?? null, comfyui: machine.comfy.state }),
    });
    client.start();
  };

  const app = new AgentApp({
    version: opts.version,
    port: cfg.port,
    machine,
    config: () => cfg,
    saveConfig: (next) => {
      cfg = next;
      saveAgentConfig(p, cfg);
    },
    reconnect,
    relay: () => client,
    web: opts.web,
  });

  let server;
  try {
    server = await listen((req, remote) => app.handle(req, remote), cfg.port, "127.0.0.1");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    // Already running (started at boot, then again by hand): show that one's page instead.
    log.info("The agent is already running; opening its settings page");
    openExternal(settingsUrl);
    exit(0);
    throw e;
  }
  log.info(`Comfy-Gen agent ${opts.version}: settings on ${settingsUrl}`);
  reconnect();
  if (!cfg.worker_url) openExternal(settingsUrl); // first run: pairing and install happen there

  const trouble = () =>
    !cfg.worker_url ? "not paired with a Worker" : client && client.state !== "connected" ? "not connected to your Worker" : null;
  const tray = opts.trayIcons ? await machineTray(machine, opts.trayIcons, settingsUrl, trouble) : null;

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    client?.stop();
    tray?.stop();
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections();
    await machine.comfy.stop();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => void close().then(() => exit(0)));
  }
  return { app, close };
}
