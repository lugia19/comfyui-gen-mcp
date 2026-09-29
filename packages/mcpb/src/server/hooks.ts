// The MCPB's machine hooks for the brain: the local ComfyUI must be running with the pack's nodes
// and models; edit_image takes paths on this machine (Claude Desktop runs here) or URLs.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ComfyUIError, Hooks, downloadSize, imageSize, refs, requiredNodes, sniffMime, tokenUrlsafe,
  type ComfyUIClient, type Pack, type ResolvedImage,
} from "@comfy-gen/core";
import { USER_AGENT, type LocalComfy, type ModelDownloads } from "@comfy-gen/local";

export const MAX_IMAGE_BYTES = 50_000_000;
// ComfyUI's own annotated names ("sub/file.png [output]"), as the result text gives them for a
// ComfyUI the user runs.
const ANNOTATED = / \[(output|input|temp)\]$/;

export class LocalHooks extends Hooks {
  private comfy: LocalComfy;
  private downloads: ModelDownloads;
  private client: ComfyUIClient;
  private settingsUrl: string;

  constructor(comfy: LocalComfy, downloads: ModelDownloads, client: ComfyUIClient, settingsUrl: string) {
    super();
    this.comfy = comfy;
    this.downloads = downloads;
    this.client = client;
    this.settingsUrl = settingsUrl;
  }

  async ensure(pack: Pack): Promise<void> {
    await this.comfy.refresh();
    if (this.comfy.state === "not_installed") await this.comfy.ensureRunning(); // throws: install first
    const managed = this.comfy.state !== "external";
    if (managed && pack.models?.length) {
      const name = pack.display_name ?? pack.name;
      let status = this.downloads.status(pack.name, pack.models);
      if (status.state === "missing" || status.state === "failed") status = this.downloads.start(pack.name, pack.models);
      if (status.state !== "done") {
        const pct = status.total ? Math.floor((100 * status.done) / status.total) : 0;
        const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
        const part = status.total < downloadSize(pack) ? ` (the rest of its ${gb(downloadSize(pack))} is already on this computer)` : "";
        throw new ComfyUIError(
          `The ${name} model is downloading: ${pct}% of ${gb(status.total)}${part}. ` +
            `Try again when it is done; progress is on the settings page, ${this.settingsUrl}`,
        );
      }
    }
    await this.comfy.ensureRunning();
    await this.comfy.ensureNodes(requiredNodes(pack));
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
    const image = await this.client.upload(data, refs.uploadFilename(tokenUrlsafe(9), mime), mime, refs.UPLOAD_SUBFOLDER);
    return [image.loadValue(), imageSize(data)];
  }
}
