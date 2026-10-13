// The local servers' plumbing, shared by the MCPB and the agent: JSON responses, the loopback
// check that guards their settings pages, static files, and node:http to Request/Response.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { error as coreError, json as coreJson } from "@comfy-gen/core";
import { log } from "./log.ts";

export type WebFiles = (path: string) => { body: Uint8Array; type: string } | null;
export type Handler = (req: Request, remote: string) => Promise<Response>;

// Local pages are never cached: a settings page shows the machine's state now.
const NO_STORE = { "Cache-Control": "no-store" };
export const json = (data: unknown, status = 200): Response => coreJson(data, status, NO_STORE);
export const error = (status: number, message: string): Response => coreError(status, message, NO_STORE);
export { bodyJson } from "@comfy-gen/core";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Loopback, and addressed to this server by name, so a web page elsewhere cannot reach a settings
 * API (which installs software and changes files) through DNS rebinding or a cross-site form. */
export function fromThisMachine(req: Request, remote: string): boolean {
  if (!LOOPBACK.has(remote)) return false;
  const host = req.headers.get("host") ?? "";
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) return false;
  const origin = req.headers.get("origin");
  return !origin || origin === `http://${host}`;
}

/** A settings page (the agent's and the MCPB's): this machine's browser only; /api/<sub> to *api*
 * (a crash becomes a 500 with its message), anything else the app's files. */
export async function settingsPage(req: Request, remote: string, web: WebFiles, api: (req: Request, sub: string) => Promise<Response>): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (!fromThisMachine(req, remote)) return error(403, "the settings page answers only on this computer");
  if (!path.startsWith("/api/")) return webFile(web, req, path);
  try {
    return await api(req, path.slice(4));
  } catch (e) {
    log.error(`${req.method} ${path} failed:`, e);
    return error(500, (e as Error).message);
  }
}

/** A request to a local server from its own process, as this machine's browser would send it. */
export const selfRequest = (port: number, path: string, init: { method: string; body?: string }): Request =>
  new Request(`http://127.0.0.1:${port}${path}`, { ...init, headers: { host: `127.0.0.1:${port}`, "Content-Type": "application/json" } });

/** The settings app's files; unknown paths get index.html (the app routes itself). */
export function webFile(web: WebFiles, req: Request, path: string): Response {
  if (req.method !== "GET") return error(405, "method not allowed");
  const file = web(path) ?? web("/index.html");
  if (!file) return error(404, "not found");
  // Never inside another site's frame: the page has no login, and a framed copy acts as this one.
  return new Response(file.body as unknown as BodyInit, {
    headers: { "Content-Type": file.type, "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" },
  });
}

/** Serve *handler* on host:port. Rejects with the listen error (EADDRINUSE: the port is taken). */
export async function listen(handler: Handler, port: number, host: string): Promise<Server> {
  const server = createServer((req, res) => void serve(handler, req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function serve(handler: Handler, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const response = await handler(request, req.socket.remoteAddress ?? "");
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    log.error("Request failed:", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
  }
}
