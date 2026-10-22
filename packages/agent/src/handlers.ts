// What the agent does for the Worker: ComfyUI requests, relayed to the local ComfyUI as they are,
// and operations on the machine (the same Machine the MCPB runs).

import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { checkComfyArgs, ComfyUIError, type relay } from "@comfy-gen/core";
import { UploadError } from "@comfy-gen/core";
import { log, type Machine, type PackNeeds } from "@comfy-gen/local";
import type { SyncJob } from "./lora-sync.ts";
import type { Reply } from "./relay-client.ts";

const ok = (data: unknown): Reply => [200, JSON.stringify(data ?? null)];

export type HandlerOptions = {
  machine: Machine;
  /** The Worker's keep-warm setting, sent with each ensure; the agent's idle stop follows it. */
  setKeepWarm(minutes: number): void;
  /** The Worker's ComfyUI flags for this PC, sent with each ensure (a Worker before them sends none). */
  setComfyArgs?(args: string[]): void;
  /** Where the user sees download progress, for "downloading" answers. */
  settingsNote: string;
  /** Pause or resume taking image requests, from the Worker's page (the tray's flag). */
  setPaused(paused: boolean): void;
  /** One call of this PC's own settings API (/api/<path>), for its page on the Worker: [status, body]. */
  page(method: string, path: string, body?: string): Promise<[number, string]>;
  /** LoRA sync with the Worker's R2: start a round (not awaited), and the copies in progress. */
  sync?: { sync(): Promise<void>; jobs: Record<string, SyncJob> };
};

const VIEW_TYPES = new Set(["output", "input", "temp"]);

/**
 * An image ComfyUI would serve at /view, read from its folders: for when ComfyUI is stopped (the
 * idle stop), so a PC image's link and edits by image_id keep working without starting it. Null if
 * there is no such file. `preview` is ignored: the original is sent (its size is what callers read).
 */
export async function viewFromDisk(dir: string | undefined, params: Record<string, string> | undefined): Promise<Uint8Array | null> {
  const p = params ?? {};
  const type = p.type || "output";
  if (!dir || !VIEW_TYPES.has(type) || !p.filename) return null;
  const root = resolve(dir, type);
  const path = resolve(root, p.subfolder ?? "", p.filename);
  if (!path.startsWith(root + sep)) return null; // no way out of the folder
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

export function agentHandler(o: HandlerOptions): (msg: relay.RelayMessage) => Promise<Reply> {
  const { machine } = o;
  const comfy = machine.comfy;

  const fromDisk = async (h: relay.HttpMessage): Promise<Reply | null> => {
    if (h.method !== "GET" || h.path !== "/view") return null;
    const data = await viewFromDisk(comfy.dataDir ?? undefined, h.params);
    return data ? [200, data] : null;
  };

  const http = async (h: relay.HttpMessage, body: Uint8Array): Promise<Reply> => {
    // Reading an image back does not start a stopped ComfyUI.
    if (comfy.state !== "running" && comfy.state !== "starting") {
      const served = await fromDisk(h);
      if (served) return served;
    }
    return comfy.job(async () => {
      const base = comfy.url;
      if (!base || comfy.state === "not_installed") return [503, "ComfyUI is not running on your PC."];
      const query = h.params ? "?" + new URLSearchParams(h.params).toString() : "";
      try {
        const resp = await fetch(base + h.path + query, {
          method: h.method,
          headers: h.headers,
          body: h.method === "GET" || h.method === "HEAD" ? undefined : (body as unknown as BodyInit),
        });
        return [resp.status, new Uint8Array(await resp.arrayBuffer())];
      } catch (e) {
        return (await fromDisk(h)) ?? [503, `ComfyUI on your PC did not answer: ${(e as Error).message}`];
      }
    });
  };

  const control = async (h: relay.ControlMessage, body: Uint8Array): Promise<Reply> => {
    const args = (h.args ?? {}) as Record<string, any>;
    try {
      switch (h.op) {
        case "ensure": {
          if (Number.isInteger(args.keep_warm_minutes) && args.keep_warm_minutes > 0) o.setKeepWarm(args.keep_warm_minutes);
          if (args.comfy_args !== undefined && !checkComfyArgs(args.comfy_args)) o.setComfyArgs?.(args.comfy_args);
          await machine.ensurePack(args.pack as PackNeeds, o.settingsNote);
          return ok({ ready: true });
        }
        case "loras":
          return ok({ files: machine.loras(), syncing: o.sync?.jobs ?? {} });
        case "sync":
          void o.sync?.sync();
          return ok({ started: Boolean(o.sync) });
        case "download": {
          const pack = args.pack as PackNeeds;
          return ok(machine.downloads.start(pack.name, pack.models ?? [], pack.display_name));
        }
        case "models":
          return ok(((args.packs ?? []) as PackNeeds[]).map((p) => ({ name: p.name, ...machine.downloads.status(p.name, p.models ?? []) })));
        case "pause":
          o.setPaused(args.paused === true);
          return ok({ paused: args.paused === true });
        case "machine": {
          // This PC's page on the Worker (design §9, "A page per PC"): any call of its own API but
          // pairing, which is what makes the Worker trusted, so it is done here only.
          const method = String(args.method ?? "GET").toUpperCase();
          // Checked as the page will read it: "/x/../pair" is /pair.
          const url = new URL(String(args.path ?? ""), "http://page.invalid/");
          if (url.pathname.replace(/\/+$/, "") === "/pair") return [403, "Pair or unpair on the PC itself."];
          return await o.page(method, url.pathname + url.search, typeof args.body === "string" ? args.body : undefined);
        }
        case "lora_delete":
          return ok(await machine.deleteLora(String(args.name)));
        case "models_stored":
          return ok(machine.storedModels(args.files));
        case "models_delete":
          return ok(await machine.deleteModels(args.files));
        default:
          return [400, `The agent does not know the operation ${h.op}. Update it.`];
      }
    } catch (e) {
      if (e instanceof ComfyUIError) return [500, e.message];
      if (e instanceof UploadError) return [e.status, e.message];
      throw e;
    }
  };

  return async (msg) => (msg.header.kind === "http" ? http(msg.header, msg.body) : control(msg.header as relay.ControlMessage, msg.body));
}
