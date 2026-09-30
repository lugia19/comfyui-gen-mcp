// The MCPB's machine hooks for the brain: the local ComfyUI must be ready for the pack (Machine's
// ensurePack, shared with the agent); edit_image takes paths on this machine (Claude Desktop runs
// here) or URLs.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ComfyUIError, Hooks, imageSize, refs, sniffMime, type ComfyUIClient, type Pack, type ResolvedImage } from "@comfy-gen/core";
import { USER_AGENT, type Machine } from "@comfy-gen/local";

export const MAX_IMAGE_BYTES = 50_000_000;
// ComfyUI's own annotated names ("sub/file.png [output]"), as the result text gives them for a
// ComfyUI the user runs.
const ANNOTATED = / \[(output|input|temp)\]$/;

export class LocalHooks extends Hooks {
  private machine: Machine;
  private client: ComfyUIClient;
  private settingsUrl: string;

  constructor(machine: Machine, client: ComfyUIClient, settingsUrl: string) {
    super();
    this.machine = machine;
    this.client = client;
    this.settingsUrl = settingsUrl;
  }

  get comfy() {
    return this.machine.comfy;
  }

  async ensure(pack: Pack): Promise<void> {
    await this.machine.ensurePack(pack, this.settingsUrl);
  }

  async resolveImage(arg: string): Promise<ResolvedImage> {
    let a = arg.trim().replace(/^saved_path:\s*/i, "").replace(/^(["'])(.*)\1$/, "$2");
    if (ANNOTATED.test(a)) return [a, null];
    if (/^https?:\/\//i.test(a)) return this.fromUrl(a);
    if (/^file:\/\//i.test(a)) a = fileURLToPath(a);
    if (a === "~" || a.startsWith("~/") || a.startsWith("~\\")) a = join(homedir(), a.slice(1));
    if (!isAbsolute(a)) throw new ComfyUIError(`${arg} is not an absolute path or a URL. Pass the full path of the image file, or a saved_path from an earlier result.`);
    const path = resolve(a);
    if (!existsSync(path) || !statSync(path).isFile()) throw new ComfyUIError(`No image file at ${path}.`);
    if (statSync(path).size > MAX_IMAGE_BYTES) throw new ComfyUIError(`${path} is too large (the limit is ${MAX_IMAGE_BYTES / 1e6} MB).`);
    const data = new Uint8Array(readFileSync(path));
    // An output of this ComfyUI loads in place; anything else is copied into its input folder.
    const output = this.comfy.install ? join(this.comfy.install.dir, "output") : null;
    const rel = output ? relative(output, path) : "..";
    if (!rel.startsWith("..") && !isAbsolute(rel) && sniffMime(data)) {
      return [`${rel.split("\\").join("/")} [output]`, imageSize(data)];
    }
    return this.upload(data, path);
  }

  private async fromUrl(url: string): Promise<ResolvedImage> {
    let resp: Response;
    try {
      resp = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new ComfyUIError(`Could not download ${url}: ${(e as Error).message}`);
    }
    if (!resp.ok) throw new ComfyUIError(`Could not download ${url} (HTTP ${resp.status}).`);
    const data = new Uint8Array(await resp.arrayBuffer());
    if (data.length > MAX_IMAGE_BYTES) throw new ComfyUIError(`${url} is too large (the limit is ${MAX_IMAGE_BYTES / 1e6} MB).`);
    return this.upload(data, url);
  }

  private async upload(data: Uint8Array, source: string): Promise<ResolvedImage> {
    const mime = sniffMime(data);
    if (!mime) throw new ComfyUIError(`${source} is not a PNG, JPEG, WebP or GIF image.`);
    // Named by content: the same image edited again reuses its copy instead of adding another.
    const name = refs.uploadFilename(createHash("sha256").update(data).digest("hex").slice(0, 16), mime);
    const image = await this.client.upload(data, name, mime, refs.UPLOAD_SUBFOLDER);
    return [image.loadValue(), imageSize(data)];
  }
}
