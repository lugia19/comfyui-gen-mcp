// The managed ComfyUI: started on demand, stopped when idle or on exit, with the model folders,
// our wait extension and the packs' node packages in place. Or a ComfyUI the user runs, at
// comfyui_url, which is only checked, never managed.

import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { ComfyUIError } from "@comfy-gen/core";
import { ModelLocator } from "./discover.ts";
import { findInstall, type Install } from "./install.ts";
import { log } from "./log.ts";
import { publish, writeExtraModelPaths } from "./models.ts";
import { installedNodePackages, installNodePackage, writeWaitExtension } from "./nodes.ts";
import type { Paths } from "./paths.ts";
import { killTree, pythonEnv, start } from "./proc.ts";

export const PREFERRED_PORT = 8188;
const LAUNCH_TIMEOUT_S = 300; // a first start compiles and caches; later ones take seconds

export type ComfyState = "not_installed" | "stopped" | "starting" | "running" | "failed" | "external";

export type ComfySettings = { comfyui_url: string; extra_models_dir: string; keep_warm_minutes: number; gpu: string };

/** True if *port* can be bound on *host* right now. A real bind, which also catches Windows'
 * reserved port ranges (error 10013) that a connect probe misses. */
export function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** A port the OS says is free. */
export function freePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen({ port: 0, host }, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function answers(url: string): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch {
    return false;
  }
}

function tail(path: string, lines = 15): string {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(Math.min(size, 16384));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    closeSync(fd);
    return buf.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export class LocalComfy {
  state: ComfyState = "stopped";
  error: string | null = null;
  url: string | null = null;
  install: Install | null = null;
  /** Called whenever the managed ComfyUI has stopped (asked to, or on its own). */
  onStopped: (() => void) | null = null;
  private child: ChildProcess | null = null;
  private starting: Promise<string> | null = null;
  private objectInfo: Set<string> | null = null;
  private busy = 0;
  // 0: not used since this program started, so an update restarts into it at once (an agent showed
  // the old version for 11 minutes after a newer launcher started it, 2026-10-03).
  private lastUsed = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  private p: Paths;
  private settings: () => ComfySettings;
  private waitExtension: string; // the source of comfy_node/__init__.py
  /** The model folders this ComfyUI reads: its own, then the others on this machine. */
  readonly models: ModelLocator;

  constructor(p: Paths, settings: () => ComfySettings, waitExtension: string) {
    this.p = p;
    this.settings = settings;
    this.waitExtension = waitExtension;
    this.models = new ModelLocator(
      () => ({ models: join(this.install?.dir ?? p.comfyui, "models"), comfy: this.install?.dir ?? null }),
      () => settings().extra_models_dir,
    );
  }

  /** Where this ComfyUI keeps its output, input and temp folders: the install, or a second agent's
   * own folder (agentInstance). */
  get dataDir(): string | null {
    return this.p.instance ? join(this.p.instance.dir, "comfyui") : (this.install?.dir ?? null);
  }

  get logFile(): string {
    return join(this.p.logs, "comfyui.log");
  }

  /** Refresh state without starting anything: is there an install, is it running. */
  async refresh(): Promise<void> {
    const external = this.settings().comfyui_url;
    if (external) {
      this.url = external;
      this.state = "external";
      return;
    }
    if (this.child || this.starting) return;
    this.install = await findInstall(this.p);
    if (!this.install) this.state = "not_installed";
    else if (this.state === "not_installed" || this.state === "external") this.state = "stopped";
  }

  /** The ComfyUI URL, starting the managed ComfyUI if needed. Throws ComfyUIError for the user. */
  async ensureRunning(): Promise<string> {
    const external = this.settings().comfyui_url;
    if (external) {
      this.url = external;
      this.state = "external";
      if (await answers(external)) return external;
      throw new ComfyUIError(`ComfyUI is not answering at ${external} (set in the settings). Start it, or clear the URL to use the managed ComfyUI.`);
    }
    if (this.state === "running" && this.child && this.url) return this.url;
    this.starting ??= this.launch().finally(() => (this.starting = null));
    return this.starting;
  }

  private async launch(): Promise<string> {
    this.install = await findInstall(this.p);
    const inst = this.install;
    if (!inst) {
      this.state = "not_installed";
      throw new ComfyUIError("ComfyUI is not installed yet, so no image can be made. Tell the user to install it from the Comfy-Gen settings page (the tray icon opens it), then ask again.");
    }
    this.state = "starting";
    this.error = null;
    this.objectInfo = null;

    writeWaitExtension(inst, this.waitExtension);
    const sources = this.models.sources(true);
    writeExtraModelPaths(inst.dir, sources.map((s) => s.folders));
    log.info(`Model folders shared with ComfyUI: ${sources.map((s) => `${s.from} (${s.path})`).join("; ") || "none"}`);
    try {
      publish(inst.dir, join(inst.dir, "models"), [...new Set(sources.map((s) => s.path))]);
    } catch (e) {
      log.warn("Could not publish to ~/.comfy-registry:", e);
    }

    const port = (await portFree(PREFERRED_PORT)) ? PREFERRED_PORT : await freePort();
    const url = `http://127.0.0.1:${port}`;
    const args = ["main.py", "--listen", "127.0.0.1", "--port", String(port), "--disable-auto-launch"];
    if ((inst.gpu ?? this.settings().gpu) === "cpu") args.push("--cpu");
    const data = this.p.instance ? this.dataDir! : null;
    if (data) {
      // ComfyUI adds "temp" to --temp-directory itself.
      const dirs = { output: join(data, "output"), input: join(data, "input"), user: join(data, "user") };
      for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
      args.push("--output-directory", dirs.output, "--input-directory", dirs.input, "--temp-directory", data, "--user-directory", dirs.user);
    }
    mkdirSync(this.p.logs, { recursive: true });
    // The previous run's log is kept as comfyui.prev.log: after a crash, the next start would
    // otherwise overwrite the evidence.
    try {
      if (existsSync(this.logFile)) renameSync(this.logFile, join(this.p.logs, "comfyui.prev.log"));
    } catch (e) {
      log.warn("Could not keep the previous comfyui.log:", (e as Error).message); // a leftover ComfyUI holds it
    }
    const fd = openSync(this.logFile, "w");
    log.info(`Starting ComfyUI: ${inst.python} ${args.join(" ")} (in ${inst.dir})`);
    // The wait extension exits ComfyUI when we are gone, however we went (comfy_node, watchdog).
    const child = start(inst.python, args, { cwd: inst.dir, env: pythonEnv({ COMFY_GEN_PARENT_PID: String(process.pid) }), logFd: fd });
    closeSync(fd); // the child has its own handle
    this.child = child;
    let exited: string | null = null;
    child.once("error", (e) => (exited = e.message));
    child.once("exit", (code, signal) => {
      exited ??= `exit code ${code ?? signal}`;
      if (this.child === child) {
        this.child = null;
        if (this.state === "running") {
          log.warn(`ComfyUI stopped on its own (${exited})`);
          this.state = "stopped";
          this.onStopped?.();
        }
      }
    });

    const deadline = Date.now() + LAUNCH_TIMEOUT_S * 1000;
    while (Date.now() < deadline) {
      if (exited) return this.failed(`ComfyUI exited while starting (${exited}).`);
      if (await answers(url)) {
        this.url = url;
        this.state = "running";
        this.lastUsed = Date.now();
        this.armIdle();
        log.info(`ComfyUI is up at ${url}`);
        return url;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    await killTree(child);
    return this.failed(`ComfyUI did not start within ${LAUNCH_TIMEOUT_S} s.`);
  }

  private failed(message: string): never {
    const logTail = tail(this.logFile);
    this.state = "failed";
    this.error = `${message} The end of its log:\n${logTail}`;
    this.child = null;
    log.error(this.error);
    throw new ComfyUIError(`${message} See comfyui.log in the logs folder (settings page); a reinstall often fixes this.\n\n${logTail}`);
  }

  /** Stop the managed ComfyUI, if it runs. */
  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {});
    const child = this.child;
    this.child = null;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    if (child) {
      log.info("Stopping ComfyUI");
      await killTree(child);
      this.onStopped?.();
    }
    if (this.state === "running" || this.state === "starting") this.state = "stopped";
    if (this.state !== "external") this.url = null;
    this.objectInfo = null;
  }

  /** Ask a running ComfyUI to unload its models and drop its caches, which closes the files it
   * holds (a LoRA it used stays open on Windows otherwise). False if it is not running. */
  async free(): Promise<boolean> {
    if (this.state !== "running" || !this.url) return false;
    try {
      const resp = await fetch(`${this.url}/free`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async restart(): Promise<string> {
    await this.stop();
    return this.ensureRunning();
  }

  /** How long nothing has used ComfyUI, in ms: 0 while a job runs. */
  quietFor(): number {
    return this.busy ? 0 : Date.now() - this.lastUsed;
  }

  /** Run *fn* as a job: the idle stop waits for it. */
  async job<T>(fn: () => Promise<T>): Promise<T> {
    this.busy++;
    this.lastUsed = Date.now();
    try {
      return await fn();
    } finally {
      this.busy--;
      this.lastUsed = Date.now();
    }
  }

  private armIdle(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    let checking = false;
    const idle = () => this.state === "running" && !this.busy && Date.now() - this.lastUsed > this.settings().keep_warm_minutes * 60_000;
    this.idleTimer = setInterval(async () => {
      if (checking || !idle()) return;
      checking = true;
      try {
        // A generation that outlived its tool call (it answered with a fetch_result token) is still
        // ComfyUI's work: its queue counts as use.
        if (!(await this.queueEmpty())) {
          this.lastUsed = Date.now();
          return;
        }
        if (!idle()) return;
        log.info(`ComfyUI idle for ${this.settings().keep_warm_minutes} min; stopping it to free the GPU`);
        await this.stop().catch((e) => log.error("Idle stop failed:", e));
      } finally {
        checking = false;
      }
    }, 15_000);
    this.idleTimer.unref();
  }

  /** Whether ComfyUI has nothing running or queued (true when it doesn't answer: nothing to keep). */
  async queueEmpty(): Promise<boolean> {
    if (!this.url) return true;
    try {
      const resp = await fetch(`${this.url}/queue`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return true;
      const q = (await resp.json()) as { queue_running?: unknown[]; queue_pending?: unknown[] };
      return !q.queue_running?.length && !q.queue_pending?.length;
    } catch {
      return true;
    }
  }

  /** The node classes the running ComfyUI has (cached per launch). */
  async nodeClasses(): Promise<Set<string>> {
    if (this.objectInfo) return this.objectInfo;
    const url = await this.ensureRunning();
    const resp = await fetch(`${url}/object_info`, { signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) throw new ComfyUIError(`ComfyUI's /object_info answered HTTP ${resp.status}`);
    this.objectInfo = new Set(Object.keys((await resp.json()) as object));
    return this.objectInfo;
  }

  /** Install the node packages a pack needs ({class_type: package id}) and restart ComfyUI to load
   * them. A ComfyUI the user runs is only told what is missing. */
  async ensureNodes(required: Record<string, string>): Promise<void> {
    const have = await this.nodeClasses();
    const missing = Object.entries(required).filter(([cls]) => !have.has(cls));
    if (!missing.length) return;
    const packages = [...new Set(missing.map(([, pkg]) => pkg))];
    if (this.state === "external" || !this.install) {
      throw new ComfyUIError(`This model needs the custom node package(s) ${packages.join(", ")} in your ComfyUI.`);
    }
    const present = installedNodePackages(this.install);
    const toInstall = packages.filter((pkg) => !present.has(pkg.toLowerCase()));
    if (!toInstall.length) {
      throw new ComfyUIError(
        `The custom node package(s) ${packages.join(", ")} are installed but did not load. See comfyui.log in the logs folder; a reinstall of ComfyUI often fixes this.`,
      );
    }
    for (const pkg of toInstall) {
      try {
        await installNodePackage(this.p, this.install, pkg, (l) => log.info(l));
      } catch (e) {
        throw new ComfyUIError(`Installing the custom node package ${pkg} failed: ${(e as Error).message}`);
      }
    }
    await this.restart();
    const now = await this.nodeClasses();
    const still = missing.filter(([cls]) => !now.has(cls)).map(([cls]) => cls);
    if (still.length) throw new ComfyUIError(`ComfyUI still lacks ${still.join(", ")} after installing ${toInstall.join(", ")}. See comfyui.log.`);
  }
}

