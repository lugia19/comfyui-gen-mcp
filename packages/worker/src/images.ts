// Images in R2 (design §4): every generated output and every upload, under img/<id>, as the WebP
// the tool result shows (outputs) or the file as uploaded. A bucket rule deletes them after a year.

import { refs, sniffMime } from "@comfy-gen/core";
import type { Bucket } from "./platform.ts";

/** Store image bytes under a new id (or *id*, an upload's): the id. */
export async function putImage(bucket: Bucket, bytes: Uint8Array, id = refs.newImageId()): Promise<string> {
  await bucket.put(refs.imageKey(id), bytes, { httpMetadata: { contentType: sniffMime(bytes) ?? "application/octet-stream" } });
  return id;
}

/** A stored image's bytes, or null if there is none (never stored, or expired). */
export async function getImage(bucket: Bucket, id: string): Promise<Uint8Array | null> {
  const obj = await bucket.get(refs.imageKey(id));
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}

/** GET /img/<id>: the stored image, streamed. */
export async function serveImage(bucket: Bucket, id: string): Promise<Response> {
  const obj = refs.IMAGE_ID.test(id) ? await bucket.get(refs.imageKey(id)) : null;
  if (!obj) return new Response("This image does not exist, or it was deleted after a year.", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Length": String(obj.size),
      "Cache-Control": "private, max-age=86400",
      ETag: obj.httpEtag,
    },
  });
}
