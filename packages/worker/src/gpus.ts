// The GPUs a Worker sends calls to (design §2, "GPUs"): one list in priority order, kept in the
// secrets as `gpus`. Each is plain compute; images and LoRAs live in R2.
//   modal  the Modal app the build deployed: ComfyUI over HTTP, scaled to zero, cold starts
//   pc     a PC running the agent, reached over its own Relay Durable Object (named after its id)
//   url    a ComfyUI the Worker can reach directly (advanced)
// A call goes to the first enabled GPU that is online, not paused, and has the call's pack ready;
// if none has it ready, to the first that is available (which starts the download and says so).

import { tokenUrlsafe } from "@comfy-gen/core";

export type GpuKind = "modal" | "pc" | "url";

export type Gpu = {
  id: string;
  kind: GpuKind;
  name: string;
  enabled: boolean;
  keep_warm_minutes: number;
  // modal and url
  base_url?: string;
  admin_url?: string | null;
  headers?: Record<string, string>;
  cold_start_s?: number;
  // pc
  secret?: string;
  seen?: number | null; // first time it connected: until then the page shows the pairing steps
};

export const DEFAULT_KEEP_WARM = 5;
export const KIND_NAMES: Record<GpuKind, string> = { modal: "Modal", pc: "PC", url: "ComfyUI" };

/** The GPU list in *secrets*, or, for a Worker from before the list (2026-10-01), the one built from
 * its `generator` and `agent_secret` (the PC first, as calls went): converted says which. The PC
 * keeps the id "pc", its Relay object's name, so its agent stays connected. */
export function gpusOf(secrets: Record<string, any>, config: Record<string, any>): { gpus: Gpu[]; converted: boolean } {
  if (Array.isArray(secrets.gpus)) return { gpus: secrets.gpus, converted: false };
  const gpus: Gpu[] = [];
  if (secrets.agent_secret) {
    gpus.push({
      id: "pc", kind: "pc", name: "Your PC", enabled: true, secret: secrets.agent_secret, seen: null,
      keep_warm_minutes: DEFAULT_KEEP_WARM,
    });
  }
  const g = secrets.generator;
  if (g?.base_url) {
    const kind: GpuKind = g.kind === "modal" ? "modal" : "url";
    gpus.push({
      id: kind, kind, name: KIND_NAMES[kind], enabled: true, base_url: g.base_url, admin_url: g.admin_url ?? null,
      headers: g.headers ?? {}, cold_start_s: g.cold_start_s ?? 0, keep_warm_minutes: Number(config.keep_warm_minutes ?? DEFAULT_KEEP_WARM),
    });
  }
  return { gpus, converted: true };
}

/** A new PC's id: "pc" for the first (its Relay object's name), then "pc-" and a random suffix. */
export function newPcId(gpus: Gpu[]): string {
  if (!gpus.some((g) => g.id === "pc")) return "pc";
  return `pc-${tokenUrlsafe(6).replace(/[^A-Za-z0-9]/g, "x").toLowerCase()}`;
}

/** A fresh name that no other GPU has: "Your PC", "PC 2", ... */
export function newPcName(gpus: Gpu[]): string {
  const names = new Set(gpus.map((g) => g.name));
  if (!names.has("Your PC")) return "Your PC";
  for (let n = 2; ; n++) if (!names.has(`PC ${n}`)) return `PC ${n}`;
}

/** A fetch_result token names its GPU: "<gpu id>:<prompt id>". A bare prompt id (from before) has none. */
export function splitToken(token: string, gpus: Gpu[]): [Gpu | null, string] {
  const t = token.trim();
  const i = t.indexOf(":");
  if (i > 0) {
    const gpu = gpus.find((g) => g.id === t.slice(0, i));
    if (gpu) return [gpu, t.slice(i + 1)];
  }
  return [null, t];
}
