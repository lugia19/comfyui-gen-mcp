// The Worker's Cloudflare OAuth tokens (installs created by the setup Worker, design §6): what it
// updates itself with. Kept in the State Durable Object under cf_oauth, and only touched there
// (index.ts State.cfAccessToken / cfSetTokens), one call at a time: every refresh rotates the refresh
// token, and two refreshes racing with the same one can get the whole grant revoked. The new pair is
// stored before the access token is handed out.

import { cfapi } from "@comfy-gen/core";
import type { Fetch } from "./platform.ts";

export const KEY = "cf_oauth";
/** Refresh this long before the access token expires (it lasts an hour). */
const MARGIN_S = 300;

type Stored = { access_token: string; refresh_token: string; expires_at: number; lost?: string | null };
export type TokenAnswer = { token: string } | { lost: string };

export interface KeyValue {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** Calls through a Lock run one after another, in order. */
export class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

export async function setTokens(kv: KeyValue, tokens: cfapi.OAuthTokens, now: number): Promise<void> {
  const stored: Stored = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: now + tokens.expires_in, lost: null };
  await kv.put(KEY, JSON.stringify(stored));
}

/** An access token, refreshed first when it is about to expire. {lost}: the
 * connection is gone (never made, revoked, or the refresh token expired): the user must connect
 * again; the reason is kept so the page can say so. */
export async function accessToken(kv: KeyValue, fetch: Fetch, clientId: string, now: number): Promise<TokenAnswer> {
  const raw = await kv.get(KEY);
  if (!raw) return { lost: "not connected to Cloudflare" };
  const s: Stored = JSON.parse(raw);
  if (s.lost) return { lost: s.lost };
  if (s.expires_at - now > MARGIN_S) return { token: s.access_token };
  try {
    const fresh = await cfapi.refreshTokens(fetch, clientId, s.refresh_token);
    await setTokens(kv, fresh, now);
    return { token: fresh.access_token };
  } catch (e) {
    if (!(e instanceof cfapi.OAuthError)) throw e; // network trouble: try again next time
    if (e.error !== "invalid_grant") throw e;
    await kv.put(KEY, JSON.stringify({ ...s, lost: e.message }));
    return { lost: e.message };
  }
}

export async function isLost(kv: KeyValue): Promise<string | null> {
  const raw = await kv.get(KEY);
  return raw ? (JSON.parse(raw) as Stored).lost ?? null : null;
}
