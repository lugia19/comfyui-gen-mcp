// The bundle (comfy-gen.mjs, the release asset the shim loads): both local programs, the Claude
// Desktop extension's server and the PC agent, which share nearly all their code. The shim imports
// it and calls start(app); for the agent, updateReady() once it has downloaded a newer bundle. The
// settings app, the wait extension and the tray icons are embedded at build time (build.mjs
// provides the comfy-gen:* modules).

import web from "comfy-gen:web";
import waitExtension from "comfy-gen:wait-extension";
import icons from "comfy-gen:icons";
import type { TrayColor, WebFiles } from "@comfy-gen/local";
import { startAgent, type Agent } from "../../agent/src/main.ts";
import { main } from "./main.ts";

declare const __VERSION__: string;
export const VERSION = __VERSION__;

const files = new Map(Object.entries(web as Record<string, { type: string; body: string }>));
const webFiles: WebFiles = (path) => {
  const f = files.get(path);
  return f ? { type: f.type, body: new Uint8Array(Buffer.from(f.body, "base64")) } : null;
};
const trayIcons = () =>
  Object.fromEntries(
    Object.entries(icons).map(([color, f]) => [color, new Uint8Array(Buffer.from(process.platform === "win32" ? f.ico : f.png, "base64"))]),
  ) as Record<TrayColor, Uint8Array>;

let agent: Agent | null = null;

export async function start(app: "server" | "agent" = "server"): Promise<void> {
  const opts = { version: VERSION, waitExtension, web: webFiles, trayIcons: trayIcons() };
  if (app === "agent") agent = await startAgent(opts);
  else await main(opts);
}

/** The shim downloaded a newer bundle: the agent restarts into it when the machine is quiet. */
export function updateReady(tag: string): void {
  agent?.restartWhenIdle(tag);
}
