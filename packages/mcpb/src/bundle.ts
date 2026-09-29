// The server bundle's entry (comfy-gen-server.mjs, a release asset): the shim imports it and calls
// start(). The settings app, the wait extension and the tray icon are embedded at build time
// (build.mjs provides the comfy-gen:* modules).

import web from "comfy-gen:web";
import waitExtension from "comfy-gen:wait-extension";
import icons from "comfy-gen:icons";
import { main, type MainOptions } from "./main.ts";

declare const __VERSION__: string;
export const VERSION = __VERSION__;

const files = new Map(Object.entries(web as Record<string, { type: string; body: string }>));

export function start(): Promise<void> {
  return main({
    version: VERSION,
    waitExtension,
    web: (path) => {
      const f = files.get(path);
      return f ? { type: f.type, body: new Uint8Array(Buffer.from(f.body, "base64")) } : null;
    },
    trayIcons: Object.fromEntries(
      Object.entries(icons).map(([color, f]) => [color, new Uint8Array(Buffer.from(process.platform === "win32" ? f.ico : f.png, "base64"))]),
    ) as MainOptions["trayIcons"],
  });
}
