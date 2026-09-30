// One machine's generator, as the MCPB and the agent both run it: the managed ComfyUI (or the
// user's), its install, model downloads and model folders, making a pack ready, and the settings
// routes for all that. The MCPB adds MCP and pack settings on top; the agent adds the relay.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ComfyUIError, downloadSize } from "@comfy-gen/core";
import { LocalComfy, type ComfySettings } from "./comfyui.ts";
import { ModelDownloads, type ModelFile } from "./downloads.ts";
import { bodyJson, error, json } from "./http.ts";
import { detectGpu, GPUS, install, isGpu } from "./install.ts";
import { log } from "./log.ts";
import { LoraRegistry, LoraUploads, UploadError } from "./lora-uploads.ts";
import type { Paths } from "./paths.ts";
import { openExternal } from "./proc.ts";

export type InstallState = { state: "idle" | "running" | "done" | "failed"; gpu: string | null; lines: string[]; error: string | null };

/** What ensurePack needs of a pack (the agent receives exactly this from the Worker). */
export type PackNeeds = { name: string; display_name?: string; models?: ModelFile[]; required_nodes?: Record<string, string> };

export type MachineOptions = {
  paths: Paths;
  settings: () => ComfySettings;
  /** Remember the GPU kind an install was made for. */
  saveGpu: (gpu: string) => void;
  waitExtension: string; // comfy_node/__init__.py
  /** After a successful install (the MCPB starts its selected packs' downloads). */
  onInstalled?: () => void;
  openFolder?: (path: string) => void;
  comfy?: LocalComfy; // tests pass a stand-in
};

export class Machine {
  readonly p: Paths;
  readonly comfy: LocalComfy;
  readonly downloads: ModelDownloads;
  /** Our LoRAs (design §4: one way in), and uploads of new ones. */
  readonly loraRegistry: LoraRegistry;
  readonly uploads: LoraUploads;
  private opts: MachineOptions;
  private installState: InstallState = { state: "idle", gpu: null, lines: [], error: null };
  private gpuGuess: Promise<string> | null = null;

  constructor(opts: MachineOptions) {
    this.opts = opts;
    this.p = opts.paths;
    this.comfy = opts.comfy ?? new LocalComfy(opts.paths, opts.settings, opts.waitExtension);
    this.downloads = new ModelDownloads(this.comfy.models);
    this.loraRegistry = new LoraRegistry(join(this.p.home, "loras.json"), () => this.lorasDir);
    this.uploads = new LoraUploads(this.loraRegistry, () => this.lorasDir);
  }

  get install(): InstallState {
    return this.installState;
  }

  /** Nothing running or used for *ms*: no install, no model download, no ComfyUI job. */
  idleFor(ms: number): boolean {
    if (this.installState.state === "running" || this.comfy.state === "starting") return false;
    if (this.downloads.jobs().some((j) => j.state === "queued" || j.state === "downloading")) return false;
    return this.comfy.quietFor() >= ms;
  }

  detectedGpu(): Promise<string> {
    return (this.gpuGuess ??= detectGpu());
  }

  /** Install (or reinstall) ComfyUI for *gpu*, in the background; install() reports progress. */
  startInstall(gpu: string): void {
    if (!isGpu(gpu)) throw new Error(`unknown GPU kind ${gpu}`);
    const state: InstallState = { state: "running", gpu, lines: [], error: null };
    this.installState = state;
    const onLine = (l: string) => {
      log.info(`[install] ${l}`);
      state.lines.push(l);
      if (state.lines.length > 200) state.lines.splice(0, 100);
    };
    (async () => {
      await this.comfy.stop();
      await install(this.p, gpu, onLine);
      this.opts.saveGpu(gpu);
      await this.comfy.refresh();
      state.state = "done";
      this.opts.onInstalled?.();
    })().catch((e) => {
      log.error("Install failed:", e);
      state.state = "failed";
      state.error = (e as Error).message;
      void this.comfy.refresh();
    });
  }

  /** Make ComfyUI ready for a pack: installed, its models here (downloads start otherwise, and the
   * error says how far they are), running, its node packages installed. Throws ComfyUIError. */
  async ensurePack(pack: PackNeeds, settingsUrl: string): Promise<void> {
    const comfy = this.comfy;
    await comfy.refresh();
    if (comfy.state === "not_installed") await comfy.ensureRunning(); // throws: install first
    const models = pack.models ?? [];
    if (comfy.state !== "external" && models.length) {
      const name = pack.display_name ?? pack.name;
      let status = this.downloads.status(pack.name, models);
      if (status.state === "missing" || status.state === "failed") status = this.downloads.start(pack.name, models);
      if (status.state !== "done") {
        const pct = status.total ? Math.floor((100 * status.done) / status.total) : 0;
        const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
        const size = downloadSize({ models } as any);
        const part = status.total < size ? ` (the rest of its ${gb(size)} is already on this computer)` : "";
        throw new ComfyUIError(
          `The ${name} model is downloading: ${pct}% of ${gb(status.total)}${part}. ` +
            `Try again when it is done; progress is on the settings page, ${settingsUrl}`,
        );
      }
    }
    await comfy.ensureRunning();
    await comfy.ensureNodes(pack.required_nodes ?? {});
  }

  /** Our LoRAs: {name: size}. Only uploaded or synced ones, never others in the same folders. */
  loras(): Record<string, number> {
    return this.loraRegistry.sizes();
  }

  /** Our LoRAs: {name: path}. */
  loraPaths(): Record<string, string> {
    return this.loraRegistry.paths();
  }

  /** Our own LoRA folder, where new ones go. */
  get lorasDir(): string {
    return join(this.comfy.models.ownModels, "loras");
  }

  /** The machine's part of a settings page's state. */
  async state(gpuSetting = "") {
    const comfy = this.comfy;
    await comfy.refresh();
    return {
      comfyui: {
        state: comfy.state,
        url: comfy.url,
        error: comfy.error,
        dir: comfy.install?.dir ?? null,
        gpu: comfy.install?.gpu ?? (gpuSetting || null),
        version: comfy.install?.version ?? null,
      },
      install: this.installState,
      gpus: GPUS,
      detected_gpu: await this.detectedGpu(),
      model_sources:
        comfy.state === "not_installed"
          ? []
          : comfy.models.sources().map((src) => ({ from: src.from, path: src.path, folders: Object.entries(src.folders).map(([type, dirs]) => ({ type, dirs })) })),
    };
  }

  /** LoRA uploads and deletes from this machine's own settings page (the relay has the same, as
   * control operations, in the agent's handlers). */
  private async loraApi(req: Request, sub: string): Promise<Response | null> {
    const m = req.method;
    const up = /^\/loras\/uploads\/([\w-]+)(?:\/(\d+|finish))?$/.exec(sub);
    try {
      if (sub === "/loras/uploads" && m === "POST") {
        const body = await bodyJson(req);
        const session = this.uploads.start(body.filename, body.size);
        return json({ ...session, upload_url: `/api/loras/uploads/${session.id}` });
      }
      if (up && up[2] === "finish" && m === "POST") return json(this.uploads.finish(up[1]));
      if (up && up[2] && m === "PUT") {
        const data = new Uint8Array(await req.arrayBuffer());
        return json(await this.uploads.chunk(up[1], Number(up[2]), data, req.headers.get("x-chunk-sha256")));
      }
      if (up && !up[2] && m === "GET") return json(this.uploads.status(up[1]));
      if (!up && m === "DELETE") {
        const name = decodeURIComponent(sub.slice("/loras/".length));
        this.loraRegistry.delete(name);
        log.info(`LoRA deleted: ${name}`);
        return json({ deleted: name });
      }
    } catch (e) {
      if (e instanceof UploadError) return error(e.status, e.message);
      throw e;
    }
    return null;
  }

  /** The shared settings routes (under /api), or null for a route that is not one of them. */
  async api(req: Request, sub: string): Promise<Response | null> {
    const m = req.method;
    if (sub === "/setup/install" && m === "POST") {
      const gpu = (await bodyJson(req)).gpu;
      if (!isGpu(gpu)) return error(400, `gpu must be one of ${GPUS.join(", ")}`);
      if (this.installState.state === "running") return error(409, "an install is already running");
      this.startInstall(gpu);
      return json(this.installState);
    }
    if (sub === "/setup/install" && m === "GET") return json(this.installState);
    if (sub === "/comfyui/restart" && m === "POST") return this.comfyAction(() => this.comfy.restart());
    if (sub === "/comfyui/stop" && m === "POST") return this.comfyAction(() => this.comfy.stop());
    if (sub === "/loras" && m === "GET") return json({ loras: this.loras() });
    if (sub === "/loras" || sub.startsWith("/loras/")) {
      const r = await this.loraApi(req, sub);
      if (r) return r;
    }
    if (sub === "/open" && m === "POST") {
      const which = (await bodyJson(req)).which;
      const dirs: Record<string, string> = { models: this.comfy.models.ownModels, logs: this.p.logs };
      dirs.loras = this.lorasDir;
      if (this.comfy.install) dirs.output = join(this.comfy.install.dir, "output");
      if (!(which in dirs)) return error(400, "unknown folder");
      (this.opts.openFolder ?? openExternal)(dirs[which]);
      return json({ ok: true, path: dirs[which] });
    }
    return null;
  }

  private async comfyAction(fn: () => Promise<unknown>): Promise<Response> {
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof ComfyUIError)) throw e;
      return error(502, e.message);
    }
    return json({ state: this.comfy.state, url: this.comfy.url });
  }
}

/** The machine settings a page may change (comfyui_url, extra_models_dir), checked. Returns an error
 * message, or null. */
export function checkMachineSettings(cfg: Record<string, any>): string | null {
  const url = String(cfg.comfyui_url ?? "").trim();
  if (url && !/^https?:\/\/[^\s/]+/.test(url)) return "the ComfyUI URL must be an http(s) URL";
  const extra = String(cfg.extra_models_dir ?? "").trim();
  if (extra && (!existsSync(extra) || !statSync(extra).isDirectory())) return `${extra} is not a folder`;
  return null;
}
