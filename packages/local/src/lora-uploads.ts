// LoRAs on this machine, one way in (design §4): every LoRA the app knows came through an upload
// (from a settings page, or through the Worker's relay for a PC without Modal) or was copied here by
// the agent's sync. They are named in a registry; other LoRAs in the same folders (a user's own
// ComfyUI has plenty, many not for our models) are never listed, synced or configured.
//
// Uploads speak the Modal app's chunked protocol (web/src/lib/upload.js): start a session, send
// chunks with their SHA-256, finish. Chunks are written at their offsets into a .part-upload file;
// finishing checks that every one arrived and renames it into place. Sessions live in memory: a
// restart loses an upload in progress, and the page says so.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";

export const LORA_CHUNK_SIZE = 4 << 20; // relayed through the Worker: well under its request limits
const MAX_SIZE = 2 * 1024 ** 3; // not 2 << 30: that overflows to a negative 32-bit number
const SESSION_MS = 24 * 3600 * 1000;
// The same rule as the Modal app's (comfy_gen_modal/uploads.py).
const LORA_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()\-]{0,150}\.safetensors$/;

export class UploadError extends Error {
  name = "UploadError";
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function validLoraName(name: unknown): string {
  if (typeof name !== "string" || !LORA_NAME.test(name) || name.includes("..")) {
    throw new UploadError(`LoRA files must be .safetensors with a plain name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** The LoRAs that are ours: names in a JSON file, files in *dir*. */
export class LoraRegistry {
  private file: string;
  private dir: () => string;

  constructor(file: string, dir: () => string) {
    this.file = file;
    this.dir = dir;
  }

  private names(): string[] {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(data) ? data.filter((n) => typeof n === "string") : [];
    } catch {
      return [];
    }
  }

  private save(names: string[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify([...new Set(names)].sort()));
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** {name: path} of our LoRAs that are on disk. */
  paths(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of this.names()) {
      const path = join(this.dir(), name);
      if (existsSync(path)) out[name] = path;
    }
    return out;
  }

  /** {name: size} of our LoRAs that are on disk. */
  sizes(): Record<string, number> {
    return Object.fromEntries(Object.entries(this.paths()).map(([name, path]) => [name, statSync(path).size]));
  }

  add(name: string): void {
    this.save([...this.names(), validLoraName(name)]);
  }

  /** Delete one of ours: the file and its entry. Other files by that name are not ours to touch. */
  delete(name: string): void {
    const names = this.names();
    if (!names.includes(name)) throw new UploadError(`no LoRA named ${name}`, 404);
    rmSync(join(this.dir(), name), { force: true });
    this.save(names.filter((n) => n !== name));
  }
}

type Session = {
  id: string;
  filename: string;
  size: number;
  chunks: number;
  received: Set<number>;
  state: "uploading" | "done" | "failed";
  error?: string;
  expires: number;
};

export class LoraUploads {
  private sessions = new Map<string, Session>();
  private registry: LoraRegistry;
  private dir: () => string;

  constructor(registry: LoraRegistry, dir: () => string) {
    this.registry = registry;
    this.dir = dir;
  }

  private part(s: Session): string {
    return join(this.dir(), `${s.filename}.part-upload`);
  }

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.expires < Date.now()) throw new UploadError("unknown or expired upload (was the agent restarted?)", 404);
    return s;
  }

  start(filename: unknown, size: unknown): { id: string; chunk_size: number; chunks: number } {
    const name = validLoraName(filename);
    if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MAX_SIZE) {
      throw new UploadError(`size must be 1 byte to 2 GB`);
    }
    for (const [id, s] of this.sessions) if (s.expires < Date.now()) this.sessions.delete(id);
    const s: Session = {
      id: randomBytes(32).toString("base64url"), filename: name, size, chunks: Math.ceil(size / LORA_CHUNK_SIZE),
      received: new Set(), state: "uploading", expires: Date.now() + SESSION_MS,
    };
    mkdirSync(this.dir(), { recursive: true });
    writeFileSync(this.part(s), ""); // chunks are written into it at their offsets
    this.sessions.set(s.id, s);
    return { id: s.id, chunk_size: LORA_CHUNK_SIZE, chunks: s.chunks };
  }

  /** Store one chunk. Idempotent: a retried chunk overwrites the same bytes. */
  async chunk(id: string, index: number, data: Uint8Array, sha256: string | null): Promise<{ ok: true; index: number }> {
    const s = this.session(id);
    if (s.state !== "uploading") throw new UploadError(`upload is ${s.state}`, 409);
    if (!Number.isInteger(index) || index < 0 || index >= s.chunks) throw new UploadError(`chunk ${index} out of range (0 to ${s.chunks - 1})`);
    const expected = Math.min(LORA_CHUNK_SIZE, s.size - index * LORA_CHUNK_SIZE);
    if (data.length !== expected) throw new UploadError(`chunk ${index} has ${data.length} bytes, expected ${expected}`);
    if (!sha256 || createHash("sha256").update(data).digest("hex") !== sha256.toLowerCase()) {
      throw new UploadError(`chunk ${index} checksum mismatch`);
    }
    const fh = await open(this.part(s), "r+");
    try {
      await fh.write(data, 0, data.length, index * LORA_CHUNK_SIZE);
    } finally {
      await fh.close();
    }
    s.received.add(index);
    return { ok: true, index };
  }

  finish(id: string): { state: string } {
    const s = this.session(id);
    if (s.state !== "uploading") return { state: s.state };
    const missing = s.chunks - s.received.size;
    if (missing) throw new UploadError(`${missing} chunk(s) still missing`, 409);
    const part = this.part(s);
    if (statSync(part).size !== s.size) {
      rmSync(part, { force: true });
      s.state = "failed";
      s.error = "the file's size does not match";
      return { state: s.state };
    }
    renameSync(part, join(this.dir(), s.filename));
    this.registry.add(s.filename);
    s.state = "done";
    return { state: s.state };
  }

  status(id: string): { filename: string; size: number; state: string; done: number; error?: string } {
    const s = this.session(id);
    const done = Math.min(s.size, s.received.size * LORA_CHUNK_SIZE);
    return { filename: s.filename, size: s.size, state: s.state, done, ...(s.error ? { error: s.error } : {}) };
  }
}
