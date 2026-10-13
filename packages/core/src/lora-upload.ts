// LoRA uploads (design §4, "LoRAs"): the rules both servers check, the Worker into R2 and the
// machine side into its LoRA folder, and the one client that sends a file, from the settings page
// and from the agent's push.
//
// The protocol: POST {filename, size} opens a session ({id, upload_url, chunk_size, chunks}); PUT
// <upload_url>/<index> sends one chunk, answered with {index, etag}, the etag being the chunk's MD5
// (R2's part ETag, or the machine side's own) for the sender to compare with its own; POST
// <upload_url>/finish {parts} joins them. Chunk sizes are the server's: 8 MiB into R2, 4 MiB through
// a relay.

import { md5 } from "./md5.ts";

export const MAX_LORA_SIZE = 2 * 1024 ** 3; // not 2 << 30: that overflows to a negative 32-bit number
// The same rule as the Modal app's (comfy_gen_modal/uploads.py).
const LORA_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()\-]{0,150}\.safetensors$/;

/** A refused upload request; *status* is the HTTP status to answer with. */
export class UploadError extends Error {
  name = "UploadError";
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const isLoraName = (name: unknown): name is string => typeof name === "string" && LORA_NAME.test(name) && !name.includes("..");

export function validLoraName(name: unknown): string {
  if (!isLoraName(name)) throw new UploadError(`LoRA files must be .safetensors with a plain name: ${JSON.stringify(name)}`);
  return name;
}

/** A new upload's file name and chunk count. Throws UploadError for a bad name or size. */
export function checkUpload(filename: unknown, size: unknown, chunkSize: number): { name: string; chunks: number } {
  const name = validLoraName(filename);
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MAX_LORA_SIZE) throw new UploadError("size must be 1 byte to 2 GB");
  return { name, chunks: Math.ceil(size / chunkSize) };
}

/** How many bytes chunk *index* of an upload of *size* holds. Throws UploadError when out of range. */
export function chunkLength(size: number, chunkSize: number, index: number): number {
  const chunks = Math.ceil(size / chunkSize);
  if (!Number.isInteger(index) || index < 0 || index >= chunks) throw new UploadError(`chunk ${index} out of range (0 to ${chunks - 1})`);
  return Math.min(chunkSize, size - index * chunkSize);
}

export const chunksMissing = (n: number) => new UploadError(`${n} chunk(s) still missing`, 409);

const PARALLEL = 3;
const RETRIES = 5;

export type UploadSession = { upload_url: string; chunk_size: number; chunks: number };

export type SendOptions = {
  size: number;
  /** *length* bytes of the file from *offset*. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** One request (fetch, with the caller's own credentials and headers). */
  request(url: string, init: RequestInit): Promise<Response>;
  /** Extra fields of the finish request (the page's LoRA group). */
  finish?: Record<string, unknown>;
  onProgress?(sent: number): void;
  md5?(bytes: Uint8Array): string;
  sleep?(ms: number): Promise<void>;
};

/**
 * Send a file into an open upload *session*: the chunks, 3 at a time, each sent again until its
 * answer has our MD5, then the finish. Network errors, 5xx, 408 and 429 are retried with backoff
 * (5 times); any other 4xx is the request's fault, and final. Throws an Error with the reason.
 */
export async function sendChunks(session: UploadSession, o: SendOptions): Promise<void> {
  const hash = o.md5 ?? md5;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { upload_url: url, chunk_size: chunkSize, chunks } = session;

  // One request until *good* accepts its answer.
  async function retrying(path: string, init: RequestInit, good: (data: any) => boolean = () => true): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let message: string;
      try {
        const resp = await o.request(path, init);
        status = resp.status;
        const data = (await resp.json().catch(() => ({}))) as Record<string, any>;
        if (resp.ok && good(data)) return;
        message = resp.ok ? "the chunk arrived damaged" : data.error || `HTTP ${status}`;
        if (resp.ok) status = 0; // damaged on the way: send it again
      } catch (e) {
        message = (e as Error).message; // a network error: retry
      }
      const fatal = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (fatal || attempt >= RETRIES) throw new Error(message);
      await sleep(1000 * 2 ** attempt);
    }
  }

  const parts: { index: number; etag: string }[] = [];
  let sent = 0;
  let next = 0;
  const worker = async () => {
    while (next < chunks) {
      const index = next++;
      const bytes = await o.read(index * chunkSize, chunkLength(o.size, chunkSize, index));
      const etag = hash(bytes);
      await retrying(`${url}/${index}`, { method: "PUT", body: bytes as BodyInit }, (d) => d.etag === etag);
      parts.push({ index, etag });
      sent += bytes.length;
      o.onProgress?.(sent);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks) }, worker));
  await retrying(`${url}/finish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...o.finish, parts }) });
}
