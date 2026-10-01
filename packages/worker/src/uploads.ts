// Images the user attached in claude.ai, uploaded through the code-execution sandbox (S3).
//
// request_upload hands the model a one-time link and a Python snippet. The sandbox runs the
// snippet, which posts the attached file to /upload/<token>; the Worker stores it in ComfyUI's input
// folder and answers with an image id that edit_image takes.

import { ComfyUIError, refs, sniffMime, type ComfyUIClient, type Content, type OutputImage } from "@comfy-gen/core";
import { error, json } from "./platform.ts";
import { text } from "./render.ts";

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

/** Put image bytes in ComfyUI's input folder: [the stored image, its mime type]. Throws BadImage
 * for anything that isn't a supported image of a sane size. */
export async function storeInput(client: ComfyUIClient, data: Uint8Array, nonce: string): Promise<[OutputImage, string]> {
  const mime = sniffMime(data);
  if (!mime) throw new BadImage(415, "not a PNG, JPEG, WebP or GIF image");
  if (data.length > MAX_IMAGE_BYTES) {
    throw new BadImage(413, `too large (${Math.floor(data.length / 1e6)} MB; the limit is ${MAX_IMAGE_BYTES / 1e6} MB)`);
  }
  const image = await client.upload(data, refs.uploadFilename(nonce, mime), mime, refs.UPLOAD_SUBFOLDER);
  return [image, mime];
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

/** The request_upload tool: a fresh link and the snippet to use it. */
export async function requestUpload(args: Record<string, any>, baseUrl: string, key: Uint8Array, now: number): Promise<[Content[], boolean]> {
  const filename = String(args.filename || "").trim();
  if (!filename) return [[text("Error: filename is required.")], true];
  const token = await refs.mintUpload(key, now, UPLOAD_TTL_S);
  const code = snippet(filename, `${baseUrl}/upload/${token}`);
  return [
    [
      text(
        "Run this Python in your code execution environment. It uploads the attached file and prints " +
          "a JSON object with an image_id; pass that image_id to edit_image. The link expires in 10 " +
          "minutes. If the request is blocked, the user needs to allow this domain in their code " +
          "execution network settings.\n\n```python\n" + code + "```",
      ),
    ],
    false,
  ];
}

/** POST /upload/<token>: store the body in ComfyUI's input folder, answer with its image id. */
export async function receive(
  token: string,
  body: Uint8Array,
  client: ComfyUIClient,
  key: Uint8Array,
  now: number,
  backend: refs.Backend = "main",
): Promise<Response> {
  let nonce: string;
  try {
    nonce = await refs.checkUpload(token, key, now);
  } catch (e) {
    if (e instanceof refs.RefError) return error(403, e.message);
    throw e;
  }
  if (!body.length) return error(400, "empty body");
  try {
    const [image, mime] = await storeInput(client, body, nonce);
    return json({ image_id: await refs.imageId(image, key, backend), bytes: body.length, mime });
  } catch (e) {
    if (e instanceof BadImage) return error(e.status, e.message);
    if (e instanceof ComfyUIError) return error(502, e.message);
    throw e;
  }
}
