// The Worker's machine hooks for the brain.
//
// ensure: on Modal, a pack's models must be on the Volume before a prompt reaches the GPU;
// otherwise the call says the download is under way (starting it if needed) instead of failing
// inside ComfyUI.
//
// resolveImage: an image id is read from R2 (images live there, not on any GPU) and uploaded into
// the answering ComfyUI's inputs, under a name derived from the id, so editing the same image
// twice reuses one file. An https URL is downloaded and uploaded the same way.

import { ComfyUIError, Hooks, imageSize, refs, relay, tokenUrlsafe, type ComfyUIClient, type Pack, type ResolvedImage } from "@comfy-gen/core";
import { getImage } from "./images.ts";
import { ModalAdminError, packStatus, type ModalAdmin } from "./modal-admin.ts";
import type { Gpu } from "./gpus.ts";
import type { Bucket, Fetch } from "./platform.ts";
import type { RelayStub } from "./relay.ts";
import type { Store } from "./store.ts";
import { BadImage, storeInput } from "./uploads.ts";

export class WorkerHooks extends Hooks {
  private client: ComfyUIClient;
  private key: Uint8Array;
  private fetch: Fetch;
  private admin: ModalAdmin | null;
  private store: Store;
  private settingsUrl: string;
  private bucket: Bucket;
  /** Told whether this GPU has a pack's models: routing then sends the call elsewhere meanwhile. */
  protected onReady: (pack: string, ready: boolean) => Promise<void>;

  constructor(
    client: ComfyUIClient,
    key: Uint8Array,
    fetch: Fetch,
    admin: ModalAdmin | null,
    store: Store,
    settingsUrl: string,
    bucket: Bucket,
    onReady: (pack: string, ready: boolean) => Promise<void> = async () => {},
  ) {
    super();
    this.bucket = bucket;
    this.onReady = onReady;
    this.client = client;
    this.key = key;
    this.fetch = fetch;
    this.admin = admin;
    this.store = store;
    this.settingsUrl = settingsUrl;
  }

  async ensure(pack: Pack): Promise<void> {
    if (!this.admin || !pack.models?.length) return;
    const name = pack.display_name ?? pack.name;
    let status: Record<string, any>;
    try {
      status = await packStatus(this.admin, this.store, pack);
      if (status.state === "done") return;
      if (status.state === "missing" || status.state === "failed") {
        await this.admin.seed(pack);
        status = { state: "queued" };
      }
    } catch (e) {
      if (e instanceof ModalAdminError) return; // the admin API is down; let ComfyUI try
      throw e;
    }
    await this.onReady(pack.name, false);
    if (status.state === "downloading" && status.total) {
      const pct = Math.floor((100 * (status.done ?? 0)) / status.total);
      throw new ComfyUIError(`The ${name} model is still downloading to your GPU (${pct}%). Try again in a few minutes.`);
    }
    throw new ComfyUIError(`The ${name} model is being downloaded to your GPU. Try again in a few minutes; progress is on ${this.settingsUrl}.`);
  }

  async resolveImage(arg: string): Promise<ResolvedImage> {
    arg = arg.trim();
    if (arg.startsWith("https://") || arg.startsWith("http://")) return this.fromUrl(arg);
    let id: string;
    try {
      id = refs.imageIdIn(arg);
    } catch (e) {
      if (!(e instanceof refs.RefError)) throw e;
      throw new ComfyUIError(`${e.message} Pass an image_id from an earlier result or from request_upload, or a public https URL.`);
    }
    const data = await getImage(this.bucket, id);
    if (!data) throw new ComfyUIError(`There is no image ${id}: it was deleted after a year, or the id is mistyped.`);
    return this.input(data, id, `Image ${id}`);
  }

  /** Bytes into this ComfyUI's inputs: [what LoadImage takes, the size]. */
  private async input(data: Uint8Array, nonce: string, what: string): Promise<ResolvedImage> {
    try {
      const uploaded = await storeInput(this.client, data, nonce);
      return [uploaded.loadValue(), imageSize(data)];
    } catch (e) {
      if (e instanceof BadImage) throw new ComfyUIError(`${what}: ${e.message}.`);
      throw e;
    }
  }

  private async fromUrl(url: string): Promise<ResolvedImage> {
    let resp: Response;
    try {
      resp = await this.fetch(url, { method: "GET" });
    } catch (e) {
      throw new ComfyUIError(`Could not download ${url}: ${e}`);
    }
    if (resp.status !== 200) throw new ComfyUIError(`Could not download ${url} (HTTP ${resp.status}). The URL must be public.`);
    return this.input(new Uint8Array(await resp.arrayBuffer()), tokenUrlsafe(9), url);
  }
}

/** None of these GPUs is taking calls because each is paused (a PC, from its tray or the page). */
export function pausedMessage(gpus: Gpu[]): string {
  const names = gpus.map((g) => g.name).join(", ");
  return `${names} ${gpus.length > 1 ? "are" : "is"} paused: not taking image requests. Take requests again from the Comfy-Gen tray icon, or the settings page, then try again.`;
}

/** These GPUs are offline (a PC whose agent is not connected). */
export function offlineMessage(gpus: Gpu[]): string {
  const names = gpus.map((g) => g.name).join(", ");
  return `${names} ${gpus.length > 1 ? "are" : "is"} offline. Start the PC (the Comfy-Gen agent starts with it), or check its tray icon, then try again.`;
}
// Starting ComfyUI and installing a node package can take minutes; the MCP client gives up at 5.
export const ENSURE_TIMEOUT_S = 240;

/** The PC path: the agent makes its ComfyUI ready for a pack (running, nodes, models), as the
 * MCPB does locally; images resolve as on Modal (from R2 or a URL, uploaded through the relay). */
export class PcHooks extends WorkerHooks {
  private relay: RelayStub;
  private gpu: Gpu;

  constructor(
    client: ComfyUIClient,
    key: Uint8Array,
    fetch: Fetch,
    store: Store,
    settingsUrl: string,
    relayStub: RelayStub,
    gpu: Gpu,
    bucket: Bucket,
    onReady: (pack: string, ready: boolean) => Promise<void> = async () => {},
  ) {
    super(client, key, fetch, null, store, settingsUrl, bucket, onReady);
    this.relay = relayStub;
    this.gpu = gpu;
  }

  /** The agent makes the pack ready; the answer also tells routing whether this PC has the pack. */
  async ensure(pack: Pack): Promise<void> {
    const args = {
      pack: { name: pack.name, display_name: pack.display_name ?? pack.name, models: pack.models ?? [], required_nodes: pack.required_nodes ?? {} },
      keep_warm_minutes: this.gpu.keep_warm_minutes,
    };
    const r = await this.relay.control("ensure", args, ENSURE_TIMEOUT_S);
    if (r.offline) throw new ComfyUIError(offlineMessage([this.gpu]));
    const result = relay.controlResult(r.status, r.body);
    if (!result.ok) {
      if (/download/i.test(result.message)) await this.onReady(pack.name, false);
      throw new ComfyUIError(result.message);
    }
    await this.onReady(pack.name, true);
  }
}
