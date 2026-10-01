// Opaque image references and one-time upload tokens, signed with an HMAC key.
//
// A reference is the ComfyUI location of an image (type, subfolder, filename), encoded and signed,
// so the model can hand it back but can't forge one pointing at another path. Nothing is stored.
//
// Upload tokens carry an expiry and a random nonce, also signed. The upload they authorize lands
// under a name derived from the nonce, so a replay within the expiry overwrites the same file.
//
// An image lives on the backend that made it (or took the upload), and each ComfyUI numbers its
// files from comfy-gen_00001_, so an id also names its backend. The main generator's ids (Modal,
// or a ComfyUI URL) are [type, subfolder, filename], the format every id had before the PC path;
// the paired PC's add a fourth element, "pc". So ids issued before the PC existed keep resolving
// to the main generator.
//
// Compact ids (2026-10-01; models mistyped the long ones): an image this app named, a generated
// comfy-gen_NNNNN_.png or an upload-<nonce>.<ext>, is "<payload>.<mac>" with a plain-text payload
// (m7, p42 for the PC; mupAbC123 for an upload, its extension a letter) and a 9-byte MAC over
// "c:" + payload, e.g. m7.Ab3dE9fGh1Jk. Anything else keeps the JSON form below; both verify.
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

/** Where an image lives: the main generator, or the paired PC. */
export type Backend = "main" | "pc";

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

const COMPACT_MAC_BYTES = 9; // 72 bits: an id is only ever checked online, one guess per request
const COMPACT = /^([mp])(?:(\d+)|u([pjwg])([A-Za-z0-9_-]{1,32}))$/;
const OUTPUT_NAME = /^comfy-gen_(\d+)_\.png$/;
const UPLOAD_NAME = /^upload-([A-Za-z0-9_-]{1,32})\.(png|jpg|webp|gif)$/;
const EXT_LETTER: Record<string, string> = { png: "p", jpg: "j", webp: "w", gif: "g" };
const LETTER_EXT = Object.fromEntries(Object.entries(EXT_LETTER).map(([e, l]) => [l, e]));
const outputName = (n: string) => `comfy-gen_${n.padStart(5, "0")}_.png`; // SaveImage's %05d

async function compactMac(key: Uint8Array, payload: string): Promise<string> {
  return toBase64Url((await hmacSha256(key, `c:${payload}`)).subarray(0, COMPACT_MAC_BYTES));
}

/** The compact payload for an image this app named, or null. Only when it rebuilds exactly. */
function compactPayload(image: OutputImage, backend: Backend): string | null {
  const b = backend === "pc" ? "p" : "m";
  if (image.type === "output" && image.subfolder === "") {
    const m = OUTPUT_NAME.exec(image.filename);
    const n = m ? String(Number(m[1])) : null;
    if (n !== null && outputName(n) === image.filename) return `${b}${n}`;
  }
  if (image.type === "input" && image.subfolder === UPLOAD_SUBFOLDER) {
    const m = UPLOAD_NAME.exec(image.filename);
    if (m) return `${b}u${EXT_LETTER[m[2]]}${m[1]}`;
  }
  return null;
}

function fromCompact(payload: string): { image: OutputImage; backend: Backend } {
  const [, b, n, ext, nonce] = COMPACT.exec(payload)!;
  const backend: Backend = b === "p" ? "pc" : "main";
  if (n !== undefined) return { image: new OutputImage(outputName(n), "", "output"), backend };
  return { image: new OutputImage(`upload-${nonce}.${LETTER_EXT[ext]}`, UPLOAD_SUBFOLDER, "input"), backend };
}

/** The image id the model sees: compact when it can be, else the JSON form. */
export async function sign(image: OutputImage, key: Uint8Array, backend: Backend = "main"): Promise<string> {
  const compact = compactPayload(image, backend);
  if (compact) return `${compact}.${await compactMac(key, compact)}`;
  const fields = [image.type, image.subfolder, image.filename, ...(backend === "pc" ? ["pc"] : [])];
  const payload = toBase64Url(utf8(JSON.stringify(fields)));
  return `${payload}.${await mac(key, payload)}`;
}

/** The image a reference points at, and its backend. Throws RefError if it isn't one of ours. */
export async function verify(ref: string, key: Uint8Array): Promise<{ image: OutputImage; backend: Backend }> {
  const t = ref.trim();
  const dot = t.lastIndexOf(".");
  if (dot > 0 && COMPACT.test(t.slice(0, dot))) {
    const payload = t.slice(0, dot);
    if (!safeEqual(t.slice(dot + 1), await compactMac(key, payload))) throw new RefError("Invalid image id.");
    return fromCompact(payload);
  }
  const payload = await check(key, ref, "image id");
  let parsed: unknown;
  try {
    parsed = decode(payload);
  } catch {
    throw new RefError("Invalid image id.");
  }
  if (!Array.isArray(parsed) || !(parsed.length === 3 || (parsed.length === 4 && parsed[3] === "pc"))) {
    throw new RefError("Invalid image id.");
  }
  const [kind, subfolder, filename] = parsed;
  if (!TYPES.includes(kind) || typeof filename !== "string" || typeof subfolder !== "string") {
    throw new RefError("Invalid image id.");
  }
  return { image: new OutputImage(filename, subfolder, kind), backend: parsed.length === 4 ? "pc" : "main" };
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
