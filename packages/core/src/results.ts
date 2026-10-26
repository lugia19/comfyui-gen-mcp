// Tool results, shared by every frontend: finished images as inline MCP image blocks, errors, and
// the value scripted callers read (design §3, Scripted callers).
//
// Inline WebP: claude.ai shows inline images and ignores resource_link (S2, S2c). Outputs are saved
// as WebP by ComfyUI itself (workflow.ts withWebpSave), with the prompt in their EXIF, and fetched
// as they are, so the brain's host only base64s the bytes. The Worker also stores those same bytes
// as the image's copy in R2. One too big to send inline is re-encoded smaller by ComfyUI, and gets
// the original's EXIF back (metadata.ts withExifOf).

import { toBase64 } from "./bytes.ts";
import type { Outcome } from "./brain.ts";
import { ComfyUIError, type ComfyUIClient, type OutputImage, type Response } from "./comfyui.ts";
import { imageSize, sniffMime } from "./images.ts";
import { withExifOf } from "./metadata.ts";
import type { Content } from "./mcp.ts";

export const PREVIEW = "webp;90";
export const PREVIEW_SMALLER = "webp;75";
export const MAX_INLINE_BYTES = 1_400_000;

export const textBlock = (s: string): Content => ({ type: "text", text: s });

/** The image as WebP: the saved file when it is one (prompt metadata included), else ComfyUI's
 * conversion at quality 90; either way quality 75 when over MAX_INLINE_BYTES, with the saved file's
 * metadata put back (ComfyUI's conversion drops it). Throws ComfyUIError if ComfyUI cannot serve it. */
export async function previewImage(client: ComfyUIClient, image: OutputImage): Promise<Uint8Array> {
  const resp: Response = await client.view(image, image.filename.toLowerCase().endsWith(".webp") ? undefined : PREVIEW);
  if (resp.content.length <= MAX_INLINE_BYTES) return resp.content;
  return withExifOf((await client.view(image, PREVIEW_SMALLER)).content, resp.content);
}

/** Image bytes as an MCP image block. */
export function imageBlock(bytes: Uint8Array): Content {
  return { type: "image", data: toBase64(bytes), mimeType: sniffMime(bytes) ?? "image/webp" };
}

/** A tool result: [content blocks, isError, the value for scripted callers] (mcp.ts ToolCall). */
export type Rendered = [Content[], boolean, Record<string, any>];

/** An error result: the text Claude reads, and its form for scripted callers. */
export function failResult(message: string, retryable = false): Rendered {
  return [[textBlock(`Error: ${message}`)], true, { status: "error", message, retryable }];
}

/** What a frontend adds after each image: the text block Claude reads (its id, or where it was
 * saved) and its fields in the scripted callers' result. The image's bytes are the WebP shown. */
export type AfterImage = (bytes: Uint8Array, image: OutputImage) => Promise<{ text: string; meta: Record<string, any> }>;

/**
 * An outcome as a tool result, for every frontend: each image inline, then *after*'s text. The
 * scripted callers' value is one of {status: "done", images: [{...meta, width, height}]},
 * {status: "pending", request_token} or {status: "error", message, retryable}.
 */
export async function renderOutcome(outcome: Outcome, client: ComfyUIClient, after: AfterImage): Promise<Rendered> {
  if (outcome.kind === "pending") return [[textBlock(outcome.text())], false, { status: "pending", request_token: outcome.token }];
  if (outcome.kind === "failed") return failResult(outcome.message, outcome.retryable);
  const content: Content[] = [];
  const images: Record<string, any>[] = [];
  for (const image of outcome.images) {
    let bytes: Uint8Array;
    try {
      bytes = await previewImage(client, image);
    } catch (e) {
      if (!(e instanceof ComfyUIError)) throw e;
      return failResult(`the image was generated but could not be fetched: ${e.message}`);
    }
    const { text, meta } = await after(bytes, image);
    const [width, height] = imageSize(bytes) ?? [null, null];
    content.push(imageBlock(bytes), textBlock(text));
    images.push({ ...meta, width, height });
  }
  return [content, false, { status: "done", images }];
}
