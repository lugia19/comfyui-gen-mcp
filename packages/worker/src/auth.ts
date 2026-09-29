// The settings pages' session: a signed, stateless cookie.
//
// There is no password. Logging in means pasting a Cloudflare API token that can see this Worker
// (App.login), which only the account's owner can make; setup needs that token anyway. So the
// cookie lasts a year, and a new browser logs in with a fresh token from the same link.
// The format is a compatibility surface (test/golden.json pins it): changing it logs everyone out.

import { fromHex, hmacSha256, safeEqual, toHex } from "@comfy-gen/core";

export const COOKIE = "cg_session";
export const SESSION_S = 365 * 24 * 3600;

async function hmacHex(keyHex: string, message: string): Promise<string> {
  return toHex(await hmacSha256(fromHex(keyHex), message));
}

export async function makeSession(cookieKey: string, now: number): Promise<string> {
  const expires = String(Math.trunc(now + SESSION_S));
  return `${expires}.${await hmacHex(cookieKey, expires)}`;
}

export async function sessionOk(value: string | null, cookieKey: string, now: number): Promise<boolean> {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot < 0) return false;
  const expires = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  return safeEqual(mac, await hmacHex(cookieKey, expires)) && /^\d+$/.test(expires) && Number(expires) > now;
}

export function cookieHeader(value: string, maxAge = SESSION_S): string {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function readCookie(header: string | null): string | null {
  for (const part of (header ?? "").split(";")) {
    const p = part.trim();
    const eq = p.indexOf("=");
    const name = eq < 0 ? p : p.slice(0, eq);
    if (name === COOKIE) return eq < 0 ? "" : p.slice(eq + 1);
  }
  return null;
}
