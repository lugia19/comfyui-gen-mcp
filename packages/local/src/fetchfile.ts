// Downloading one file to disk: streamed into a .part file, checked, then renamed into place.

import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export const USER_AGENT = "comfy-gen-local";

export type Progress = (done: number, total: number | null) => void;

/** Download *url* to *dest*. Throws on an HTTP error, a size or SHA-256 mismatch, or *signal*;
 * nothing is left at *dest* unless the file is complete and checked. Returns the file's SHA-256. */
export async function fetchFile(
  url: string,
  dest: string,
  opts: { sha256?: string; size?: number; onProgress?: Progress; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<string> {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...opts.headers }, signal: opts.signal, redirect: "follow" });
  if (!resp.ok || !resp.body) throw new Error(`${url}: HTTP ${resp.status}`);
  const header = Number(resp.headers.get("content-length"));
  const total = opts.size ?? (header > 0 ? header : null);
  const hash = createHash("sha256");
  const out = createWriteStream(part);
  let done = 0;
  try {
    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      opts.onProgress?.(done, total);
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    const digest = hash.digest("hex");
    if (opts.size !== undefined && done !== opts.size) throw new Error(`${url}: got ${done} bytes, expected ${opts.size}`);
    if (opts.sha256 && digest !== opts.sha256.toLowerCase()) throw new Error(`${url}: checksum mismatch`);
    renameSync(part, dest);
    return digest;
  } catch (e) {
    out.destroy();
    rmSync(part, { force: true });
    throw e;
  }
}
