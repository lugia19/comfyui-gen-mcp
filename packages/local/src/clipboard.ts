// The image on the clipboard, for edit_image's "clipboard" (the MCPB). An image pasted into a chat
// cannot reach the extension; the user copies it (or its file) to the clipboard instead, and the
// model passes "clipboard" once they confirm (core's paths-mode description tells it so).
//
// Tried in order: a copied image file (the file browser's Copy), then image data (a browser's or an
// app's "Copy image", a screenshot). Windows through PowerShell, macOS through osascript, Linux
// through wl-paste (Wayland) or xclip (X11).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { capture } from "./proc.ts";

const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($files.Count -gt 0) { [Console]::Out.Write("file:" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($files[0]))); exit }
$png = [System.Windows.Forms.Clipboard]::GetData("PNG")
if ($png -is [System.IO.MemoryStream]) { [Console]::Out.Write([Convert]::ToBase64String($png.ToArray())); exit }
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) {
  $ms = New-Object System.IO.MemoryStream
  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
}`;

/** osascript prints clipboard data as «data PNGf89504E47…». */
export function parseAppleData(text: string): Buffer | null {
  const m = /«data [A-Za-z0-9 ]{4}([0-9A-Fa-f]+)»/.exec(text);
  return m ? Buffer.from(m[1], "hex") : null;
}

/** The first file in a text/uri-list, or null. */
export function firstFileUri(text: string): string | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("file://"));
  return line ? fileURLToPath(line) : null;
}

const readFile = (path: string): Buffer | null => {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
};

/** The clipboard's image (or copied file) as bytes, or null if it holds neither. The caller checks
 * that the bytes are an image. */
export async function readClipboardImage(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<Buffer | null> {
  if (platform === "win32") {
    const out = await capture("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_SCRIPT], { env });
    const text = out?.toString("utf8").trim() ?? "";
    if (!text) return null;
    // Both answers are base64: the console's code page would mangle a non-ASCII path.
    return text.startsWith("file:") ? readFile(Buffer.from(text.slice(5), "base64").toString("utf8")) : Buffer.from(text, "base64");
  }
  if (platform === "darwin") {
    const file = (await capture("osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"], { env }))?.toString("utf8").trim();
    if (file) return readFile(file);
    const data = await capture("osascript", ["-e", "the clipboard as «class PNGf»"], { env });
    return data ? parseAppleData(data.toString("utf8")) : null;
  }
  const wayland = Boolean(env.WAYLAND_DISPLAY);
  const get = (type: string) =>
    wayland ? capture("wl-paste", ["--no-newline", "--type", type], { env }) : capture("xclip", ["-selection", "clipboard", "-t", type, "-o"], { env });
  const uris = await get("text/uri-list");
  const file = uris ? firstFileUri(uris.toString("utf8")) : null;
  if (file) return readFile(file);
  const png = await get("image/png");
  return png?.length ? png : null;
}
