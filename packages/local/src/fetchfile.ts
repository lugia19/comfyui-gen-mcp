// Downloading one file to disk: streamed into a .part file, checked, then renamed into place.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const USER_AGENT = "comfy-gen-local";

export type Progress = (done: number, total: number | null) => void;

// The unfinished file is <dest>.part, or <dest>.part-<n> in a second agent on this machine
// (agentInstance), so two agents fetching the same model or LoRA never write into one file: each
// downloads its own, and the rename into place is atomic.
let partSuffix = ".part";
export function setPartSuffix(instance: number): void {
  partSuffix = `.part-${instance}`;
}

export type FetchFileOptions = {
  sha256?: string;
  size?: number;
  onProgress?: Progress;
  signal?: AbortSignal;
  /** Continue a .part file left by an interrupted download (for multi-GB models). */
  resume?: boolean;
};

/** A write error in words: a full disk says so. */
function diskError(e: Error, dest: string): Error {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOSPC" ? new Error(`the disk is full (writing ${dest})`) : e;
}

/** Bytes free on the disk holding *dir* (or its nearest existing parent), or null if unknown. */
export function freeBytes(dir: string): number | null {
  let d = dir;
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  try {
    const s = statfsSync(d);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Download *url* to *dest*. Throws on an HTTP error, a size or SHA-256 mismatch, or *signal*;
 * nothing is left at *dest* unless the file is complete and checked. Returns the file's SHA-256. */
export async function fetchFile(url: string, dest: string, opts: FetchFileOptions = {}): Promise<string> {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}${partSuffix}`;
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
  // A write error (a full disk) arrives as an event, and a failed stream never drains: waiting only
  // for "drain" hung the download for good, with nothing logged (seen 2026-10-02).
  let writeError: Error | null = null;
  out.on("error", (e) => (writeError ??= diskError(e, dest)));
  const writable = () =>
    new Promise<void>((resolve) => {
      const go = () => (out.off("drain", go), out.off("error", go), resolve());
      out.once("drain", go);
      out.once("error", go);
    });
  try {
    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
      if (writeError) throw writeError;
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await writable();
      if (writeError) throw writeError;
      opts.onProgress?.(done, total);
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(diskError(e, dest)) : resolve())));
  } catch (e) {
    if (writeError) {
      out.destroy(); // nothing more can be written; for a resume, what reached the disk stays
      if (!opts.resume) rmSync(part, { force: true });
    } else if (opts.resume) {
      // A resumable download keeps what it has: flush it, or the bytes still buffered are lost.
      await new Promise<void>((resolve) => out.end(() => resolve()));
    } else {
      out.destroy();
      rmSync(part, { force: true });
    }
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
