// What the agent does for the Worker: ComfyUI requests, relayed to the local ComfyUI as they are,
// and operations on the machine (the same Machine the MCPB runs).

import { ComfyUIError, type relay } from "@comfy-gen/core";
import type { Machine, PackNeeds } from "@comfy-gen/local";
import type { Reply } from "./relay-client.ts";

const ok = (data: unknown): Reply => [200, JSON.stringify(data ?? null)];

export type HandlerOptions = {
  machine: Machine;
  /** The Worker's keep-warm setting, sent with each ensure; the agent's idle stop follows it. */
  setKeepWarm(minutes: number): void;
  /** Where the user sees download progress, for "downloading" answers. */
  settingsNote: string;
};

export function agentHandler(o: HandlerOptions): (msg: relay.RelayMessage) => Promise<Reply> {
  const { machine } = o;
  const comfy = machine.comfy;

  const http = (h: relay.HttpMessage, body: Uint8Array): Promise<Reply> =>
    comfy.job(async () => {
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
        return [503, `ComfyUI on your PC did not answer: ${(e as Error).message}`];
      }
    });

  const control = async (h: relay.ControlMessage): Promise<Reply> => {
    const args = (h.args ?? {}) as Record<string, any>;
    try {
      switch (h.op) {
        case "ensure": {
          if (Number.isInteger(args.keep_warm_minutes) && args.keep_warm_minutes > 0) o.setKeepWarm(args.keep_warm_minutes);
          await machine.ensurePack(args.pack as PackNeeds, o.settingsNote);
          return ok({ ready: true });
        }
        case "inventory":
          await comfy.ensureRunning();
          return ok([...(await comfy.nodeClasses())]);
        case "loras":
          return ok(machine.loras());
        case "models":
          return ok(((args.packs ?? []) as PackNeeds[]).map((p) => ({ name: p.name, ...machine.downloads.status(p.name, p.models ?? []) })));
        case "status":
          return ok(await machine.state());
        default:
          return [400, `The agent does not know the operation ${h.op}. Update it.`];
      }
    } catch (e) {
      if (e instanceof ComfyUIError) return [500, e.message];
      throw e;
    }
  };

  return async (msg) => (msg.header.kind === "http" ? http(msg.header, msg.body) : control(msg.header as relay.ControlMessage));
}
