// Brain outcomes to MCP content.
//
// Results are inline WebP: claude.ai shows inline images and ignores resource_link (S2, S2c).
// ComfyUI converts on the way out (/view?preview=webp;90), so the Worker only base64s the bytes.
// Each image comes with a text block carrying its id (for edits) and a full-resolution link.

import { ComfyUIError, refs, sniffMime, toBase64, type ComfyUIClient, type Content, type Outcome, type Response as CoreResponse } from "@comfy-gen/core";

export const PREVIEW = "webp;90";
export const PREVIEW_SMALLER = "webp;75";
export const MAX_INLINE_BYTES = 700_000;

export const text = (s: string): Content => ({ type: "text", text: s });

/** [content blocks, isError] for an outcome. */
export async function render(outcome: Outcome, client: ComfyUIClient, baseUrl: string, hmacKey: Uint8Array): Promise<[Content[], boolean]> {
  if (outcome.kind === "pending") return [[text(outcome.text())], false];
  if (outcome.kind === "failed") return [[text(outcome.text())], true];
  const content: Content[] = [];
  for (const image of outcome.images) {
    let resp: CoreResponse;
    try {
      if (outcome.lossless) {
        resp = await client.view(image);
      } else {
        resp = await client.view(image, PREVIEW);
        if (resp.content.length > MAX_INLINE_BYTES) resp = await client.view(image, PREVIEW_SMALLER);
      }
    } catch (e) {
      if (!(e instanceof ComfyUIError)) throw e;
      return [[text(`Error: the image was generated but could not be fetched: ${e.message}`)], true];
    }
    const ref = await refs.sign(image, hmacKey);
    content.push({ type: "image", data: toBase64(resp.content), mimeType: sniffMime(resp.content) ?? "image/png" });
    content.push(text(`image_id: ${ref}\nFull resolution: ${baseUrl}/img/${ref}`));
  }
  return [content, false];
}
