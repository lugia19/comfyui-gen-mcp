// The local server's routes, over injected services so every route is tested with fakes; server.ts
// adapts node:http to it. Mirrors the Worker's App: the MCP route behind its secret path, the
// settings app and its /api. The settings side installs software and changes files, so it answers
// only this machine's browser (loopback address, and a Host and Origin of this server).

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  Brain, ComfyUIClient, ComfyUIError, McpHandler, Response as CoreResponse, SETTINGS_SCHEMA, UnknownTool,
  builtinPacks, downloadSize, inlineImage, packMetadata, safeEqual, select, groupByTool, textBlock, utf8,
  type Config, type Content, type Outcome, type OutputImage, type Pack, type RequestOptions, type Transport,
} from "@comfy-gen/core";
import { GPUS, isGpu, log, type LocalComfy, type LocalConfig, type ModelDownloads, type Paths } from "@comfy-gen/local";
import { LocalHooks } from "./hooks.ts";

export const PACKS = builtinPacks();
const GROUPS = groupByTool(PACKS);
const PACK_METADATA = packMetadata(PACKS);

export const INSTRUCTIONS =
  "Images come back inline, each followed by its saved_path on this computer. Pass a saved_path (or any image path or URL) to edit_image to edit that image.";

export type InstallState = { state: "idle" | "running" | "done" | "failed"; gpu: string | null; lines: string[]; error: string | null };

/** What the app needs from the process around it. */
export type Services = {
  paths: Paths;
  version: string;
  port: number;
  config(): LocalConfig;
  saveConfig(cfg: Record<string, any>): LocalConfig;
  comfy: LocalComfy;
  downloads: ModelDownloads;
  modelDirs(): string[]; // ours first
  install: { state(): InstallState; start(gpu: string): void };
  detectedGpu(): Promise<string>;
  web(path: string): { body: Uint8Array; type: string } | null;
  openFolder(path: string): void;
};

/** ComfyUI over fetch at whatever URL the managed or configured ComfyUI has now. */
export class ComfyTransport implements Transport {
  private url: () => string | null;
  constructor(url: () => string | null) {
    this.url = url;
  }
  async request(method: string, path: string, opts: RequestOptions = {}): Promise<CoreResponse> {
    const base = this.url();
    if (!base) return new CoreResponse(503, utf8("ComfyUI is not running"));
    const query = opts.params ? "?" + new URLSearchParams(opts.params).toString() : "";
    try {
      const resp = await fetch(base + path + query, { method, headers: opts.headers, body: opts.body as unknown as BodyInit | undefined });
      return new CoreResponse(resp.status, new Uint8Array(await resp.arrayBuffer()));
    } catch (e) {
      return new CoreResponse(503, utf8(String(e)));
    }
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

const error = (status: number, message: string) => json({ error: message }, status);

async function bodyJson(req: Request): Promise<Record<string, any>> {
  try {
    const data = JSON.parse((await req.text()) || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export class LocalApp {
  readonly s: Services;

  constructor(services: Services) {
    this.s = services;
  }

  get settingsUrl(): string {
    return `http://127.0.0.1:${this.s.port}/`;
  }

  /** *remote* is the client's address. */
  async handle(req: Request, remote: string): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path.startsWith("/mcp/")) return this.mcp(req, path);
    if (path === "/alive") return json({ version: this.s.version, pid: process.pid });
    if (!this.fromThisMachine(req, remote)) return error(403, "the settings page answers only on this computer");
    if (path.startsWith("/api/")) {
      try {
        return await this.api(req, path.slice(4));
      } catch (e) {
        log.error(`${req.method} ${path} failed:`, e);
        return error(500, (e as Error).message);
      }
    }
    if (req.method !== "GET") return error(405, "method not allowed");
    const file = this.s.web(path) ?? this.s.web("/index.html"); // the app routes itself
    if (!file) return error(404, "not found");
    return new Response(file.body as unknown as BodyInit, { headers: { "Content-Type": file.type } });
  }

  /** Loopback, and addressed to this server by name (so a web page elsewhere cannot reach the API
   * through DNS rebinding or a cross-site form). */
  private fromThisMachine(req: Request, remote: string): boolean {
    if (!LOOPBACK.has(remote)) return false;
    const host = req.headers.get("host") ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) return false;
    const origin = req.headers.get("origin");
    return !origin || origin === `http://${host}`;
  }

  // ── MCP ───────────────────────────────────────────────────────────

  private async mcp(req: Request, path: string): Promise<Response> {
    const cfg = this.s.config();
    if (!safeEqual(path.replace(/\/+$/, ""), cfg.mcp_path)) return error(404, "not found");
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const handler = this.mcpHandler(cfg);
    const [status, body] = await handler.handle(await req.text());
    if (body === null) return new Response(null, { status });
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }

  /** The MCP handler for *cfg*. Also what the shim answers tools/list from. */
  mcpHandler(cfg: LocalConfig): McpHandler {
    const comfy = this.s.comfy;
    const client = () => new ComfyUIClient(new ComfyTransport(() => comfy.url));
    const brain = (c: ComfyUIClient, inventory: Set<string> | null = null) =>
      new Brain(PACKS, cfg, c, "paths", { hooks: new LocalHooks(comfy, this.s.downloads, c, this.settingsUrl), inventory });
    const specs = brain(client()).specs;
    const served = new Set(specs.map((spec) => spec.name));

    const call = async (name: string, args: Record<string, any>): Promise<[Content[], boolean]> => {
      if (!served.has(name)) throw new UnknownTool(name);
      return comfy.job(async () => {
        const c = client();
        let inventory: Set<string> | null = null;
        try {
          // A custom workflow is checked against what this ComfyUI has; packs install their nodes.
          if (name === "generate_custom_image") inventory = await comfy.nodeClasses();
          if (name === "fetch_result") await comfy.ensureRunning();
        } catch (e) {
          if (e instanceof ComfyUIError) return [[textBlock(`Error: ${e.message}`)], true];
          throw e;
        }
        return this.render(await brain(c, inventory).call(name, args), c);
      });
    };
    return new McpHandler("Comfy-Gen-MCP", this.s.version, specs, call, INSTRUCTIONS);
  }

  private async render(outcome: Outcome, client: ComfyUIClient): Promise<[Content[], boolean]> {
    if (outcome.kind === "pending") return [[textBlock(outcome.text())], false];
    if (outcome.kind === "failed") return [[textBlock(outcome.text())], true];
    const content: Content[] = [];
    for (const image of outcome.images) {
      try {
        content.push(await inlineImage(client, image, outcome.lossless));
      } catch (e) {
        if (!(e instanceof ComfyUIError)) throw e;
        return [[textBlock(`Error: the image was generated but could not be fetched: ${e.message}`)], true];
      }
      content.push(textBlock(this.savedPath(image)));
    }
    return [content, false];
  }

  /** Where the result is on disk; for a ComfyUI we don't manage, the name it knows it by. */
  private savedPath(image: OutputImage): string {
    const inst = this.s.comfy.install;
    if (inst && this.s.comfy.state !== "external") {
      return `saved_path: ${join(inst.dir, image.type, ...image.subfolder.split("/").filter(Boolean), image.filename)}`;
    }
    return `saved_path: ${image.loadValue()}`;
  }

  // ── settings API ──────────────────────────────────────────────────

  private async api(req: Request, sub: string): Promise<Response> {
    const m = req.method;
    if (sub === "/state" && m === "GET") return json(await this.state());
    if (sub === "/config" && m === "PUT") return this.saveConfig(req);
    if (sub === "/setup/install" && m === "POST") {
      const gpu = (await bodyJson(req)).gpu;
      if (!isGpu(gpu)) return error(400, `gpu must be one of ${GPUS.join(", ")}`);
      if (this.s.install.state().state === "running") return error(409, "an install is already running");
      this.s.install.start(gpu);
      return json(this.s.install.state());
    }
    if (sub === "/setup/install" && m === "GET") return json(this.s.install.state());
    if (sub === "/comfyui/restart" && m === "POST") return this.comfyAction(() => this.s.comfy.restart());
    if (sub === "/comfyui/stop" && m === "POST") return this.comfyAction(() => this.s.comfy.stop());
    if (sub === "/models" && m === "GET") return json({ packs: this.models() });
    if (sub === "/models/seed" && m === "POST") {
      const wanted = (await bodyJson(req)).pack;
      const pack = PACKS.find((p) => p.name === wanted);
      if (!pack) return error(400, "no such pack");
      return json(this.s.downloads.start(pack.name, pack.models ?? []));
    }
    if (sub === "/loras" && m === "GET") return json({ loras: this.loras() });
    if (sub === "/open" && m === "POST") {
      const which = (await bodyJson(req)).which;
      const dirs: Record<string, string> = { models: this.s.modelDirs()[0], logs: this.s.paths.logs };
      dirs.loras = join(dirs.models, "loras");
      if (this.s.comfy.install) dirs.output = join(this.s.comfy.install.dir, "output");
      if (!(which in dirs)) return error(400, "unknown folder");
      this.s.openFolder(dirs[which]);
      return json({ ok: true, path: dirs[which] });
    }
    return error(404, "not found");
  }

  private async state() {
    const comfy = this.s.comfy;
    await comfy.refresh();
    const cfg = this.s.config();
    return {
      mode: "local",
      version: this.s.version,
      connector_url: `http://127.0.0.1:${this.s.port}${cfg.mcp_path}`,
      comfyui: {
        state: comfy.state,
        url: comfy.url,
        error: comfy.error,
        dir: comfy.install?.dir ?? null,
        gpu: comfy.install?.gpu ?? (cfg.gpu || null),
        version: comfy.install?.version ?? null,
      },
      install: this.s.install.state(),
      gpus: GPUS,
      detected_gpu: await this.s.detectedGpu(),
      config: cfg,
      schema: SETTINGS_SCHEMA,
      packs: PACK_METADATA,
    };
  }

  private async saveConfig(req: Request): Promise<Response> {
    const incoming = (await bodyJson(req)).config;
    if (!incoming || typeof incoming !== "object") return error(400, "config must be an object");
    const current = this.s.config();
    // The secret path and the port are not the page's to change.
    const merged = { ...current, ...incoming, mcp_path: current.mcp_path, mcp_port: current.mcp_port };
    const url = String(merged.comfyui_url ?? "").trim();
    if (url && !/^https?:\/\/[^\s/]+/.test(url)) return error(400, "the ComfyUI URL must be an http(s) URL");
    const extra = String(merged.extra_models_dir ?? "").trim();
    if (extra && (!existsSync(extra) || !statSync(extra).isDirectory())) return error(400, `${extra} is not a folder`);
    const cfg = this.s.saveConfig(merged);
    const warnings = this.missingLoras(cfg);
    if (current.comfyui_url !== cfg.comfyui_url || current.extra_models_dir !== cfg.extra_models_dir) {
      if (this.s.comfy.state === "running") warnings.push("Restart ComfyUI (Setup tab) for the change to take effect.");
    }
    return json({ config: cfg, warnings });
  }

  private async comfyAction(fn: () => Promise<unknown>): Promise<Response> {
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof ComfyUIError)) throw e;
      return error(502, e.message);
    }
    return json({ state: this.s.comfy.state, url: this.s.comfy.url });
  }

  private models() {
    return select(GROUPS, this.s.config().pack_selections).map((pack: Pack) => ({
      name: pack.name,
      display_name: pack.display_name ?? pack.name,
      tool_name: pack.tool_name,
      size: downloadSize(pack),
      ...this.s.downloads.status(pack.name, pack.models ?? []),
    }));
  }

  /** LoRA files ComfyUI can load: {name: size}, ours first, then the shared folders'. */
  private loras(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const dir of this.s.modelDirs()) {
      const d = join(dir, "loras");
      if (!existsSync(d)) continue;
      for (const name of readdirSync(d)) {
        if (name.endsWith(".safetensors") && !(name in out)) out[name] = statSync(join(d, name)).size;
      }
    }
    return out;
  }

  private missingLoras(cfg: Config): string[] {
    const have = this.loras();
    const wanted = new Set(Object.values(cfg.pack_loras).flat().map((l) => l.name));
    return [...wanted].filter((n) => !(n in have)).map((n) => `The LoRA ${n} is not in any LoRA folder: generations will fail until it is.`);
  }
}
