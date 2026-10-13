// Brain outcomes to MCP content: each image inline, followed by a text block with its id (for
// edits) and a link. The inline WebP is also what is stored in R2 under that id.
//
// Each result also carries a value for scripted callers in its _meta (RESULT_META; design §3,
// Scripted callers), one of {status:"done", images:[{image_id, url, width, height}]}, {status:"pending",
// request_token} or {status:"error", message, retryable}. The content is what Claude reads.

import { ComfyUIError, imageBlock, imageSize, previewImage, textBlock, type ComfyUIClient, type Content, type Outcome } from "@comfy-gen/core";
import type { Images } from "./images.ts";

export const text = textBlock;
export type Rendered = [Content[], boolean, Record<string, any>];

/** An error result: the text Claude reads, and its structured form. */
export function fail(message: string, retryable = false): Rendered {
  return [[text(`Error: ${message}`)], true, { status: "error", message, retryable }];
}

/** [content blocks, isError, structured] for an outcome. */
export async function render(outcome: Outcome, client: ComfyUIClient, baseUrl: string, images: Images): Promise<Rendered> {
  if (outcome.kind === "pending") return [[text(outcome.text())], false, { status: "pending", request_token: outcome.token }];
  if (outcome.kind === "failed") return fail(outcome.message, outcome.retryable);
  const content: Content[] = [];
  const done: Record<string, any>[] = [];
  for (const image of outcome.images) {
    let bytes: Uint8Array;
    try {
      bytes = await previewImage(client, image);
    } catch (e) {
      if (!(e instanceof ComfyUIError)) throw e;
      return fail(`the image was generated but could not be fetched: ${e.message}`);
    }
    const id = await images.put(bytes);
    const url = `${baseUrl}/img/${id}`;
    const [width, height] = imageSize(bytes) ?? [null, null];
    content.push(imageBlock(bytes));
    content.push(text(`image_id: ${id}\nFull resolution: ${url}`));
    done.push({ image_id: id, url, width, height });
  }
  return [content, false, { status: "done", images: done }];
}
