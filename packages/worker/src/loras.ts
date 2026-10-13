// LoRAs in R2 (design §4, "LoRAs"): the one copy every GPU takes its LoRAs from, under
// lora/<name>, never expiring.
//
// In: the settings page (and an agent with LoRAs R2 lacks) uploads a file in fixed 8 MiB chunks, a
// multipart upload streamed through the Worker. R2 answers each part with its MD5 as the ETag; the
// uploader compares it with its own, so the Worker hashes nothing. The uploader sends the parts
// back to finish.
// Out: a GPU downloads from /store/<token> (refs.mintStore: the object and an expiry), with Range,
// so a cut download resumes.

import { checkUpload, chunkLength, chunksMissing, refs, UploadError } from "@comfy-gen/core";
import type { Bucket } from "./platform.ts";
import type { Store } from "./store.ts";

export const LORA_CHUNK = 8 * 1024 * 1024; // R2 wants equal parts but the last, each at least 5 MiB
const SESSION_S = 24 * 3600; // a bucket rule drops multipart uploads left unfinished after a day

export const loraKey = (name: string) => `lora/${name}`;

/** {name: size} of the LoRAs in R2. */
export async function stored(bucket: Bucket): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "lora/", cursor });
    for (const o of page.objects) out[o.key.slice("lora/".length)] = o.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

type Session = { name: string; uploadId: string; size: number; chunks: number; expires: number };

export class LoraUploads {
  private bucket: Bucket;
  private store: Store;
  private now: () => number;

  constructor(bucket: Bucket, store: Store, now: () => number) {
    this.bucket = bucket;
    this.store = store;
    this.now = now;
  }

  private async session(id: string): Promise<Session> {
    const s = (await this.store.loraUploads())[id] as Session | undefined;
    if (!s || s.expires < this.now()) throw new UploadError("unknown or expired upload", 404);
    return s;
  }

  /** A new upload of *name*: {id, chunk_size, chunks}. */
  async start(filename: unknown, size: unknown): Promise<{ id: string; chunk_size: number; chunks: number }> {
    const { name: file, chunks } = checkUpload(filename, size, LORA_CHUNK);
    const { uploadId } = await this.bucket.createMultipartUpload(loraKey(file), { httpMetadata: { contentType: "application/octet-stream" } });
    const id = refs.newImageId() + refs.newImageId();
    const now = this.now();
    const expired = Object.fromEntries(
      Object.entries(await this.store.loraUploads()).filter(([, s]) => (s as Session).expires < now).map(([k]) => [k, null]),
    );
    const s: Session = { name: file, uploadId, size: size as number, chunks, expires: now + SESSION_S };
    await this.store.updateLoraUploads({ ...expired, [id]: s });
    return { id, chunk_size: LORA_CHUNK, chunks: s.chunks };
  }

  /** Chunk *index* (from 0), streamed into its part: {index, etag}, the ETag being its MD5. */
  async chunk(id: string, index: number, req: Request): Promise<{ index: number; etag: string }> {
    const s = await this.session(id);
    const expected = chunkLength(s.size, LORA_CHUNK, index);
    if (Number(req.headers.get("content-length")) !== expected || !req.body) throw new UploadError(`chunk ${index} must be ${expected} bytes`);
    const part = await this.bucket.resumeMultipartUpload(loraKey(s.name), s.uploadId).uploadPart(index + 1, req.body);
    return { index, etag: part.etag.replace(/"/g, "") };
  }

  /** Join the parts the uploader names ([{index, etag}], as chunk() answered): {state, name}. */
  async finish(id: string, parts: unknown): Promise<{ state: "done"; name: string; size: number }> {
    const s = await this.session(id);
    const list = Array.isArray(parts) ? parts : [];
    if (list.length !== s.chunks) throw chunksMissing(s.chunks - list.length);
    const named = list.map((p: any) => ({ partNumber: Number(p?.index) + 1, etag: String(p?.etag ?? "") }));
    try {
      await this.bucket.resumeMultipartUpload(loraKey(s.name), s.uploadId).complete(named);
    } catch (e) {
      throw new UploadError(`R2 could not join the chunks: ${(e as Error).message}`, 409);
    }
    await this.store.updateLoraUploads({ [id]: null });
    return { state: "done", name: s.name, size: s.size };
  }
}

/** GET /store/<token>: a stored object, whole or a Range of it (206), streamed. */
export async function serveStored(bucket: Bucket, key: string, req: Request): Promise<Response> {
  const obj = await bucket.get(key, { range: req.headers });
  if (!obj) return new Response("not found", { status: 404 });
  const headers = { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", ETag: obj.httpEtag };
  if (req.headers.has("range") && obj.range) {
    const offset = obj.range.offset ?? 0;
    const length = obj.range.length ?? obj.size - offset;
    return new Response(obj.body, {
      status: 206,
      headers: { ...headers, "Content-Length": String(length), "Content-Range": `bytes ${offset}-${offset + length - 1}/${obj.size}` },
    });
  }
  return new Response(obj.body, { headers: { ...headers, "Content-Length": String(obj.size) } });
}
