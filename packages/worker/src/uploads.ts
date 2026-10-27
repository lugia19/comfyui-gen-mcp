// Images the user attached in claude.ai, uploaded through the code-execution sandbox (S3).
//
// request_upload hands the model a one-time link and a Python snippet. The sandbox runs the
// snippet, which posts the attached file to /upload/<token>; the Worker stores it in R2 and answers
// with an image id that edit_image takes. No GPU needs to be online for it. Scripted callers read
// the link itself from the result's _meta (design §3, Scripted callers) and post to it themselves.

import { error, failResult, json, refs, sniffMime, textBlock as text, type Content } from "@comfy-gen/core";
import type { Images } from "./images.ts";

export const UPLOAD_TTL_S = 600;
export const MAX_IMAGE_BYTES = 20_000_000;

export class BadImage extends Error {
  name = "BadImage";
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The image's mime type. Throws BadImage for anything that isn't a supported image of a sane size. */
export function checkImage(data: Uint8Array): string {
  const mime = sniffMime(data);
  if (!mime) throw new BadImage(415, "not a PNG, JPEG, WebP or GIF image");
  if (data.length > MAX_IMAGE_BYTES) {
    throw new BadImage(413, `too large (${Math.floor(data.length / 1e6)} MB; the limit is ${MAX_IMAGE_BYTES / 1e6} MB)`);
  }
  return mime;
}

/** A Python string literal (repr-style), for the snippet. */
function pyStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").split(quote).join("\\" + quote);
  return quote + body + quote;
}

// The snippet sets its own User-Agent: Cloudflare rejects urllib's default with Error 1010.
function snippet(filename: string, url: string): string {
  return `import glob, os, urllib.request
name = ${pyStr(filename)}
hits = [p for root in ("/mnt", os.getcwd(), os.path.expanduser("~"))
        for p in glob.glob(os.path.join(root, "**", name), recursive=True)]
if not hits:
    raise SystemExit(f"{name} not found; attached files are usually under /mnt/user-data/uploads")
data = open(hits[0], "rb").read()
req = urllib.request.Request(${pyStr(url)}, data=data, method="POST",
                             headers={"Content-Type": "application/octet-stream",
                                      "User-Agent": "comfy-gen-upload"})
print(urllib.request.urlopen(req, timeout=120).read().decode())
`;
}

/** The request_upload tool: a fresh link and the snippet to use it; for scripted callers, the link
 * in the result (`upload_url`), and `filename` (only the snippet's) may be left out. */
export async function requestUpload(args: Record<string, any>, baseUrl: string, key: Uint8Array, now: number): Promise<[Content[], boolean, Record<string, any>?]> {
  const filename = String(args.filename || "").trim();
  const token = await refs.mintUpload(key, now, UPLOAD_TTL_S);
  const url = `${baseUrl}/upload/${token}`;
  const result = { status: "done", upload_url: url, expires_in_s: UPLOAD_TTL_S };
  if (!filename) {
    return [[text(`POST the image's bytes to ${url} (once, within 10 minutes); the answer is a JSON object with its image_id.`)], false, result];
  }
  return [
    [
      text(
        "Run this Python in your code execution environment. It uploads the attached file and prints " +
          "a JSON object with an image_id; pass that image_id to edit_image. The link expires in 10 " +
          "minutes. If the request is blocked, the user needs to allow this domain in their code " +
          "execution network settings.\n\n```python\n" + snippet(filename, url) + "```",
      ),
    ],
    false,
    result,
  ];
}

/** POST /upload/<token>: store the body in R2 under the token's nonce, answer with that image id. */
export async function receive(token: string, body: Uint8Array, images: Images, key: Uint8Array, now: number): Promise<Response> {
  let id: string;
  try {
    id = await refs.checkUpload(token, key, now);
  } catch (e) {
    if (e instanceof refs.RefError) return error(403, e.message);
    throw e;
  }
  if (!refs.IMAGE_ID.test(id)) return error(403, "Invalid upload link.");
  if (!body.length) return error(400, "empty body");
  try {
    const mime = checkImage(body);
    await images.put(body, id);
    return json({ image_id: id, bytes: body.length, mime });
  } catch (e) {
    if (e instanceof BadImage) return error(e.status, e.message);
    throw e;
  }
}
