// The Worker's machine hooks for the brain.
//
// ensure: on Modal, a pack's models must be on the Volume before a prompt reaches the GPU;
// otherwise the call says the download is under way (starting it if needed) instead of failing
// inside ComfyUI.
//
// resolveImage: an image id is read from R2 (images live there, not on any GPU) and uploaded into
// the answering ComfyUI's inputs, under a name derived from the id, so editing the same image
// twice reuses one file. An https URL is downloaded and uploaded the same way.

import { ComfyUIError, Hooks, isModelSet, packNeeds, refs, relay, tokenUrlsafe, uploadInput, type ComfyUIClient, type Pack, type ResolvedImage } from "@comfy-gen/core";
import type { Images } from "./images.ts";
import { ModalAdminError, packStatus, type ModalAdmin } from "./modal-admin.ts";
import type { Gpu } from "./gpus.ts";
import type { Fetch } from "./platform.ts";
import type { RelayStub } from "./relay.ts";
import type { Store } from "./store.ts";
import { MAX_IMAGE_BYTES } from "./uploads.ts";

const RETRY = { retryable: true };
// The agent's (local machine.ts) and the Worker's own words for a model download that is under way.
const DOWNLOADING = /is downloading|still downloading|being downloaded/i;

export class WorkerHooks extends Hooks {
  private client: ComfyUIClient;
  private key: Uint8Array;
  private fetch: Fetch;
  private admin: ModalAdmin | null;
  private store: Store;
  private settingsUrl: string;
  private images: Images;
  /** Told whether this GPU has a pack's models: routing then sends the call elsewhere meanwhile. */
  protected onReady: (pack: string, ready: boolean) => Promise<void>;

  constructor(
    client: ComfyUIClient,
    key: Uint8Array,
    fetch: Fetch,
    admin: ModalAdmin | null,
    store: Store,
    settingsUrl: string,
    images: Images,
    onReady: (pack: string, ready: boolean) => Promise<void> = async () => {},
  ) {
    super();
    this.images = images;
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
      throw new ComfyUIError(`The ${name} model is still downloading to your GPU (${pct}%). Try again in a few minutes.`, RETRY);
    }
    const where = isModelSet(pack) ? "" : `; progress is on ${this.settingsUrl}`; // a model set isn't listed there
    throw new ComfyUIError(`The ${name} model is being downloaded to your GPU. Try again in a few minutes${where}.`, RETRY);
  }

  async resolveImage(arg: string): Promise<ResolvedImage> {
    arg = arg.trim();
    if (arg.startsWith("https://") || arg.startsWith("http://")) {
      // This Worker's own image link is read as its id: a Worker can't fetch its own workers.dev URL.
      const own = ownImageId(arg, new URL(this.settingsUrl).origin);
      if (own === null) return this.fromUrl(arg);
      arg = own;
    }
    let id: string;
    try {
      id = refs.imageIdIn(arg);
    } catch (e) {
      if (!(e instanceof refs.RefError)) throw e;
      throw new ComfyUIError(`${e.message} Pass an image_id from an earlier result or from request_upload, or a public https URL.`);
    }
    const data = await this.images.get(id);
    if (!data) throw new ComfyUIError(`There is no image ${id}: it was deleted after a year, or the id is mistyped.`);
    return uploadInput(this.client, data, id, `Image ${id}`, MAX_IMAGE_BYTES);
  }

  private async fromUrl(url: string): Promise<ResolvedImage> {
    let resp: Response;
    try {
      resp = await this.fetch(url, { method: "GET" });
    } catch (e) {
      throw new ComfyUIError(`Could not download ${url}: ${e}`);
    }
    if (resp.status !== 200) throw new ComfyUIError(`Could not download ${url} (HTTP ${resp.status}). The URL must be public.`);
    return uploadInput(this.client, new Uint8Array(await resp.arrayBuffer()), tokenUrlsafe(9), url, MAX_IMAGE_BYTES);
  }
}

/** "A", "A and B", "A, B and C". */
const listNames = (gpus: Gpu[]) => {
  const names = gpus.map((g) => g.name);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
};

/** None of these GPUs is taking calls because each is paused (a PC, from its tray or the page). */
export function pausedMessage(gpus: Gpu[]): string {
  const many = gpus.length > 1;
  return `${listNames(gpus)} ${many ? "are" : "is"} paused: not taking image requests. Take requests again from ${many ? "their" : "its"} Comfy-Gen tray icon${many ? "s" : ""}, or the settings page, then try again.`;
}

/** These GPUs are offline (a PC whose agent is not connected). */
export function offlineMessage(gpus: Gpu[]): string {
  const many = gpus.length > 1;
  return many
    ? `${listNames(gpus)} are offline. Start them (the Comfy-Gen agent starts with each), or check their tray icons, then try again.`
    : `${listNames(gpus)} is offline. Start the PC (the Comfy-Gen agent starts with it), or check its tray icon, then try again.`;
}
// Starting ComfyUI and installing a node package can take minutes, longer than a call may wait
// (DEFAULT_WAIT_S). Past this the call says so; the agent carries on, and the next call joins it.
export const ENSURE_TIMEOUT_S = 100;

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
    images: Images,
    onReady: (pack: string, ready: boolean) => Promise<void> = async () => {},
  ) {
    super(client, key, fetch, null, store, settingsUrl, images, onReady);
    this.relay = relayStub;
    this.gpu = gpu;
  }

  /** The agent makes the pack ready; the answer also tells routing whether this PC has the pack. */
  async ensure(pack: Pack): Promise<void> {
    const args = {
      pack: packNeeds(pack),
      keep_warm_minutes: this.gpu.keep_warm_minutes,
      comfy_args: this.gpu.comfy_args ?? [],
    };
    const r = await this.relay.control("ensure", args, ENSURE_TIMEOUT_S);
    if (r.offline) throw new ComfyUIError(offlineMessage([this.gpu]));
    if (r.status === 504) throw new ComfyUIError(`ComfyUI is still starting on ${this.gpu.name}. Call the tool again in a minute.`, RETRY);
    const result = relay.controlResult(r.status, r.body);
    if (!result.ok) {
      if (/download/i.test(result.message)) await this.onReady(pack.name, false);
      // The agent's words: a download in progress will finish; "can't be downloaded" won't.
      throw new ComfyUIError(result.message, { retryable: DOWNLOADING.test(result.message) });
    }
    await this.onReady(pack.name, true);
  }
}

/** The image id in *url* when it is this Worker's (*origin*) `/img/<id>` link, else null. */
export function ownImageId(url: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = /^\/img\/([^/]+)$/.exec(u.pathname);
  return m && u.origin === origin ? decodeURIComponent(m[1]) : null;
}

/** The stored image an image argument names (an id, or this Worker's own link), or null. */
export function storedImageId(arg: string, origin: string): string | null {
  arg = arg.trim();
  if (/^https?:\/\//.test(arg)) return ownImageId(arg, origin);
  try {
    return refs.imageIdIn(arg);
  } catch {
    return null;
  }
}
