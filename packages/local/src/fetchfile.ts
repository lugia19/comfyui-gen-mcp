// Downloading one file to disk: streamed into a .part file, checked, then renamed into place.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const USER_AGENT = "comfy-gen-local";

export type Progress = (done: number, total: number | null) => void;

export type FetchFileOptions = {
  sha256?: string;
  size?: number;
  onProgress?: Progress;
  signal?: AbortSignal;
  /** Continue a .part file left by an interrupted download (for multi-GB models). */
  resume?: boolean;
};

/** Download *url* to *dest*. Throws on an HTTP error, a size or SHA-256 mismatch, or *signal*;
 * nothing is left at *dest* unless the file is complete and checked. Returns the file's SHA-256. */
export async function fetchFile(url: string, dest: string, opts: FetchFileOptions = {}): Promise<string> {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const hash = createHash("sha256");
  let done = 0;
  const have = opts.resume && existsSync(part) ? statSync(part).size : 0;
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (have && (opts.size === undefined || have < opts.size)) headers.Range = `bytes=${have}-`;
  const resp = await fetch(url, { headers, signal: opts.signal, redirect: "follow" });
  if (!resp.ok || !resp.body) throw new Error(`${url}: HTTP ${resp.status}`);
  const resumed = resp.status === 206;
  if (resumed) {
    for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer); // the bytes we keep
    done = have;
  }
  const header = Number(resp.headers.get("content-length"));
  const total = opts.size ?? (header > 0 ? header + done : null);
  const out = createWriteStream(part, { flags: resumed ? "a" : "w" });
  try {
    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      opts.onProgress?.(done, total);
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    if (!opts.resume) rmSync(part, { force: true }); // a resumable download keeps what it has
    throw e;
  }
  const digest = hash.digest("hex");
  const bad =
    opts.size !== undefined && done !== opts.size ? `got ${done} bytes, expected ${opts.size}`
    : opts.sha256 && digest !== opts.sha256.toLowerCase() ? "checksum mismatch"
    : null;
  if (bad) {
    rmSync(part, { force: true }); // a bad file must not be resumed
    throw new Error(`${url}: ${bad}`);
  }
  renameSync(part, dest);
  return digest;
}
