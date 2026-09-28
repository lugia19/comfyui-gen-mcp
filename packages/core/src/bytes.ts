// Bytes, text and randomness with Web-platform APIs only, so core runs in Workers and Node alike.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(data: Uint8Array): string {
  return decoder.decode(data);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function startsWith(data: Uint8Array, prefix: Uint8Array | string): boolean {
  const p = typeof prefix === "string" ? utf8(prefix) : prefix;
  if (data.length < p.length) return false;
  for (let i = 0; i < p.length; i++) if (data[i] !== p[i]) return false;
  return true;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The native encoder (ES2026; in Workers, not yet in Node 22) costs about 3 ms of billed CPU per MB
// against 55 ms for the fallback, which dominated a generation's CPU (design appendix). The fallback
// is chunked: String.fromCharCode(...bytes) on a whole image overflows the stack.
const nativeToBase64: ((this: Uint8Array) => string) | undefined = (Uint8Array.prototype as any).toBase64;

export function toBase64(data: Uint8Array): string {
  if (nativeToBase64) return nativeToBase64.call(data);
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64Url(data: Uint8Array): string {
  return toBase64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Like Python's secrets.token_urlsafe(n): n random bytes, base64url. */
export function tokenUrlsafe(n: number): string {
  return toBase64Url(randomBytes(n));
}

/** Like Python's secrets.token_hex(n). */
export function tokenHex(n: number): string {
  return toHex(randomBytes(n));
}

/** A uniform integer in [0, 2^53 - 1]: exact as a JS number and within ComfyUI's seed range. */
export function randomSeed(): number {
  const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
  return (hi & 0x1fffff) * 2 ** 32 + lo;
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Python's round(): half to even. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
