// The ComfyUI prompt an image carries, as ComfyUI's docs describe its metadata
// (docs.comfy.org/development/api-development/workflow-metadata): a PNG's `prompt` text chunk, or a
// WebP's EXIF tag holding `prompt:{json}` (SaveAnimatedWEBP, which our outputs go through). Only
// chunk headers are walked and one small JSON parsed: never a loop over the pixels.

import { canRedraw, type Pack } from "./packs.ts";

type Prompt = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

// UTF-8 only: the Workers runtime may not have other decoders. ComfyUI writes the JSON as ASCII
// (json.dumps escapes the rest), and binary EXIF bytes around it only become U+FFFD.
const utf8 = new TextDecoder();
const ascii = (b: Uint8Array) => String.fromCharCode(...b);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The API prompt that made *bytes*, or null when it carries none (or isn't a PNG or WebP). */
export function comfyPrompt(bytes: Uint8Array | null): Prompt | null {
  if (!bytes || bytes.length < 16) return null;
  try {
    const text = PNG_SIGNATURE.every((b, i) => bytes[i] === b) ? pngPrompt(bytes) : webpPrompt(bytes);
    if (!text) return null;
    const prompt = JSON.parse(text);
    return prompt && typeof prompt === "object" && !Array.isArray(prompt) ? prompt : null;
  } catch {
    return null; // truncated or not JSON: as good as none
  }
}

function pngPrompt(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = ascii(bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length));
    if (type === "tEXt" || type === "iTXt") {
      const nul = data.indexOf(0);
      if (nul > 0 && ascii(data.subarray(0, nul)) === "prompt") {
        if (type === "tEXt") return utf8.decode(data.subarray(nul + 1));
        // iTXt: compression flag, method, language\0, translated keyword\0, then UTF-8 text.
        if (data[nul + 1] !== 0) return null; // compressed: not what ComfyUI writes
        let i = data.indexOf(0, nul + 3);
        i = i < 0 ? -1 : data.indexOf(0, i + 1);
        return i < 0 ? null : utf8.decode(data.subarray(i + 1));
      }
    }
    if (type === "IEND") break;
    at += 12 + length;
  }
  return null;
}

function webpPrompt(bytes: Uint8Array): string | null {
  if (ascii(bytes.subarray(0, 4)) !== "RIFF" || ascii(bytes.subarray(8, 12)) !== "WEBP") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 12; at + 8 <= bytes.length; ) {
    const type = ascii(bytes.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (type === "EXIF") {
      // The tag values are NUL-terminated ASCII strings; the one we want starts with "prompt:".
      const exif = utf8.decode(bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size)));
      const start = exif.indexOf("prompt:{");
      if (start < 0) return null;
      const end = exif.indexOf("\0", start);
      return exif.slice(start + "prompt:".length, end < 0 ? undefined : end);
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

/** The model files a prompt loads as its diffusion model (UNET or checkpoint). */
function modelFiles(prompt: Prompt): Set<string> {
  const files = new Set<string>();
  for (const node of Object.values(prompt)) {
    for (const key of ["unet_name", "ckpt_name"]) {
      const v = node?.inputs?.[key];
      if (typeof v === "string") files.add(v);
    }
  }
  return files;
}

/** The name of the pack in *packs* that can redraw and drew *bytes* (its diffusion model is in the
 * image's embedded prompt), or null: no metadata, or a model no redraw pack uses (an edit's). */
export function redrawPackFor(bytes: Uint8Array | null, packs: Pack[]): string | null {
  const prompt = comfyPrompt(bytes);
  if (!prompt) return null;
  const used = modelFiles(prompt);
  if (!used.size) return null;
  for (const pack of packs.filter(canRedraw)) {
    for (const file of modelFiles(pack.workflow as Prompt)) if (used.has(file)) return pack.name;
  }
  return null;
}
