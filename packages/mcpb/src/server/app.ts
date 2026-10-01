// The MCPB's local server routes, over injected services so every route is tested with fakes.
// Mirrors the Worker's App: the MCP route behind its secret path, the settings app and its /api.
// The machine side (install, ComfyUI, models, LoRAs, folders) is local's Machine, shared with the
// agent; this adds MCP, the pack settings, and the selected packs' model status. The settings side
// answers only this machine's browser (http.ts, fromThisMachine).

import { join } from "node:path";
import {
  Brain, ComfyUIClient, ComfyUIError, McpHandler, Response as CoreResponse, SETTINGS_SCHEMA, UnknownTool,
  builtinPacks, downloadSize, inlineImage, packMetadata, safeEqual, select, groupByTool, textBlock, utf8,
  type Config, type Content, type Outcome, type OutputImage, type Pack, type RequestOptions, type Transport,
} from "@comfy-gen/core";
import {
  bodyJson, checkMachineSettings, error, fromThisMachine, json, log, webFile,
  type LocalConfig, type Machine, type WebFiles,
} from "@comfy-gen/local";
import { LocalHooks } from "./hooks.ts";

export const PACKS = builtinPacks();
const GROUPS = groupByTool(PACKS);
const PACK_METADATA = packMetadata(PACKS);

export const INSTRUCTIONS =
  "Images come back inline, each followed by its saved_path on this computer. Pass a saved_path (or any image path or URL) to edit_image to edit that image.";

/** What the app needs from the process around it. */
export type Services = {
  version: string;
  port: number;
  config(): LocalConfig;
  saveConfig(cfg: Record<string, any>): LocalConfig;
  machine: Machine;
  /** Start downloading the selected packs' missing models (the managed ComfyUI only). */
  downloadSelected(): void;
  web: WebFiles;
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

export function selectedPacks(cfg: Config): Pack[] {
  return select(GROUPS, cfg.pack_selections);
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
    const { machine } = this.s;
    const comfy = machine.comfy;
    const client = () => new ComfyUIClient(new ComfyTransport(() => comfy.url));
    const brain = (c: ComfyUIClient) => new Brain(PACKS, cfg, c, "paths", { hooks: new LocalHooks(machine, c, this.settingsUrl) });
    const specs = brain(client()).specs;
    const served = new Set(specs.map((spec) => spec.name));

    const call = async (name: string, args: Record<string, any>): Promise<[Content[], boolean]> => {
      if (!served.has(name)) throw new UnknownTool(name);
      return comfy.job(async () => {
        const c = client();
        try {
          if (name === "fetch_result") await comfy.ensureRunning();
        } catch (e) {
          if (e instanceof ComfyUIError) return [[textBlock(`Error: ${e.message}`)], true];
          throw e;
        }
        return this.render(await brain(c).call(name, args), c);
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
        content.push(await inlineImage(client, image));
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
    const comfy = this.s.machine.comfy;
    if (comfy.install && comfy.state !== "external") {
      return `saved_path: ${join(comfy.install.dir, image.type, ...image.subfolder.split("/").filter(Boolean), image.filename)}`;
    }
    return `saved_path: ${image.loadValue()}`;
  }

  // ── settings API (the MCPB's part) ────────────────────────────────

  private async api(req: Request, sub: string): Promise<Response> {
    const m = req.method;
    if (sub === "/state" && m === "GET") return json(await this.state());
    if (sub === "/config" && m === "PUT") return this.saveConfig(req);
    if (sub === "/models" && m === "GET") return json({ packs: this.models() });
    if (sub === "/models/seed" && m === "POST") {
      const wanted = (await bodyJson(req)).pack;
      const pack = PACKS.find((p) => p.name === wanted);
      if (!pack) return error(400, "no such pack");
      return json(this.s.machine.downloads.start(pack.name, pack.models ?? []));
    }
    return error(404, "not found");
  }

  private async state() {
    const cfg = this.s.config();
    return {
      mode: "local",
      version: this.s.version,
      connector_url: `http://127.0.0.1:${this.s.port}${cfg.mcp_path}`,
      ...(await this.s.machine.state(cfg.gpu)),
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
    const bad = checkMachineSettings(merged);
    if (bad) return error(400, bad);
    const cfg = this.s.saveConfig(merged);
    this.s.downloadSelected(); // a newly chosen pack starts downloading now, not at its first use
    const warnings = this.missingLoras(cfg);
    if (current.comfyui_url !== cfg.comfyui_url || current.extra_models_dir !== cfg.extra_models_dir) {
      if (this.s.machine.comfy.state === "running") warnings.push("Restart ComfyUI (Setup tab) for the change to take effect.");
    }
    return json({ config: cfg, warnings });
  }

  private models() {
    return selectedPacks(this.s.config()).map((pack: Pack) => ({
      name: pack.name,
      display_name: pack.display_name ?? pack.name,
      tool_name: pack.tool_name,
      size: downloadSize(pack),
      ...this.s.machine.downloads.status(pack.name, pack.models ?? []),
    }));
  }

  private missingLoras(cfg: LocalConfig): string[] {
    if (cfg.comfyui_url) return []; // your own ComfyUI's folders are not ours to see
    const wanted = new Set(Object.values(cfg.pack_loras).flat().map((l) => l.name));
    this.s.machine.loraRegistry.adopt([...wanted]); // in use, so ours (one typed in by hand, say)
    const have = this.s.machine.loras();
    return [...wanted].filter((n) => !(n in have)).map((n) => `The LoRA ${n} is not in any LoRA folder: generations will fail until it is.`);
  }
}
