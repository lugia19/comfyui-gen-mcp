// Image ids, one-time upload tokens and storage links.
//
// An image (a generated output or an upload) is stored by the Worker in R2 under a random id: 8
// base62 characters, about 47 bits. The id is the capability: the model hands it back to
// edit_image, and /img/<id> serves it. It names nothing on any GPU, so no image depends on the GPU
// that made it being online. (Before 2026-10-01 an id was a signed ComfyUI location plus its
// backend; those ids are gone.)
//
// Upload tokens carry an expiry and a random nonce, signed with an HMAC key. The nonce is the
// uploaded image's id, so a replay within the expiry overwrites the same image.
//
// Storage links (/store/<token>) let a GPU fetch a stored object, a LoRA, without other auth: the
// token carries the object's key and an expiry, signed the same way.
//
// Upload tokens and storage links are a compatibility surface (test/golden.json pins them).

import { fromBase64Url, fromUtf8, hmacSha256, safeEqual, toBase64Url, utf8 } from "./bytes.ts";
import { EXTENSIONS } from "./images.ts";

const MAC_BYTES = 16;
export const UPLOAD_SUBFOLDER = "comfy-gen-uploads";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const IMAGE_ID = /^[0-9A-Za-z]{8}$/;

/** A reference or token is malformed, forged or expired. The message is meant for the model. */
export class RefError extends Error {
  name = "RefError";
}

export async function mac(key: Uint8Array, payload: string): Promise<string> {
  return toBase64Url((await hmacSha256(key, payload)).subarray(0, MAC_BYTES));
}

async function check(key: Uint8Array, token: string, what: string): Promise<string> {
  const t = token.trim();
  const dot = t.lastIndexOf(".");
  const payload = dot < 0 ? "" : t.slice(0, dot);
  const sig = dot < 0 ? "" : t.slice(dot + 1);
  if (!payload || !safeEqual(sig, await mac(key, payload))) throw new RefError(`Invalid ${what}.`);
  return payload;
}

function decode(payload: string): unknown {
  return JSON.parse(fromUtf8(fromBase64Url(payload)));
}

async function signed(key: Uint8Array, fields: unknown[]): Promise<string> {
  const payload = toBase64Url(utf8(JSON.stringify(fields)));
  return `${payload}.${await mac(key, payload)}`;
}

/** [expires, value] from a token made by signed(), or RefError (*expired* is the expiry's message). */
async function opened(key: Uint8Array, token: string, now: number, what: string, expired: string): Promise<string> {
  const payload = await check(key, token, what);
  let parsed: unknown;
  try {
    parsed = decode(payload);
  } catch {
    throw new RefError(`Invalid ${what}.`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new RefError(`Invalid ${what}.`);
  const [expires, value] = parsed;
  if (!Number.isInteger(expires) || typeof value !== "string") throw new RefError(`Invalid ${what}.`);
  if (now > expires) throw new RefError(expired);
  return value;
}

/** A new image id: 8 random base62 characters. */
export function newImageId(): string {
  let out = "";
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(12))) {
      if (b < 248 && out.length < 8) out += BASE62[b % 62]; // 248 = 4 * 62: no bias
    }
  }
  return out;
}

/** The image id in what the model passed (it may copy the "image_id:" label along), or RefError. */
export function imageIdIn(arg: string): string {
  let a = arg.trim();
  if (a.toLowerCase().startsWith("image_id:")) a = a.slice(a.indexOf(":") + 1).trim();
  if (!IMAGE_ID.test(a)) throw new RefError("Invalid image id.");
  return a;
}

/** Where an image is stored in R2. */
export const imageKey = (id: string) => `img/${id}`;

/** A token authorizing one upload until now + ttlS. Its nonce is the uploaded image's id. */
export function mintUpload(key: Uint8Array, now: number, ttlS: number): Promise<string> {
  return signed(key, [Math.trunc(now + ttlS), newImageId()]);
}

/** The token's nonce if it is valid and unexpired. Throws RefError otherwise. */
export function checkUpload(token: string, key: Uint8Array, now: number): Promise<string> {
  return opened(key, token, now, "upload link", "This upload link has expired. Call request_upload again.");
}

/** A link token for the stored object *object*, valid until now + ttlS. */
export function mintStore(key: Uint8Array, object: string, now: number, ttlS: number): Promise<string> {
  return signed(key, [Math.trunc(now + ttlS), `s:${object}`]); // "s:" so an upload token can't pass as one
}

/** The object a storage link names if it is valid and unexpired. Throws RefError otherwise. */
export async function checkStore(token: string, key: Uint8Array, now: number): Promise<string> {
  const value = await opened(key, token, now, "storage link", "This storage link has expired.");
  if (!value.startsWith("s:")) throw new RefError("Invalid storage link.");
  return value.slice(2);
}

/** A ComfyUI input-folder file name for an image put there under *nonce*. */
export function uploadFilename(nonce: string, mime: string): string {
  const ext = EXTENSIONS[mime] ?? "png";
  const safe = Array.from(nonce).filter((c) => /[\p{L}\p{N}_-]/u.test(c)).join("");
  return `upload-${safe}.${ext}`;
}
