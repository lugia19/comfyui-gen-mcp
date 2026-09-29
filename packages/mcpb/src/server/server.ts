// Starting the local server in this process: config, the managed ComfyUI, the download queue, the
// settings app, and node:http on 0.0.0.0 at the configured port. The port is the single-instance
// lock: when another extension process holds it, start() fails with EADDRINUSE and the caller
// relays to that one instead (design §2, "The MCPB process").

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  detectGpu, install, isGpu, loadConfig, LocalComfy, log, logTo, ModelDownloads, paths, saveConfig, sharedModelDirs,
  type LocalConfig, type Paths,
} from "@comfy-gen/local";
import { LocalApp, type InstallState, type Services } from "./app.ts";

export type ServerOptions = {
  version: string;
  waitExtension: string; // comfy_node/__init__.py
  web: Services["web"];
  paths?: Paths;
  port?: number; // overrides the config (tests)
  host?: string;
};

export type RunningServer = { app: LocalApp; server: Server; port: number; close(): Promise<void> };

function openFolder(path: string): void {
  const cmd = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [path], { detached: true, stdio: "ignore", windowsHide: false }).on("error", (e) => log.warn(`Could not open ${path}:`, e.message)).unref();
}

/** Start serving. Rejects with the listen error (EADDRINUSE: another process owns the port). */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const p = opts.paths ?? paths();
  logTo(p.logs);
  let cfg: LocalConfig = loadConfig(p.config);
  const config = () => (cfg = loadConfig(p.config)); // re-read: a hand edit takes effect at once
  const port = opts.port ?? cfg.mcp_port;

  const comfy = new LocalComfy(p, () => config(), opts.waitExtension);
  await comfy.refresh();
  const modelDirs = () => {
    const own = join(comfy.install?.dir ?? p.comfyui, "models");
    return [own, ...sharedModelDirs(own, cfg.extra_models_dir)];
  };
  const downloads = new ModelDownloads(modelDirs);

  let installState: InstallState = { state: "idle", gpu: null, lines: [], error: null };
  const startInstall = (gpu: string) => {
    if (!isGpu(gpu)) throw new Error(`unknown GPU kind ${gpu}`);
    installState = { state: "running", gpu, lines: [], error: null };
    const onLine = (l: string) => {
      log.info(`[install] ${l}`);
      installState.lines.push(l);
      if (installState.lines.length > 200) installState.lines.splice(0, 100);
    };
    (async () => {
      await comfy.stop();
      await install(p, gpu, onLine);
      saveConfig(p.config, { ...config(), gpu });
      await comfy.refresh();
      installState.state = "done";
    })().catch((e) => {
      log.error("Install failed:", e);
      installState = { ...installState, state: "failed", error: (e as Error).message };
      void comfy.refresh();
    });
  };
  let gpuGuess: Promise<string> | null = null;

  const app = new LocalApp({
    paths: p,
    version: opts.version,
    port,
    config,
    saveConfig: (next) => {
      saveConfig(p.config, next);
      return config();
    },
    comfy,
    downloads,
    modelDirs,
    install: { state: () => installState, start: startInstall },
    detectedGpu: () => (gpuGuess ??= detectGpu()),
    web: opts.web,
    openFolder,
  });

  const server = createServer((req, res) => void serve(app, req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: opts.host ?? "0.0.0.0", exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = (server.address() as { port: number }).port;
  log.info(`Comfy-Gen-MCP ${opts.version} serving on port ${bound} (settings: http://127.0.0.1:${bound}/)`);
  return {
    app,
    server,
    port: bound,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await comfy.stop();
    },
  };
}

/** node:http to the app's Request/Response. */
async function serve(app: LocalApp, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await app.handle(request, req.socket.remoteAddress ?? "");
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    log.error("Request failed:", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
  }
}
