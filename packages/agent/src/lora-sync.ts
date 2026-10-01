// Copying LoRAs between this PC and the Worker's R2 storage (design §9). The agent posts the LoRA
// files it has to the Worker's /agent/sync; the Worker answers with what to do: files R2 lacks go up
// (chunks to the Worker's upload, as the settings page sends them, each checked against the MD5 R2
// answers), files only R2 has come down (a storage link, resumed with Range), and files deleted
// while this PC was offline are deleted here.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { fetchFile, log, type Machine } from "@comfy-gen/local";
import { AGENT_USER_AGENT } from "./relay-client.ts";

const PARALLEL = 3;
const RETRIES = 5;

export type Push = { name: string; size: number; upload_url: string; chunk_size: number; chunks: number };
export type Pull = { name: string; size: number; url: string };
/** A copy in progress, or one that failed (kept until the next round). */
export type SyncJob = { to: "modal" | "pc"; done: number; total: number; error?: string };

export type LoraSyncOptions = {
  machine: Pick<Machine, "loras" | "loraPaths" | "lorasDir"> & { loraRegistry: { add(name: string): void; delete(name: string): void } };
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
    const plan = (await resp.json()) as { push?: Push[]; pull?: Pull[]; delete?: string[]; errors?: string[] };
    for (const e of plan.errors ?? []) log.warn("LoRA sync:", e);
    for (const name of plan.delete ?? []) {
      try {
        this.o.machine.loraRegistry.delete(name);
        log.info(`LoRA sync: ${name} was deleted on the Worker; deleted here too`);
      } catch (e) {
        log.warn(`LoRA sync: deleting ${name}:`, (e as Error).message);
      }
    }
    const push = plan.push ?? [];
    const pull = plan.pull ?? [];
    this.jobs = {};
    for (const p of push) this.jobs[p.name] = { to: "modal", done: 0, total: p.size };
    for (const p of pull) this.jobs[p.name] = { to: "pc", done: 0, total: p.size };
    let copied = 0;
    const run = async (name: string, copy: () => Promise<void>) => {
      const where = this.jobs[name].to === "pc" ? "this PC" : "Modal";
      const started = Date.now();
      try {
        log.info(`LoRA sync: copying ${name} to ${where}`);
        await copy();
        const mb = (this.jobs[name].total / 1e6).toFixed(1);
        log.info(`LoRA sync: ${name} copied to ${where} (${mb} MB in ${((Date.now() - started) / 1000).toFixed(1)} s)`);
        delete this.jobs[name];
        copied++;
      } catch (e) {
        this.jobs[name].error = (e as Error).message;
        log.warn(`LoRA sync: copying ${name} to ${where} failed:`, (e as Error).message);
      }
    };
    const auth = { Authorization: `Bearer ${worker.secret}` };
    for (const p of push) await run(p.name, () => this.push(p, auth));
    for (const p of pull) {
      // The user's own copy, same name and size (they uploaded a file this PC already had): take it
      // as ours rather than download it again.
      const dest = join(this.o.machine.lorasDir, p.name);
      if (basename(p.name) === p.name && existsSync(dest) && statSync(dest).size === p.size) {
        this.o.machine.loraRegistry.add(p.name);
        delete this.jobs[p.name];
        log.info(`LoRA sync: ${p.name} is already on this PC; using that copy`);
        copied++;
        continue;
      }
      await run(p.name, () => this.pull(p));
    }
    // The Worker hands out a limited number per round: ask again while copies are going through.
    if (copied) this.again = true;
  }

  /** Send a file to an upload in chunks, each checked against the MD5 R2 answers, then finish it. */
  private async push(p: Push, auth: Record<string, string>): Promise<void> {
    const path = this.o.machine.loraPaths()[p.name];
    if (!path) throw new Error("the file is no longer on this PC");
    const job = this.jobs[p.name];
    const parts: { index: number; etag: string }[] = [];
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
          const md5 = createHash("md5").update(buf).digest("hex");
          for (let attempt = 0; ; attempt++) {
            const { etag } = (await (await this.retrying(`${p.upload_url}/${index}`, { method: "PUT", headers: auth, body: buf })).json()) as { etag: string };
            if (etag === md5) break;
            if (attempt >= RETRIES) throw new Error(`chunk ${index} arrived damaged`);
          }
          parts.push({ index, etag: md5 });
          job.done += length;
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, p.chunks) }, worker));
    } finally {
      await fh.close();
    }
    await this.retrying(`${p.upload_url}/finish`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ parts }),
    });
  }

  /** Download a file into our LoRA folder, resuming when a request is cut off. */
  private async pull(p: Pull): Promise<void> {
    if (basename(p.name) !== p.name || !p.name.endsWith(".safetensors")) throw new Error("not a plain LoRA file name");
    const job = this.jobs[p.name];
    const dest = join(this.o.machine.lorasDir, p.name);
    for (let attempt = 0; ; attempt++) {
      try {
        await fetchFile(p.url, dest, {
          size: p.size,
          resume: true,
          onProgress: (done) => (job.done = done),
        });
        this.o.machine.loraRegistry.add(p.name); // ours now: listed, and synced from here on
        return;
      } catch (e) {
        if (attempt >= RETRIES || /HTTP 4\d\d/.test((e as Error).message)) throw e;
        await this.sleep(1000 * 2 ** attempt);
      }
    }
  }

  /** A request to the Worker, retried on network errors and 5xx; a 4xx other than a timeout is final. */
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
