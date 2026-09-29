// What a Claude Desktop extension process runs (design §2, "The MCPB process"). Every process
// tries to bind the port: the one that does owns the server (MCP, settings, tray, ComfyUI) in
// process; the others relay their stdio messages to it over HTTP. When the owner exits, the next
// relay that finds it gone binds the port and becomes the owner.
//
// stdio: newline-delimited JSON-RPC in, one line out per request (notifications get nothing).
// Requests are handled concurrently: a ping must not wait behind a four-minute generation.

import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { loadConfig, log, logTo, openExternal, paths, type Paths } from "@comfy-gen/local";
import type { Services } from "./server/app.ts";
import { startServer, type RunningServer } from "./server/server.ts";
import { Tray } from "./tray.ts";

export type MainOptions = {
  version: string;
  waitExtension: string;
  web: Services["web"];
  trayIcon?: Uint8Array; // .ico on Windows, .png elsewhere
  paths?: Paths;
  stdin?: Readable;
  stdout?: Writable;
  exit?: (code: number) => void;
};

type Reply = [status: number, body: string | null];

/** POST to the owner. Rejects with the socket error when nobody listens (or the owner died before
 * answering); no timeout, as a tool call may take minutes. */
function relay(port: number, path: string, body: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve([res.statusCode ?? 502, chunks.length ? Buffer.concat(chunks).toString("utf8") : null]));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function main(opts: MainOptions): Promise<void> {
  const p = opts.paths ?? paths();
  logTo(p.logs);
  const stdout = opts.stdout ?? process.stdout;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let owner: RunningServer | null = null;
  let tray: Tray | null = null;
  let closing = false;

  const becomeOwner = async (): Promise<boolean> => {
    if (owner) return true;
    try {
      owner = await startServer({ version: opts.version, waitExtension: opts.waitExtension, web: opts.web, paths: p });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" || code === "EACCES") return false;
      throw e;
    }
    log.info(`Process ${process.pid} owns the server`);
    if (opts.trayIcon) void startTray(owner, opts.trayIcon).then((t) => (tray = t));
    return true;
  };

  const startTray = async (server: RunningServer, icon: Uint8Array): Promise<Tray | null> => {
    const comfy = server.app.s.comfy;
    const status = () => `ComfyUI: ${comfy.state.replace("_", " ")}`;
    const t = await Tray.start(p, icon, "Comfy-Gen-MCP", [
      { title: "Open settings", onClick: () => openExternal(server.app.settingsUrl) },
      { title: status(), enabled: false },
      { title: "Restart ComfyUI", onClick: () => void comfy.restart().catch((e) => log.error("Restart failed:", e)) },
      { title: "Stop ComfyUI", onClick: () => void comfy.stop() },
    ]);
    if (t) setInterval(() => t.update(1, { title: status(), enabled: false }), 3000).unref();
    return t;
  };

  if (!(await becomeOwner())) log.info(`Process ${process.pid} relays to the server on port ${loadConfig(p.config).mcp_port}`);

  const handle = async (line: string): Promise<Reply> => {
    for (let attempt = 0; ; attempt++) {
      const cfg = loadConfig(p.config);
      if (owner) {
        const req = new Request(`http://127.0.0.1:${owner.port}${cfg.mcp_path}`, {
          method: "POST",
          body: line,
          headers: { host: `127.0.0.1:${owner.port}`, "Content-Type": "application/json" },
        });
        const resp = await owner.app.handle(req, "127.0.0.1");
        return [resp.status, resp.status === 202 ? null : await resp.text()];
      }
      try {
        return await relay(cfg.mcp_port, cfg.mcp_path, line);
      } catch (e) {
        // The owner is gone (or went mid-request): take over, or wait for whoever did.
        if (await becomeOwner()) continue;
        if (attempt >= 20) throw e;
        await sleep(250 * Math.min(attempt + 1, 8));
      }
    }
  };

  const answer = async (line: string) => {
    let id: unknown = null;
    try {
      id = JSON.parse(line)?.id ?? null;
    } catch {
      // the handler answers the parse error
    }
    let reply: Reply;
    try {
      reply = await handle(line);
    } catch (e) {
      log.error("Could not reach the Comfy-Gen server:", e);
      reply = [502, JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: `Comfy-Gen server unreachable: ${(e as Error).message}` } })];
    }
    const [, body] = reply;
    if (body !== null && id !== null && !closing) stdout.write(body.replace(/\n/g, " ") + "\n");
  };

  const shutdown = async (why: string) => {
    if (closing) return;
    closing = true;
    log.info(`Shutting down (${why})`);
    tray?.stop();
    try {
      await owner?.close(); // stops ComfyUI
    } catch (e) {
      log.error("Shutdown failed:", e);
    }
    exit(0);
  };

  const rl = createInterface({ input: opts.stdin ?? process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (line.trim()) void answer(line);
  });
  rl.on("close", () => void shutdown("stdin closed"));
  if (!opts.stdin) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void shutdown(signal));
  }
}
