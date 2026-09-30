// The agent process: started at boot by the launcher (through the shim), one per machine (its
// settings port is the lock). It runs the machine (local's Machine: ComfyUI, installs, downloads),
// its settings page on 127.0.0.1, the tray, and the relay connection to the paired Worker.
//
// The launcher's contract (packages/launcher/main.go): COMFY_GEN_OPEN_SETTINGS=1 when the user
// started it by hand (open the settings page), 0 when it started at login or restarts us; exit code
// RESTART_EXIT_CODE asks it to start us again at once (into a newer bundle), 0 to stay stopped.

import { listen, log, logTo, Machine, machineTray, openExternal, paths, type Paths, type TrayColor, type WebFiles } from "@comfy-gen/local";
import { AgentApp } from "./app.ts";
import { loadAgentConfig, saveAgentConfig, type AgentConfig } from "./config.ts";
import { agentHandler } from "./handlers.ts";
import { LoraSync } from "./lora-sync.ts";
import { RelayClient } from "./relay-client.ts";
import { launcherPid, watchParent } from "./watchdog.ts";

export const RESTART_EXIT_CODE = 75;
const RESTART_WHEN_QUIET_MS = 10 * 60_000; // an update waits for this long without generations

export type AgentOptions = {
  version: string;
  waitExtension: string;
  web: WebFiles;
  trayIcons?: Record<TrayColor, Uint8Array>;
  paths?: Paths;
  exit?: (code: number) => void;
};

export type Agent = { app: AgentApp; close(): Promise<void>; restartWhenIdle(tag: string): void };

export async function startAgent(opts: AgentOptions): Promise<Agent> {
  const p = opts.paths ?? paths();
  const openSettings = process.env.COMFY_GEN_OPEN_SETTINGS;
  logTo(p.logs);
  // So an ending always leaves a line in the log (one once ended with none).
  process.on("uncaughtException", (e) => {
    log.error("Uncaught:", e);
    exit(1);
  });
  process.on("unhandledRejection", (e) => log.error("Unhandled rejection:", e));
  process.on("exit", (code) => log.info(`Exiting (code ${code})`));
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
  // Paused from the tray: connected, but not taking image requests (the Worker uses Modal, or says
  // the PC is paused). Not saved: a restart takes requests again, so a forgotten pause cannot
  // quietly send every image to Modal for days.
  let paused = false;
  const settingsUrl = `http://127.0.0.1:${cfg.port}/`;
  const sync = new LoraSync({ machine, worker: () => (cfg.worker_url && cfg.secret ? { url: cfg.worker_url, secret: cfg.secret } : null) });
  const handle = agentHandler({
    sync,
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
      hello: () => ({ version: opts.version, platform: process.platform, gpu: machine.comfy.install?.gpu ?? cfg.gpu ?? null, comfyui: machine.comfy.state, paused }),
      onOpen: () => void sync.sync(),
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
    paused: () => paused,
    web: opts.web,
  });

  let server;
  try {
    server = await listen((req, remote) => app.handle(req, remote), cfg.port, "127.0.0.1");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    // Already running (started at boot, then again by hand): show that one's page instead.
    log.info("The agent is already running");
    if (openSettings !== "0") openExternal(settingsUrl);
    exit(0);
    throw e;
  }
  log.info(`Comfy-Gen agent ${opts.version}: settings on ${settingsUrl}`);
  reconnect();
  // Unpaired, pairing and install happen there; started by hand, the user expects to see something.
  if (!cfg.worker_url || openSettings === "1") openExternal(settingsUrl);

  const trouble = () =>
    !cfg.worker_url ? "not paired with a Worker" : client && client.state !== "connected" ? "not connected to your Worker" : null;
  const tray = opts.trayIcons
    ? await machineTray(machine, opts.trayIcons, settingsUrl, trouble, {
        title: () => (paused ? "Take image requests again" : "Stop taking image requests"),
        note: () => (paused ? "not taking requests" : null),
        onClick: () => {
          paused = !paused;
          log.info(paused ? "Paused: not taking image requests" : "Taking image requests again");
          client?.refreshHello();
        },
      })
    : null;

  let closing = false;
  const close = async (reason = "asked to") => {
    if (closing) return;
    closing = true;
    log.info(`Stopping (${reason})`);
    client?.stop();
    tray?.stop();
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections();
    await machine.comfy.stop();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => void close(signal).then(() => exit(0)));
  }
  const launcher = launcherPid();
  if (launcher) watchParent(launcher, () => void close("the launcher ended").then(() => exit(0)));

  let restart: NodeJS.Timeout | null = null;
  const restartWhenIdle = (tag: string) => {
    if (restart) return;
    log.info(`Comfy-Gen agent ${tag} is downloaded; restarting into it once nothing has run for ${RESTART_WHEN_QUIET_MS / 60_000} minutes`);
    restart = setInterval(() => {
      if (!machine.idleFor(RESTART_WHEN_QUIET_MS)) return;
      clearInterval(restart!);
      void close(`restarting into ${tag}`).then(() => exit(RESTART_EXIT_CODE));
    }, 60_000);
  };
  return { app, close, restartWhenIdle };
}
