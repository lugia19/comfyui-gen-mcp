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

/** The part of an R2 object the app uses. */
export interface StoredObject {
  key: string;
  size: number;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  range?: { offset?: number; length?: number };
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface MultipartUpload {
  uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | ArrayBufferView): Promise<{ partNumber: number; etag: string }>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<{ size: number }>;
  abort(): Promise<void>;
}

/** The part of an R2 bucket the app uses: the STORE binding in production (design §4). */
export interface Bucket {
  get(key: string, options?: { range?: Headers }): Promise<StoredObject | null>;
  head(key: string): Promise<{ key: string; size: number } | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | null,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<{ size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string; size: number }[]; truncated: boolean; cursor?: string }>;
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<{ uploadId: string }>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;
}

export type Platform = {
  storage: StateStorage;
  bucket: Bucket | null; // R2: images and LoRAs; null until R2 is turned on in the account
  relays: (id: string) => RelayStub; // a PC's Relay Durable Object, named after its GPU id
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
