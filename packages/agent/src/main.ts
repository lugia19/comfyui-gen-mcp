// The agent process: started at boot by the launcher (through the shim), one per machine (its
// settings port is the lock). It runs the machine (local's Machine: ComfyUI, installs, downloads),
// its settings page on 127.0.0.1, the tray, and the relay connection to the paired Worker.
//
// The launcher's contract (packages/launcher/main.go): COMFY_GEN_OPEN_SETTINGS=1 when the user
// started it by hand, 0 when it started at login or restarts us (the page opens only while
// unpaired, either way: paired, its tray is the sign it runs); exit code
// RESTART_EXIT_CODE asks it to start us again at once (into a newer bundle), 0 to stay stopped.

import { BG_MODELS, FACE_MODELS } from "@comfy-gen/core";
import { agentInstance, setPartSuffix, listen, log, logTo, Machine, machineTray, openExternal, paths, selfRequest, type ExtensionFiles, type Paths, type TrayLook, type WebFiles } from "@comfy-gen/local";
import { AgentApp } from "./app.ts";
import { loadAgentConfig, saveAgentConfig, type AgentConfig } from "./config.ts";
import { agentHandler } from "./handlers.ts";
import { LoraSync } from "./lora-sync.ts";
import { RelayClient } from "./relay-client.ts";
import { Updater, type ShimHost } from "./update.ts";
import { bindWhenFree, launcherPid, watchParent } from "./watchdog.ts";

export const RESTART_EXIT_CODE = 75;
const RESTART_WHEN_QUIET_MS = 10 * 60_000; // an update waits for this long without generations
const RESTART_ASKED_QUIET_MS = 15_000; // one asked for from the page: only a generation's end, and its image fetched

/** An update asked for from the page may restart now: no install running, no generation (and its
 * image fetched), ComfyUI not starting. Model downloads don't count: they resume. */
export function quietForUpdate(machine: Pick<Machine, "install" | "comfy">): boolean {
  return machine.install.state !== "running" && machine.comfy.state !== "starting" && machine.comfy.quietFor() >= RESTART_ASKED_QUIET_MS;
}

export type AgentOptions = {
  version: string;
  waitExtension: ExtensionFiles;
  web: WebFiles;
  tray?: TrayLook;
  paths?: Paths;
  exit?: (code: number) => void;
  /** The shim's offer to check for an update now (a launcher from before v1.22.0: none). */
  host?: ShimHost | null;
};

export type Agent = { app: AgentApp; close(): Promise<void>; restartWhenIdle(tag: string): void };

export async function startAgent(opts: AgentOptions): Promise<Agent> {
  const p = opts.paths ?? agentInstance(paths());
  logTo(p.logs, "agent.log"); // its own: the extension's server.log shares the folder
  if (p.instance) setPartSuffix(p.instance.n);
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
    // Background removal's model and redraw's face detector, for options every call has. The
    // watermark removal's come with the Worker's settings (its download on save, or the first call).
    modelSets: () => [BG_MODELS, FACE_MODELS],
  });
  await machine.comfy.refresh();
  machine.fetchModelSets();

  let client: RelayClient | null = null;
  // Paused from the tray: connected, but not taking image requests (the Worker uses Modal, or says
  // the PC is paused). Not saved: a restart takes requests again, so a forgotten pause cannot
  // quietly send every image to Modal for days.
  let paused = false;
  const settingsUrl = `http://127.0.0.1:${cfg.port}/`;
  // From the tray or the Worker's page (a control op): the same flag, so both show the same. The
  // tray re-reads it every 2 s; the Worker reads it from the fresh hello.
  const setPaused = (value: boolean, from: string) => {
    if (value !== paused) log.info(value ? `Paused from ${from}: not taking image requests` : `Taking image requests again (from ${from})`);
    paused = value;
    client?.refreshHello();
  };
  const sync = new LoraSync({ machine, worker: () => (cfg.worker_url && cfg.secret ? { url: cfg.worker_url, secret: cfg.secret } : null) });
  const handle = agentHandler({
    setPaused: (value) => setPaused(value, "the Worker's page"),
    sync,
    machine,
    setKeepWarm: (minutes) => {
      if (minutes !== cfg.keep_warm_minutes) {
        cfg = { ...cfg, keep_warm_minutes: minutes };
        saveAgentConfig(p, cfg);
      }
    },
    settingsNote: `${settingsUrl} on your PC (the Comfy-Gen tray icon opens it)`,
    // The Worker's page, managing this PC: a call of this page's own API, as if made here.
    page: async (method, path, body) => {
      const resp = await app.handle(selfRequest(cfg.port, `/api${path}`, { method, body }), "127.0.0.1");
      return [resp.status, await resp.text()];
    },
  });
  const updater = new Updater({ version: opts.version, host: opts.host ?? null, restart: (tag) => restartNow(tag) });
  const reconnect = () => {
    client?.stop();
    client = null;
    if (!cfg.worker_url || !cfg.secret) return;
    client = new RelayClient({
      workerUrl: cfg.worker_url,
      secret: cfg.secret,
      handle,
      hello: () => ({ version: opts.version, platform: process.platform, gpu: machine.comfy.install?.gpu ?? cfg.gpu ?? null, comfyui: machine.comfy.state, paused,
        installing: machine.install.state === "running", // ComfyUI being installed now (v1.20.1)
        // What this agent's ComfyUI can do. An agent without a flag predates it (or, before v1.16.0,
        // used a ComfyUI of the user's own): the Worker leaves the step out.
        remove_marks: true, // our extension's mark-removal node
        remove_background: true, // the background_removal model folder (v1.16.0)
        redraw: true, // our extension's redraw nodes (v1.17.0)
        cutout: true, // our extension's cut-out cleanup node (v1.17.3)
        redraw_area: true, // its redraw node crops for prompt_scope "area" (v1.20.0)
        inpaint_control: true, // our extension's inpainting control node, kohya's LLLite (v1.21.0)
        redraw_extend: true, // its redraw nodes grow the canvas for extend (v1.21.0)
        update_now: updater.can, // its page's POST /api/update restarts it into the latest release (v1.22.0)
      }),
      onOpen: () => void sync.sync(),
    });
    client.start();
  };

  // ComfyUI's state and its install, re-sent to the Worker when they change: its setup page waits for
  // this PC to have ComfyUI installed, and shows where it is meanwhile (v1.20.1).
  let lastState = "";
  setInterval(() => {
    const now = `${machine.comfy.state}/${machine.install.state}`;
    if (now !== lastState) {
      lastState = now;
      client?.refreshHello();
    }
  }, 2000).unref();

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
    updater,
    web: opts.web,
  });

  const server = await bindWhenFree(
    () => listen((req, remote) => app.handle(req, remote), cfg.port, "127.0.0.1"),
    () => log.info("The settings port is taken: waiting a few seconds, in case an agent there is stopping"),
  );
  if (!server) {
    // Already running (started at boot, then again by hand): show that one's page while unpaired.
    log.info(`Another agent already runs on this computer (its page: ${settingsUrl}); this one exits`);
    if (!cfg.worker_url && process.env.COMFY_GEN_OPEN_SETTINGS !== "0") openExternal(settingsUrl);
    exit(0);
    throw new Error("already running");
  }
  log.info(`Comfy-Gen agent ${opts.version}${p.instance ? ` (instance ${p.instance.n}, in ${p.instance.dir})` : ""}: settings on ${settingsUrl}`);
  reconnect();
  // Unpaired: pairing and install happen there. Paired, the Worker's page has the settings.
  if (!cfg.worker_url) openExternal(settingsUrl);

  const trouble = () =>
    !cfg.worker_url ? "not paired with a Worker" : client && client.state !== "connected" ? "not connected to your Worker" : null;
  const tray = opts.tray
    ? // Paired and connected: the Worker's Settings, where most settings are (this PC's page there is
      // a click away, in its GPU list); this PC's own page otherwise (pairing, or the Worker
      // unreachable).
      await machineTray(machine, opts.tray, () => (cfg.worker_url && client?.state === "connected" ? `${cfg.worker_url}/#settings` : settingsUrl), trouble, {
        title: () => (paused ? "Resume agent" : "Pause agent"),
        note: () => (paused ? "paused until resumed or restarted" : null),
        onClick: () => setPaused(!paused, "the tray"),
        name: p.instance ? `Comfy-Gen agent ${p.instance.n}` : "Comfy-Gen agent",
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
    updater.ready = tag;
    if (restart) return;
    log.info(`Comfy-Gen agent ${tag} is downloaded; restarting into it once ComfyUI has been unused for ${RESTART_WHEN_QUIET_MS / 60_000} minutes (within a minute if it already has) and the agent isn't paused`);
    restart = setInterval(() => {
      // Not while paused: the pause isn't saved, so restarting would take requests again unasked.
      if (paused || !machine.idleFor(RESTART_WHEN_QUIET_MS)) return;
      clearInterval(restart!);
      void close(`restarting into ${tag}`).then(() => exit(RESTART_EXIT_CODE));
    }, 60_000);
  };
  // Asked for from a page: at once, unless an install or a generation would be cut off. Even while
  // paused (whoever clicked can pause again), and not waiting for model downloads (they resume:
  // the Worker asks again within a minute).
  let asked: NodeJS.Timeout | null = null;
  const restartNow = (tag: string) => {
    if (asked) return;
    log.info(`Restarting into ${tag}, asked for from the page, once no install or generation is running`);
    const tryNow = () => {
      if (!quietForUpdate(machine)) return;
      clearInterval(asked!);
      if (restart) clearInterval(restart);
      void close(`restarting into ${tag}`).then(() => exit(RESTART_EXIT_CODE));
    };
    asked = setInterval(tryNow, 2000);
    tryNow();
  };
  return { app, close, restartWhenIdle };
}
