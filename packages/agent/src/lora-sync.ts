// Copying LoRAs between this PC and the Worker's Modal Volume (design §9). The agent posts the LoRA
// files it has to the Worker's /agent/sync; the Worker answers with what to copy: files only this PC
// has go up (chunks to an upload session on the Modal app, as the settings page sends them), files
// only the Volume has come down (a download session, resumed past Modal's 150 s request limit). The
// bytes never pass through the Worker. Nothing is deleted.

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { fetchFile, log, type Machine } from "@comfy-gen/local";
import { AGENT_USER_AGENT } from "./relay-client.ts";

const PARALLEL = 3;
const RETRIES = 5;
const ASSEMBLE_POLL_MS = 2000;
const ASSEMBLE_TIMEOUT_MS = 30 * 60_000;

export type Push = { name: string; size: number; upload_url: string; chunk_size: number; chunks: number };
export type Pull = { name: string; size: number; url: string };
/** A copy in progress, or one that failed (kept until the next round). */
export type SyncJob = { to: "modal" | "pc"; done: number; total: number; error?: string };

export type LoraSyncOptions = {
  machine: Pick<Machine, "loras" | "loraPaths" | "lorasDir">;
  worker: () => { url: string; secret: string } | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export class LoraSync {
  jobs: Record<string, SyncJob> = {};
  private o: LoraSyncOptions;
  private running = false;
  private again = false;

  constructor(o: LoraSyncOptions) {
    this.o = o;
  }

  private get fetch(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }

  private sleep(ms: number): Promise<void> {
    return this.o.sleep ? this.o.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** Ask the Worker what to copy, and copy it, a file at a time. A call while one runs makes it go
   * round once more when done (the settings changed meanwhile). Never throws. */
  async sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.round();
      } while (this.again);
    } catch (e) {
      log.warn("LoRA sync:", (e as Error).message);
    } finally {
      this.running = false;
    }
  }

  private async round(): Promise<void> {
    const worker = this.o.worker();
    if (!worker) return;
    const resp = await this.fetch(`${worker.url}/agent/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${worker.secret}`, "User-Agent": AGENT_USER_AGENT, "Content-Type": "application/json" },
      body: JSON.stringify({ loras: this.o.machine.loras() }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) throw new Error(`the Worker answered HTTP ${resp.status}`);
    const plan = (await resp.json()) as { push?: Push[]; pull?: Pull[]; errors?: string[] };
    for (const e of plan.errors ?? []) log.warn("LoRA sync:", e);
    const push = plan.push ?? [];
    const pull = plan.pull ?? [];
    this.jobs = {};
    for (const p of push) this.jobs[p.name] = { to: "modal", done: 0, total: p.size };
    for (const p of pull) this.jobs[p.name] = { to: "pc", done: 0, total: p.size };
    let copied = 0;
    const run = async (name: string, copy: () => Promise<void>) => {
      try {
        log.info(`LoRA sync: copying ${name} to ${this.jobs[name].to === "pc" ? "this PC" : "Modal"}`);
        await copy();
        delete this.jobs[name];
        copied++;
      } catch (e) {
        this.jobs[name].error = (e as Error).message;
        log.warn(`LoRA sync: ${name}:`, (e as Error).message);
      }
    };
    for (const p of push) await run(p.name, () => this.push(p));
    for (const p of pull) await run(p.name, () => this.pull(p));
    // The Worker hands out a limited number per round: ask again while copies are going through.
    if (copied) this.again = true;
  }

  /** Send a file to an upload session in chunks, finish it, and wait until the Volume has it. */
  private async push(p: Push): Promise<void> {
    const path = this.o.machine.loraPaths()[p.name];
    if (!path) throw new Error("the file is no longer on this PC");
    const job = this.jobs[p.name];
    const fh = await open(path, "r");
    try {
      let next = 0;
      const worker = async () => {
        while (next < p.chunks) {
          const index = next++;
          const length = Math.min(p.chunk_size, p.size - index * p.chunk_size);
          const buf = Buffer.alloc(length);
          const { bytesRead } = await fh.read(buf, 0, length, index * p.chunk_size);
          if (bytesRead !== length) throw new Error("the file changed while it was being sent");
          const sha = createHash("sha256").update(buf).digest("hex");
          await this.retrying(`${p.upload_url}/${index}`, { method: "PUT", headers: { "X-Chunk-Sha256": sha }, body: buf });
          job.done += length;
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, p.chunks) }, worker));
    } finally {
      await fh.close();
    }
    await this.retrying(`${p.upload_url}/finish`, { method: "POST" });
    const deadline = Date.now() + ASSEMBLE_TIMEOUT_MS;
    for (;;) {
      const s = (await (await this.retrying(p.upload_url, { method: "GET" })).json()) as { state: string; error?: string };
      if (s.state === "done") return;
      if (s.state === "failed") throw new Error(s.error || "Modal could not assemble the file");
      if (Date.now() > deadline) throw new Error("Modal took too long to assemble the file");
      await this.sleep(ASSEMBLE_POLL_MS);
    }
  }

  /** Download a file into our LoRA folder, resuming when a request is cut off. */
  private async pull(p: Pull): Promise<void> {
    if (basename(p.name) !== p.name || !p.name.endsWith(".safetensors")) throw new Error("not a plain LoRA file name");
    const job = this.jobs[p.name];
    for (let attempt = 0; ; attempt++) {
      try {
        await fetchFile(p.url, join(this.o.machine.lorasDir, p.name), {
          size: p.size,
          resume: true,
          onProgress: (done) => (job.done = done),
        });
        return;
      } catch (e) {
        if (attempt >= RETRIES || /HTTP 4\d\d/.test((e as Error).message)) throw e;
        await this.sleep(1000 * 2 ** attempt);
      }
    }
  }

  /** A request to the Modal app, retried on network errors and 5xx; a 4xx other than a timeout is final. */
  private async retrying(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let message: string;
      let fatal = false;
      try {
        const resp = await this.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), "User-Agent": AGENT_USER_AGENT } });
        if (resp.ok) return resp;
        const body = (await resp.json().catch(() => ({}))) as { error?: string };
        message = body.error || `HTTP ${resp.status}`;
        fatal = resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429;
      } catch (e) {
        message = (e as Error).message;
      }
      if (fatal || attempt >= RETRIES) throw new Error(message);
      await this.sleep(1000 * 2 ** attempt);
    }
  }
}
