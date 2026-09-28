// The Modal app's admin API (comfy_gen_modal.app.admin), as the Worker uses it: download a pack's
// models onto the Volume, read the progress, set keep-warm. Same proxy token as ComfyUI.

import type { Pack } from "@comfy-gen/core";
import type { Fetch } from "./platform.ts";
import type { Store } from "./store.ts";

export class ModalAdminError extends Error {
  name = "ModalAdminError";
}

export class ModalAdmin {
  private fetch: Fetch;
  private url: string;
  private headers: Record<string, string>;

  constructor(fetch: Fetch, url: string, headers: Record<string, string>) {
    this.fetch = fetch;
    this.url = url.replace(/\/+$/, "");
    this.headers = headers;
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    let resp: Response;
    try {
      resp = await this.fetch(this.url + path, {
        method,
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ModalAdminError(`Could not reach the Modal app: ${e}`);
    }
    if (resp.status !== 200) throw new ModalAdminError(`The Modal app answered HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return resp.json();
  }

  seed(pack: Pack): Promise<any> {
    return this.call("POST", "/seed", { pack: pack.name, models: pack.models });
  }

  status(packName: string): Promise<any> {
    return this.call("GET", `/seed/${packName}`);
  }

  async diagnostics(): Promise<any> {
    return { status: await this.call("GET", "/status"), files: await this.call("GET", "/files") };
  }

  idle(minutes: number): Promise<any> {
    return this.call("POST", "/idle", { seconds: Math.max(60, Math.min(3600, minutes * 60)) });
  }
}

/** The admin client for a Modal generator; null for any other kind. */
export function forGenerator(fetch: Fetch, generator: Record<string, any> | null | undefined): ModalAdmin | null {
  if (!generator || generator.kind !== "modal" || !generator.admin_url) return null;
  return new ModalAdmin(fetch, generator.admin_url, generator.headers ?? {});
}

// Packs known to be fully on the Volume, in the setup key, so a ready pack costs no admin call.

/** The pack's seed state: {state: done|queued|downloading|failed|missing, done, total, error}. */
export async function packStatus(admin: ModalAdmin, store: Store, pack: Pack): Promise<Record<string, any>> {
  const seeded: string[] = (await store.setup()).seeded ?? [];
  if (seeded.includes(pack.name)) return { state: "done" };
  const status = await admin.status(pack.name);
  if (status?.state === "done") await store.updateSetup({ seeded: [...new Set([...seeded, pack.name])].sort() });
  return status;
}

/** Start downloads for the packs not known to be on the Volume. Returns warnings, never throws. */
export async function seedMissing(admin: ModalAdmin, store: Store, packs: Pack[]): Promise<string[]> {
  const seeded: string[] = (await store.setup()).seeded ?? [];
  const warnings: string[] = [];
  for (const pack of packs) {
    if (seeded.includes(pack.name) || !pack.models?.length) continue;
    try {
      await admin.seed(pack);
    } catch (e) {
      if (!(e instanceof ModalAdminError)) throw e;
      warnings.push(`Could not start downloading ${pack.display_name ?? pack.name}: ${e.message}`);
    }
  }
  return warnings;
}
