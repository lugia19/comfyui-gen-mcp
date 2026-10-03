// The bundle (comfy-gen.mjs, the release asset the shim loads): both local programs, the Claude
// Desktop extension's server and the PC agent, which share nearly all their code. The shim imports
// it and calls start(app); for the agent, updateReady() once it has downloaded a newer bundle. The
// settings app, the wait extension, the tray icons and the tray helpers' hashes are embedded at
// build time (build.mjs provides the comfy-gen:* modules).

import web from "comfy-gen:web";
import waitExtension from "comfy-gen:wait-extension";
import icons from "comfy-gen:icons";
import trayFiles from "comfy-gen:tray";
import type { TrayColor, TrayHelper, TrayLook, WebFiles } from "@comfy-gen/local";
import { startAgent, type Agent } from "../../agent/src/main.ts";
import { main } from "./main.ts";

declare const __VERSION__: string;
export const VERSION = __VERSION__;

const files = new Map(Object.entries(web as Record<string, { type: string; body: string }>));
const webFiles: WebFiles = (path) => {
  const f = files.get(path);
  return f ? { type: f.type, body: new Uint8Array(Buffer.from(f.body, "base64")) } : null;
};
// The tray helper for this computer, in this release's archive (the shim's releases address):
// Windows, Linux on x64 and macOS on Apple silicon, as the launchers.
const HELPER_PLATFORMS: Record<string, string> = { "win32-x64": "windows", "linux-x64": "linux", "darwin-arm64": "macos" };
function trayHelper(): TrayHelper | null {
  const entry = trayFiles.helpers[HELPER_PLATFORMS[`${process.platform}-${process.arch}`] ?? ""];
  if (!entry || !trayFiles.archive) return null;
  const releases = process.env.COMFY_GEN_RELEASES_URL || "https://github.com/lugia19/comfyui-gen-mcp/releases";
  return { ...entry, url: `${releases}/download/${VERSION}/${trayFiles.archive.name}`, archiveSha256: trayFiles.archive.sha256 };
}
const trayLook = (): TrayLook => ({
  icons: Object.fromEntries(
    Object.entries(icons).map(([color, f]) => [color, new Uint8Array(Buffer.from(process.platform === "win32" ? f.ico : f.png, "base64"))]),
  ) as Record<TrayColor, Uint8Array>,
  helper: trayHelper(),
});

let agent: Agent | null = null;

export async function start(app: "server" | "agent" = "server"): Promise<void> {
  const opts = { version: VERSION, waitExtension, web: webFiles, tray: trayLook() };
  if (app === "agent") agent = await startAgent(opts);
  else await main(opts);
}

/** The shim downloaded a newer bundle: the agent restarts into it when the machine is quiet. */
export function updateReady(tag: string): void {
  agent?.restartWhenIdle(tag);
}
