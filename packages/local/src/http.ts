// The local servers' plumbing, shared by the MCPB and the agent: JSON responses, the loopback
// check that guards their settings pages, static files, and node:http to Request/Response.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { log } from "./log.ts";

export type WebFiles = (path: string) => { body: Uint8Array; type: string } | null;
export type Handler = (req: Request, remote: string) => Promise<Response>;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export const error = (status: number, message: string) => json({ error: message }, status);

export async function bodyJson(req: Request): Promise<Record<string, any>> {
  try {
    const data = JSON.parse((await req.text()) || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

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

/** The settings app's files; unknown paths get index.html (the app routes itself). */
export function webFile(web: WebFiles, req: Request, path: string): Response {
  if (req.method !== "GET") return error(405, "method not allowed");
  const file = web(path) ?? web("/index.html");
  if (!file) return error(404, "not found");
  return new Response(file.body as unknown as BodyInit, { headers: { "Content-Type": file.type } });
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
