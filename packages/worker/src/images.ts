// Images in R2 (design §4): every generated output and every upload, under img/<id>, as the WebP
// the tool result shows (outputs) or the file as uploaded. A bucket rule deletes them after a year.
//
// With "Encrypt new images" on (Settings), a new image is stored encrypted: AES-256-GCM with the
// Worker's image key (secrets.image_key, made when the setting is first turned on, never changed),
// a random 12-byte IV, and the R2 key as associated data, so a ciphertext only opens under its own
// id. The object is application/octet-stream, with customMetadata { enc: "aes-gcm-1", iv (base64),
// type (the image's own type) }. Reads open any object carrying the mark, whatever the setting
// says; unmarked objects read as they always did. A compatibility surface: stored images must stay
// readable.

import { ComfyUIError, fromBase64, fromHex, randomBytes, refs, sniffMime, toBase64, utf8 } from "@comfy-gen/core";
import type { Bucket, StoredObject } from "./platform.ts";
import type { Store } from "./store.ts";

export const ENC = "aes-gcm-1";
const TAG_BYTES = 16; // AES-GCM's tag, at the end of the ciphertext

const UNREADABLE = "is stored encrypted and can't be decrypted: this Worker's image key is missing, or the stored file was changed.";

/** The images in R2. *store* gives the image key and the setting (cached); *fresh*, uncached, is
 * read once when an encrypted image turns up before this isolate has seen the key. */
export class Images {
  private bucket: Bucket;
  private store: Store;
  private fresh: Store;
  private key: Promise<CryptoKey | null> | null = null;

  constructor(bucket: Bucket, store: Store, fresh: Store) {
    this.bucket = bucket;
    this.store = store;
    this.fresh = fresh;
  }

  /** Store image bytes under a new id (or *id*, an upload's): the id. */
  async put(bytes: Uint8Array, id = refs.newImageId()): Promise<string> {
    const type = sniffMime(bytes) ?? "application/octet-stream";
    const s = await this.store.secrets();
    if (!s.encrypt_images || !s.image_key) {
      await this.bucket.put(refs.imageKey(id), bytes, { httpMetadata: { contentType: type } });
      return id;
    }
    const iv = randomBytes(12);
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(refs.imageKey(id)) }, await importKey(s.image_key), bytes);
    await this.bucket.put(refs.imageKey(id), sealed, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { enc: ENC, iv: toBase64(iv), type },
    });
    return id;
  }

  /** A stored image's bytes, or null if there is none (never stored, or expired). */
  async get(id: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(refs.imageKey(id));
    if (!obj) return null;
    if (!obj.customMetadata?.enc) return new Uint8Array(await obj.arrayBuffer());
    const data = await this.open(obj);
    if (!data) throw new ComfyUIError(`Image ${id} ${UNREADABLE}`);
    return data;
  }

  /** GET /img/<id>: the stored image, streamed (decrypted first if encrypted). HEAD: its headers
   * only (link previews ask that way). */
  async serve(id: string, head = false): Promise<Response> {
    const obj = refs.IMAGE_ID.test(id) ? await this.bucket.get(refs.imageKey(id)) : null;
    if (!obj) return new Response("This image does not exist, or it was deleted after a year.", { status: 404 });
    const meta = obj.customMetadata;
    if (head || !meta?.enc) {
      if (head) await obj.body?.cancel();
      const type = meta?.enc ? meta.type : obj.httpMetadata?.contentType;
      return imageResponse(head ? null : obj.body, type, meta?.enc ? obj.size - TAG_BYTES : obj.size, obj.httpEtag);
    }
    const data = await this.open(obj);
    if (!data) return new Response(`This image ${UNREADABLE}`, { status: 404 });
    return imageResponse(data, meta.type, data.length, obj.httpEtag);
  }

  /** An encrypted object's bytes, or null if it can't be opened (no key, another format, changed). */
  private async open(obj: StoredObject): Promise<Uint8Array | null> {
    const meta = obj.customMetadata ?? {};
    if (meta.enc !== ENC || !meta.iv) return null;
    const key = await this.imageKey();
    if (!key) return null;
    try {
      const iv = fromBase64(meta.iv);
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(obj.key) }, key, await obj.arrayBuffer()));
    } catch {
      return null; // the tag didn't match: the bytes or their id changed
    }
  }

  /** The image key: from the cached secrets, or the stored ones if this isolate hasn't seen it yet. */
  private imageKey(): Promise<CryptoKey | null> {
    this.key ??= (async () => {
      const hex = (await this.store.secrets()).image_key ?? (await this.fresh.secrets()).image_key;
      return hex ? importKey(hex) : null;
    })();
    return this.key;
  }
}

function importKey(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromHex(hex), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function imageResponse(body: BodyInit | null, type: string | undefined, length: number, etag: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": type ?? "application/octet-stream",
      "Content-Length": String(length),
      "Cache-Control": "private, max-age=86400",
      ETag: etag,
    },
  });
}
