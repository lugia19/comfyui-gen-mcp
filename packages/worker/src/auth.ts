// The settings pages' session: a signed, stateless cookie, and the password that opens it.
//
// The first login is always a Cloudflare API token that can see this Worker (App.login), which
// only the account's owner can make; setup needs that token anyway. That first login then sets a
// password (required), and later logins use either. A fresh install's address is not secret, so a
// password settable before the token login would let anyone claim it: it never is.
// The cookie format is a compatibility surface (test/golden.json pins it): changing it logs everyone
// out. So is the password record in the secrets (its algorithm and fields).

import { fromHex, hmacSha256, safeEqual, toHex, tokenHex, utf8 } from "@comfy-gen/core";

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

// Passwords: PBKDF2-SHA256 with a random salt. The iterations are few for a password hash (the
// free plan's CPU budget per request); the login lockout (App) is what stops guessing.
export const PASSWORD_MIN = 10;
export const PASSWORD_ITERATIONS = 20_000;

export type PasswordRecord = { salt: string; hash: string; iterations: number };

export async function hashPassword(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8(password) as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex) as BufferSource, iterations }, key, 256);
  return toHex(new Uint8Array(bits));
}

export async function makePassword(password: string, iterations = PASSWORD_ITERATIONS): Promise<PasswordRecord> {
  const salt = tokenHex(16);
  return { salt, hash: await hashPassword(password, salt, iterations), iterations };
}

export async function passwordOk(password: string, record: PasswordRecord | null | undefined): Promise<boolean> {
  if (!record?.salt || !record.hash || !password) return false;
  return safeEqual(await hashPassword(password, record.salt, record.iterations || PASSWORD_ITERATIONS), record.hash);
}
