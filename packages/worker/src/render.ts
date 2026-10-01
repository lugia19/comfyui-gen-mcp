// Brain outcomes to MCP content: each image inline, followed by a text block with its id (for
// edits) and a link. The inline WebP is also what is stored in R2 under that id.

import { ComfyUIError, imageBlock, previewImage, textBlock, type ComfyUIClient, type Content, type Outcome } from "@comfy-gen/core";
import { putImage } from "./images.ts";
import type { Bucket } from "./platform.ts";

export const text = textBlock;

/** [content blocks, isError] for an outcome. */
export async function render(outcome: Outcome, client: ComfyUIClient, baseUrl: string, bucket: Bucket): Promise<[Content[], boolean]> {
  if (outcome.kind === "pending") return [[text(outcome.text())], false];
  if (outcome.kind === "failed") return [[text(outcome.text())], true];
  const content: Content[] = [];
  for (const image of outcome.images) {
    let bytes: Uint8Array;
    try {
      bytes = await previewImage(client, image);
    } catch (e) {
      if (!(e instanceof ComfyUIError)) throw e;
      return [[text(`Error: the image was generated but could not be fetched: ${e.message}`)], true];
    }
    const id = await putImage(bucket, bytes);
    content.push(imageBlock(bytes));
    content.push(text(`image_id: ${id}\nFull resolution: ${baseUrl}/img/${id}`));
  }
  return [content, false];
}
