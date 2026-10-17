// The "Update to vX" button, on this PC's own page and on its row in the Worker's GPU list. The shim
// downloads bundles (it already checks hourly and calls updateReady); its Host lets the button ask
// it now. Then the agent restarts at once instead of after ten quiet minutes. A shim from before
// the Host (a launcher from before v1.22.0) gives none: no button, updates as before.

import { log } from "@comfy-gen/local";

/** The shim's offer (packages/mcpb/src/shim.ts, Host): keep the two in step. */
export type ShimHost = {
  latest(): Promise<string | null>;
  update(): Promise<string | null>;
};

export type UpdateState = "idle" | "downloading" | "restarting" | "failed";

const LATEST_CACHE_MS = 10 * 60_000;

/** vX.Y.Z as numbers; null for anything else (a "dev" build). */
function parse(tag: string | null): number[] | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether *a* is a newer release than *b*. A dev build is never offered an update. */
export function isNewer(a: string | null, b: string): boolean {
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export type UpdaterOptions = {
  version: string;
  host: ShimHost | null;
  /** Restart into the newest bundle on disk once nothing would be cut off (main.ts). */
  restart(tag: string): void;
  now?: () => number;
};

export class Updater {
  state: UpdateState = "idle";
  tag: string | null = null;
  error: string | null = null;
  /** A newer bundle the shim already downloaded (updateReady): it waits for a quiet machine. */
  ready: string | null = null;
  private latestTag: string | null = null;
  private latestAt = -Infinity;
  private readonly o: UpdaterOptions;

  constructor(o: UpdaterOptions) {
    this.o = o;
  }

  get can(): boolean {
    return this.o.host !== null;
  }

  /** The latest release, cached: a page load costs at most one request to GitHub. */
  async latest(): Promise<string | null> {
    const now = (this.o.now ?? Date.now)();
    if (this.o.host && now - this.latestAt >= LATEST_CACHE_MS) {
      this.latestAt = now;
      try {
        this.latestTag = await this.o.host.latest();
      } catch (e) {
        log.warn(`Could not look up the latest release: ${(e as Error).message}`);
      }
    }
    return [this.latestTag, this.ready].reduce<string | null>((a, t) => (isNewer(t, a ?? this.o.version) ? t : a), null);
  }

  async status() {
    const latest = await this.latest();
    return {
      current: this.o.version,
      latest,
      ready: this.ready,
      newer: isNewer(latest, this.o.version),
      can: this.can,
      state: this.state,
      tag: this.tag,
      error: this.error,
    };
  }

  /** Start the update; the answer is at once, the page follows status(). An error string when it
   * can't start. */
  start(): string | null {
    if (!this.o.host) return "This agent's launcher can't update it from here: restart the agent to update it, or run a newer launcher.";
    if (this.state === "downloading" || this.state === "restarting") return null;
    this.state = "downloading";
    this.error = null;
    void this.run(this.o.host);
    return null;
  }

  private async run(host: ShimHost): Promise<void> {
    try {
      let tag = this.ready;
      if (!isNewer(tag, this.o.version)) {
        log.info("Updating from the page: checking for a newer bundle");
        try {
          tag = await host.update();
        } catch (e) {
          log.warn(`The shim's download failed: ${(e as Error).message}`);
          throw new Error(`Couldn't download ${this.latestTag ?? "the new release"} (${(e as Error).message}): try again in a few minutes.`);
        }
      }
      if (!tag || !isNewer(tag, this.o.version)) {
        const latest = this.latestTag;
        throw new Error(
          isNewer(latest, this.o.version)
            ? `${latest} isn't downloadable yet (its release is still being built): try again in a few minutes.` // seconds to minutes after its tag
            : `${this.o.version} is the latest release.`,
        );
      }
      this.tag = tag;
      this.state = "restarting";
      this.o.restart(tag);
    } catch (e) {
      this.state = "failed";
      this.error = (e as Error).message;
      log.warn(`Update failed: ${this.error}`);
    }
  }
}
