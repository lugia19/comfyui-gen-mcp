// The agent bundle's entry (comfy-gen-agent.mjs, a release asset): the shim, started by the
// launcher in agent mode, imports it and calls start(), then updateReady() once it has downloaded a
// newer one. The settings app, the wait extension and the tray icons are embedded at build time
// (packages/mcpb/build.mjs provides the comfy-gen:* modules).

import web from "comfy-gen:web";
import waitExtension from "comfy-gen:wait-extension";
import icons from "comfy-gen:icons";
import type { TrayColor } from "@comfy-gen/local";
import { startAgent, type Agent } from "./main.ts";

declare const __VERSION__: string;
export const VERSION = __VERSION__;

const files = new Map(Object.entries(web as Record<string, { type: string; body: string }>));

let agent: Agent | null = null;

export async function start(): Promise<void> {
  agent = await startAgent({
    version: VERSION,
    waitExtension,
    web: (path) => {
      const f = files.get(path);
      return f ? { type: f.type, body: new Uint8Array(Buffer.from(f.body, "base64")) } : null;
    },
    trayIcons: Object.fromEntries(
      Object.entries(icons).map(([color, f]) => [color, new Uint8Array(Buffer.from(process.platform === "win32" ? f.ico : f.png, "base64"))]),
    ) as Record<TrayColor, Uint8Array>,
  });
}

/** The shim downloaded a newer agent: restart into it when the machine is quiet. */
export function updateReady(tag: string): void {
  agent?.restartWhenIdle(tag);
}
