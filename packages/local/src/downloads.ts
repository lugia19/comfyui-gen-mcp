// The packs' model files: which are present (in our models folder or a shared one), and a queue
// that downloads the missing ones into ours, one file at a time. Its state feeds the settings
// page and the "still downloading" answer a tool call gets, in the shape the Modal seed reports.

import { join } from "node:path";
import type { ModelLocator } from "./discover.ts";
import { fetchFile } from "./fetchfile.ts";
import { log } from "./log.ts";
import { findModel } from "./models.ts";

export type ModelFile = { filename: string; subfolder: string; url: string; size_bytes?: number; sha256?: string };
export type PackDownload = {
  state: "done" | "missing" | "queued" | "downloading" | "failed";
  done: number; // bytes, of the files that were missing
  total: number;
  file?: string;
  error?: string;
};

type Job = { key: string; files: ModelFile[]; status: PackDownload };

export class ModelDownloads {
  private models: ModelLocator;
  private byKey = new Map<string, Job>();
  private queue: Job[] = [];
  private running = false;

  constructor(models: ModelLocator) {
    this.models = models;
  }

  missing(files: ModelFile[], fresh = false): ModelFile[] {
    const folders = this.models.folders(fresh);
    return files.filter((f) => !findModel(folders, f.subfolder, f.filename));
  }

  /** Where *key*'s files stand. A finished or failed job is reported until the next start(). */
  status(key: string, files: ModelFile[]): PackDownload {
    const job = this.byKey.get(key);
    if (job && job.status.state !== "done") return { ...job.status };
    const missing = this.missing(files);
    if (!missing.length) return { state: "done", done: 0, total: 0 };
    return { state: "missing", done: 0, total: missing.reduce((n, f) => n + (f.size_bytes ?? 0), 0) };
  }

  /** Queue *key*'s missing files, unless they are queued already. Returns the status. */
  start(key: string, files: ModelFile[]): PackDownload {
    const current = this.byKey.get(key);
    if (current && (current.status.state === "queued" || current.status.state === "downloading")) return { ...current.status };
    const missing = this.missing(files);
    if (!missing.length) return { state: "done", done: 0, total: 0 };
    const job: Job = { key, files: missing, status: { state: "queued", done: 0, total: missing.reduce((n, f) => n + (f.size_bytes ?? 0), 0) } };
    this.byKey.set(key, job);
    this.queue.push(job);
    void this.pump();
    return { ...job.status };
  }

  /** Every job since the start: {key, ...status}, for a settings page. */
  jobs(): ({ key: string } & PackDownload)[] {
    return [...this.byKey.values()].map((j) => ({ key: j.key, ...j.status }));
  }

  /** Whether any download ended in failure (and was not started again since). */
  failed(): boolean {
    return [...this.byKey.values()].some((j) => j.status.state === "failed");
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) await this.run(job);
    } finally {
      this.running = false;
    }
  }

  private async run(job: Job): Promise<void> {
    const own = this.models.ownModels;
    job.status.state = "downloading";
    let before = 0;
    for (const f of job.files) {
      if (findModel(this.models.folders(), f.subfolder, f.filename)) {
        before += f.size_bytes ?? 0; // another pack's job fetched it meanwhile
        job.status.done = before;
        continue;
      }
      job.status.file = f.filename;
      log.info(`Downloading ${f.subfolder}/${f.filename} (${((f.size_bytes ?? 0) / 1e9).toFixed(1)} GB) for ${job.key}`);
      try {
        await fetchFile(f.url, join(own, f.subfolder, f.filename), {
          size: f.size_bytes,
          sha256: f.sha256,
          resume: true,
          onProgress: (d) => (job.status.done = before + d),
        });
      } catch (e) {
        job.status = { ...job.status, state: "failed", error: `${f.filename}: ${(e as Error).message}` };
        log.error(`Download for ${job.key} failed:`, e);
        return;
      }
      before += f.size_bytes ?? 0;
      job.status.done = before;
    }
    job.status = { state: "done", done: job.status.total, total: job.status.total };
    log.info(`Models for ${job.key} are downloaded`);
  }
}
