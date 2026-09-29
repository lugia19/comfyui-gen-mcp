// A finished image as an inline MCP image block, shared by every frontend.
//
// Inline WebP: claude.ai shows inline images and ignores resource_link (S2, S2c). ComfyUI converts
// on the way out (/view?preview=webp;90), so the brain's host only base64s the bytes. ":lossless"
// asks for the PNG itself.

import { toBase64 } from "./bytes.ts";
import type { ComfyUIClient, OutputImage, Response } from "./comfyui.ts";
import { sniffMime } from "./images.ts";
import type { Content } from "./mcp.ts";

export const PREVIEW = "webp;90";
export const PREVIEW_SMALLER = "webp;75";
export const MAX_INLINE_BYTES = 700_000;

export const textBlock = (s: string): Content => ({ type: "text", text: s });

/** The image as an MCP image block. Throws ComfyUIError if ComfyUI cannot serve it. */
export async function inlineImage(client: ComfyUIClient, image: OutputImage, lossless: boolean): Promise<Content> {
  let resp: Response;
  if (lossless) {
    resp = await client.view(image);
  } else {
    resp = await client.view(image, PREVIEW);
    if (resp.content.length > MAX_INLINE_BYTES) resp = await client.view(image, PREVIEW_SMALLER);
  }
  return { type: "image", data: toBase64(resp.content), mimeType: sniffMime(resp.content) ?? "image/png" };
}
