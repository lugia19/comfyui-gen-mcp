// Brain outcomes to MCP content: each image inline, followed by a text block with its id (for
// edits) and a full-resolution link.

import { ComfyUIError, inlineImage, refs, textBlock, type ComfyUIClient, type Content, type Outcome } from "@comfy-gen/core";

export const text = textBlock;

/** [content blocks, isError] for an outcome. */
export async function render(
  outcome: Outcome,
  client: ComfyUIClient,
  baseUrl: string,
  hmacKey: Uint8Array,
  backend: refs.Backend = "main",
): Promise<[Content[], boolean]> {
  if (outcome.kind === "pending") return [[text(outcome.text())], false];
  if (outcome.kind === "failed") return [[text(outcome.text())], true];
  const content: Content[] = [];
  for (const image of outcome.images) {
    try {
      content.push(await inlineImage(client, image, outcome.lossless));
    } catch (e) {
      if (!(e instanceof ComfyUIError)) throw e;
      return [[text(`Error: the image was generated but could not be fetched: ${e.message}`)], true];
    }
    const ref = await refs.sign(image, hmacKey, backend);
    content.push(text(`image_id: ${ref}\nFull resolution: ${baseUrl}/img/${ref}`));
  }
  return [content, false];
}
