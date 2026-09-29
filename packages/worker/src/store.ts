// The Worker's state, in the State Durable Object (index.ts), cached per isolate.
//
// Three keys, read on most requests, written rarely:
//   config   the user config (@comfy-gen/core config shape)
//   secrets  generated keys, the Cloudflare token and discovery, the generator's URL and headers
//   setup    setup progress: the current build and its nonce, packs known to be downloaded
//
// Reads, missing keys included, are cached per isolate for CACHE_S, so a warm MCP call costs no
// storage reads. Writes update the cache of the isolate that made them; another isolate sees them
// within CACHE_S. The settings pages use new Store(storage, now, false): right after a login or a save,
// the next page load may land on another isolate, and it must not show the state from before.
// The values are JSON strings, a compatibility surface: existing installs hold them.

import { normalize, tokenHex, tokenUrlsafe, type Config } from "@comfy-gen/core";
import type { StateStorage } from "./platform.ts";

export const CACHE_S = 30;

// Plain data only at module scope: it survives across requests in one isolate.
const cache = new Map<string, [number, any]>();

export function clearCache(): void {
  cache.clear();
}

export function cacheEntry(key: string, value: [number, any]): void {
  cache.set(key, value); // for tests: what another isolate might still hold
}

export type Secrets = Record<string, any> & { mcp_secret: string; hmac_key: string; cookie_key: string };

export class Store {
  private storage: StateStorage;
  private now: () => number;
  private useCache: boolean;

  constructor(storage: StateStorage, now: () => number, useCache = true) {
    this.storage = storage;
    this.now = now;
    this.useCache = useCache;
  }

  private async get<T>(key: string, transform?: (v: any) => T): Promise<T> {
    const hit = this.useCache ? cache.get(key) : undefined;
    if (hit && this.now() - hit[0] < CACHE_S) return hit[1];
    const raw = await this.storage.get(key);
    let data = raw ? JSON.parse(raw) : null;
    if (transform) data = transform(data);
    cache.set(key, [this.now(), data]);
    return data;
  }

  private async put(key: string, data: unknown): Promise<void> {
    await this.storage.put(key, JSON.stringify(data));
    cache.set(key, [this.now(), data]);
  }

  config(): Promise<Config> {
    return this.get("config", normalize);
  }

  async saveConfig(raw: unknown): Promise<Config> {
    const cfg = normalize(raw);
    await this.put("config", cfg);
    return cfg;
  }

  /** The secrets, generating the Worker's own keys on first use (one write, ever). */
  async secrets(): Promise<Secrets> {
    let data = await this.get<Record<string, any> | null>("secrets");
    if (!data || !("mcp_secret" in data)) {
      data = { ...(data ?? {}), mcp_secret: tokenUrlsafe(24), hmac_key: tokenHex(32), cookie_key: tokenHex(32) };
      await this.put("secrets", data);
    }
    return data as Secrets;
  }

  async updateSecrets(changes: Record<string, unknown>): Promise<void> {
    await this.update("secrets", await this.secrets(), changes);
  }

  async setup(): Promise<Record<string, any>> {
    return (await this.get<Record<string, any> | null>("setup")) ?? {};
  }

  async updateSetup(changes: Record<string, unknown>): Promise<void> {
    await this.update("setup", await this.setup(), changes);
  }

  /** Merge *changes* in; a null value removes the key. */
  private async update(key: string, current: Record<string, any>, changes: Record<string, unknown>): Promise<void> {
    const data = { ...current, ...changes };
    await this.put(key, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined)));
  }
}
