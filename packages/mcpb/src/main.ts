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
import { McpHandler, toolSpecs } from "@comfy-gen/core";
import { loadConfig, log, logTo, machineTray, paths, type Paths, type Tray, type TrayColor, type WebFiles } from "@comfy-gen/local";
import { PACKS } from "./server/app.ts";
import { startServer, type RunningServer } from "./server/server.ts";

export type MainOptions = {
  version: string;
  waitExtension: string;
  web: WebFiles;
  trayIcons?: Record<TrayColor, Uint8Array>; // .ico on Windows, .png elsewhere
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

/** Whether the port's owner is one of ours: /alive answers {version, pid}. The old extension's
 * server (Python) may still hold the port for a few minutes after an upgrade. */
async function ownerIsOurs(port: number): Promise<boolean> {
  let resp: Response;
  try {
    resp = await fetch(`http://127.0.0.1:${port}/alive`, { signal: AbortSignal.timeout(5000) });
  } catch {
    return true; // nobody answered: relaying finds out, and takes over
  }
  try {
    const body = (await resp.json()) as Record<string, unknown>;
    return typeof body.version === "string" && typeof body.pid === "number";
  } catch {
    return false;
  }
}

const FOREIGN_OWNER = (port: number) =>
  `Another program holds port ${port}, probably the previous Comfy-Gen-MCP's server. Quit it from its ` +
  `tray icon (or wait a few minutes for it to stop), then restart Claude Desktop.`;

export async function main(opts: MainOptions): Promise<void> {
  const p = opts.paths ?? paths();
  logTo(p.logs);
  // A crash must leave a line in the log: Claude Desktop only says the extension "exited abnormally".
  if (!opts.stdin) {
    process.on("uncaughtException", (e) => {
      log.error(`Process ${process.pid} crashed:`, e);
      process.exit(1);
    });
    process.on("unhandledRejection", (e) => log.error("Unhandled rejection:", e));
  }
  const stdout = opts.stdout ?? process.stdout;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let owner: RunningServer | null = null;
  let tray: Tray | null = null;
  let closing = false;

  const becomeOwner = async (): Promise<boolean> => {
    if (owner) return true;
    try {
      owner = await startServer({ version: opts.version, waitExtension: opts.waitExtension, web: opts.web, paths: p, openSettings: !opts.stdin });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" || code === "EACCES") return false;
      throw e;
    }
    // (startServer logs "serving on port": Claude Desktop starts several copies, and each takes over
    // in turn as the one before it is ended, so a start shows a few of these within a second.)
    if (opts.trayIcons) void startTray(owner, opts.trayIcons).then((t) => (tray = t));
    return true;
  };

  const startTray = (server: RunningServer, icons: Record<TrayColor, Uint8Array>): Promise<Tray | null> =>
    machineTray(server.app.s.machine, icons, server.app.settingsUrl);

  let foreign = false;
  if (!(await becomeOwner())) {
    const port = loadConfig(p.config).mcp_port;
    foreign = !(await ownerIsOurs(port));
    if (foreign) log.error(FOREIGN_OWNER(port));
    else log.info(`Process ${process.pid} relays to the server on port ${port}`);
  }

  const handle = async (line: string): Promise<Reply> => {
    for (let attempt = 0; ; attempt++) {
      const cfg = loadConfig(p.config);
      if (foreign && !owner) {
        if (await becomeOwner()) continue; // it quit meanwhile
        foreign = !(await ownerIsOurs(cfg.mcp_port));
        // Answer ourselves: initialize and tools/list normally, tool calls with what to do. An
        // error on initialize would only show as a failed extension, the reason buried in logs.
        if (foreign) {
          const message = FOREIGN_OWNER(cfg.mcp_port);
          const handler = new McpHandler("Comfy-Gen-MCP", opts.version, toolSpecs(PACKS, cfg, "paths"), async () => [[{ type: "text", text: `Error: ${message}` }], true]);
          return handler.handle(line);
        }
      }
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
      reply = [502, JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: `Comfy-Gen-MCP is not available: ${(e as Error).message}` } })];
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
