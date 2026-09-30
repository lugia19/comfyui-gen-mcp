// The Worker's machine hooks for the brain.
//
// ensure: on Modal, a pack's models must be on the Volume before a prompt reaches the GPU;
// otherwise the call says the download is under way (starting it if needed) instead of failing
// inside ComfyUI.
//
// resolveImage: an image id resolves to a file ComfyUI already has (an output, or an earlier
// upload): nothing is transferred. An https URL is fetched and uploaded to ComfyUI's input folder.

import { ComfyUIError, Hooks, imageSize, refs, relay, tokenUrlsafe, type ComfyUIClient, type Pack, type ResolvedImage } from "@comfy-gen/core";
import { ModalAdminError, packStatus, type ModalAdmin } from "./modal-admin.ts";
import type { Fetch } from "./platform.ts";
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

  constructor(client: ComfyUIClient, key: Uint8Array, fetch: Fetch, admin: ModalAdmin | null, store: Store, settingsUrl: string) {
    super();
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
    if (status.state === "downloading" && status.total) {
      const pct = Math.floor((100 * (status.done ?? 0)) / status.total);
      throw new ComfyUIError(`The ${name} model is still downloading to your GPU (${pct}%). Try again in a few minutes.`);
    }
    throw new ComfyUIError(`The ${name} model is being downloaded to your GPU. Try again in a few minutes; progress is on ${this.settingsUrl}.`);
  }

  async resolveImage(arg: string): Promise<ResolvedImage> {
    arg = arg.trim();
    if (arg.startsWith("https://") || arg.startsWith("http://")) return this.fromUrl(arg);
    if (arg.toLowerCase().startsWith("image_id:")) arg = arg.slice(arg.indexOf(":") + 1).trim(); // the label copied along
    try {
      const image = await refs.verify(arg, this.key);
      return [image.loadValue(), null]; // ComfyUI has it; outputs from our packs are within budget
    } catch (e) {
      if (!(e instanceof refs.RefError)) throw e;
      throw new ComfyUIError(`${e.message} Pass an image_id from an earlier result or from request_upload, or a public https URL.`);
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
    const data = new Uint8Array(await resp.arrayBuffer());
    try {
      const [uploaded] = await storeInput(this.client, data, tokenUrlsafe(9));
      return [uploaded.loadValue(), imageSize(data)];
    } catch (e) {
      if (e instanceof BadImage) throw new ComfyUIError(`${url}: ${e.message}.`);
      throw e;
    }
  }
}

export const PC_OFFLINE =
  "Your PC is offline. Start it (the Comfy-Gen agent starts with it), or check its tray icon, then try again.";
// Starting ComfyUI and installing a node package can take minutes; the MCP client gives up at 5.
export const ENSURE_TIMEOUT_S = 240;

/** The PC path: the agent makes its ComfyUI ready for a pack (running, nodes, models), as the
 * MCPB does locally; images resolve as on Modal (ids of outputs, URLs uploaded through the relay). */
export class PcHooks extends WorkerHooks {
  private relay: RelayStub;
  private keepWarmMinutes: number;

  constructor(client: ComfyUIClient, key: Uint8Array, fetch: Fetch, store: Store, settingsUrl: string, relayStub: RelayStub, keepWarmMinutes: number) {
    super(client, key, fetch, null, store, settingsUrl);
    this.relay = relayStub;
    this.keepWarmMinutes = keepWarmMinutes;
  }

  async ensure(pack: Pack): Promise<void> {
    const args = {
      pack: { name: pack.name, display_name: pack.display_name ?? pack.name, models: pack.models ?? [], required_nodes: pack.required_nodes ?? {} },
      keep_warm_minutes: this.keepWarmMinutes,
    };
    const r = await this.relay.control("ensure", args, ENSURE_TIMEOUT_S);
    if (r.offline) throw new ComfyUIError(PC_OFFLINE);
    const result = relay.controlResult(r.status, r.body);
    if (!result.ok) throw new ComfyUIError(result.message);
  }
}
