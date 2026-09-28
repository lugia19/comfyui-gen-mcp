// Image format and size from header bytes, without decoding. The Worker only needs the mime type
// and the pixel count, which live in the first few hundred bytes.

import { startsWith } from "./bytes.ts";

// JPEG start-of-frame markers carry the dimensions. C4 (DHT), C8 (JPG) and CC (DAC) are not SOFs.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const ascii = (data: Uint8Array, start: number, end: number) => String.fromCharCode(...data.subarray(start, end));

export function sniffMime(data: Uint8Array): string | null {
  if (startsWith(data, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (startsWith(data, new Uint8Array([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") return "image/webp";
  const gif = ascii(data, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  return null;
}

/** [width, height] of a PNG, JPEG, WebP or GIF, or null if unknown or truncated. */
export function imageSize(data: Uint8Array): [number, number] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  try {
    switch (sniffMime(data)) {
      case "image/png":
        return [view.getUint32(16), view.getUint32(20)];
      case "image/gif":
        return [view.getUint16(6, true), view.getUint16(8, true)];
      case "image/webp":
        return webpSize(data, view);
      case "image/jpeg":
        return jpegSize(data, view);
    }
  } catch (e) {
    if (e instanceof RangeError) return null; // truncated
    throw e;
  }
  return null;
}

function uint24le(view: DataView, at: number): number {
  return view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
}

function webpSize(data: Uint8Array, view: DataView): [number, number] | null {
  const chunk = ascii(data, 12, 16);
  if (chunk === "VP8X") return [uint24le(view, 24) + 1, uint24le(view, 27) + 1];
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (chunk === "VP8 ") return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
  return null;
}

function jpegSize(data: Uint8Array, view: DataView): [number, number] | null {
  let i = 2;
  const n = data.length;
  while (i + 4 <= n) {
    if (data[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = data[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers without a length field
      continue;
    }
    const length = view.getUint16(i + 2);
    if (JPEG_SOF.has(marker)) return [view.getUint16(i + 7), view.getUint16(i + 5)];
    i += 2 + length;
  }
  return null;
}
