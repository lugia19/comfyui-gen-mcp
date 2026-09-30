// What the app needs from its host. index.ts builds the real one over Cloudflare's runtime; tests
// build fakes. Everything else in src/ is plain TypeScript over these, tested in Node.

import type { Fetch } from "@comfy-gen/core";
import type { RelayStub } from "./relay.ts";

export type { Fetch };

/** String key-value storage: the State Durable Object in production. */
export interface StateStorage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export type Platform = {
  storage: StateStorage;
  relay?: RelayStub; // the Relay Durable Object (the PC path); tests without a PC leave it out
  fetch: Fetch;
  now: () => number; // seconds
  env: Record<string, string | undefined>; // VERSION; DEV_WORKER_HOST under wrangler dev
  sleep?: (seconds: number) => Promise<void>; // tests make the ComfyUI client's waits instant
};

// Sent on every outbound request: GitHub's API refuses requests without one.
export const USER_AGENT = "comfy-gen-worker";

export function withUserAgent(fetch: Fetch): Fetch {
  return (url, init = {}) => fetch(url, { ...init, headers: { "User-Agent": USER_AGENT, ...(init.headers as Record<string, string>) } });
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

/** The request body as a JSON object, or {} if it isn't one. */
export async function bodyJson(req: Request): Promise<Record<string, any>> {
  try {
    const data = JSON.parse((await req.text()) || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}
