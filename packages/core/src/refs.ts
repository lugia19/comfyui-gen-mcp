// Opaque image references and one-time upload tokens, signed with an HMAC key.
//
// A reference is the ComfyUI location of an image (type, subfolder, filename), encoded and signed,
// so the model can hand it back but can't forge one pointing at another path. Nothing is stored.
//
// Upload tokens carry an expiry and a random nonce, also signed. The upload they authorize lands
// under a name derived from the nonce, so a replay within the expiry overwrites the same file.
//
// The formats are a compatibility surface (test/golden.json pins them): ids in users' chats must
// keep verifying. Ids for non-ASCII names issued by v0 (the Python Worker) spell them as \uXXXX in
// the payload; those still verify, and new ones spell them directly.

import { fromBase64Url, fromUtf8, hmacSha256, safeEqual, toBase64Url, tokenUrlsafe, utf8 } from "./bytes.ts";
import { OutputImage } from "./comfyui.ts";
import { EXTENSIONS } from "./images.ts";

const MAC_BYTES = 16;
const TYPES = ["output", "input"];
export const UPLOAD_SUBFOLDER = "comfy-gen-uploads";

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

/** The image id the model sees. */
export async function sign(image: OutputImage, key: Uint8Array): Promise<string> {
  const payload = toBase64Url(utf8(JSON.stringify([image.type, image.subfolder, image.filename])));
  return `${payload}.${await mac(key, payload)}`;
}

/** The image a reference points at. Throws RefError if it isn't one of ours. */
export async function verify(ref: string, key: Uint8Array): Promise<OutputImage> {
  const payload = await check(key, ref, "image id");
  let parsed: unknown;
  try {
    parsed = decode(payload);
  } catch {
    throw new RefError("Invalid image id.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new RefError("Invalid image id.");
  const [kind, subfolder, filename] = parsed;
  if (!TYPES.includes(kind) || typeof filename !== "string" || typeof subfolder !== "string") {
    throw new RefError("Invalid image id.");
  }
  return new OutputImage(filename, subfolder, kind);
}

/** A token authorizing one upload until now + ttlS. */
export async function mintUpload(key: Uint8Array, now: number, ttlS: number): Promise<string> {
  const payload = toBase64Url(utf8(JSON.stringify([Math.trunc(now + ttlS), tokenUrlsafe(12)])));
  return `${payload}.${await mac(key, payload)}`;
}

/** The token's nonce if it is valid and unexpired. Throws RefError otherwise. */
export async function checkUpload(token: string, key: Uint8Array, now: number): Promise<string> {
  const payload = await check(key, token, "upload link");
  let parsed: unknown;
  try {
    parsed = decode(payload);
  } catch {
    throw new RefError("Invalid upload link.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new RefError("Invalid upload link.");
  const [expires, nonce] = parsed;
  if (!Number.isInteger(expires) || typeof nonce !== "string") throw new RefError("Invalid upload link.");
  if (now > expires) throw new RefError("This upload link has expired. Call request_upload again.");
  return nonce;
}

/** The input-folder file name for an upload authorized by *nonce*. */
export function uploadFilename(nonce: string, mime: string): string {
  const ext = EXTENSIONS[mime] ?? "png";
  const safe = Array.from(nonce).filter((c) => /[\p{L}\p{N}_-]/u.test(c)).join("");
  return `upload-${safe}.${ext}`;
}
