import { describe, expect, it } from "vitest";
import { concat, fromBase64, toBase64, utf8 } from "../src/bytes.ts";
import { OutputImage } from "../src/comfyui.ts";
import { imageSize, sniffMime } from "../src/images.ts";
import * as refs from "../src/refs.ts";
import { png } from "./fake-comfy.ts";

function jpeg(w: number, h: number): Uint8Array {
  const app0 = concat([new Uint8Array([0xff, 0xe0, 0, 16]), utf8("JFIF\x00"), new Uint8Array(9)]);
  const sof = concat([new Uint8Array([0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255]), new Uint8Array(10)]);
  return concat([new Uint8Array([0xff, 0xd8]), app0, sof]);
}

function le(n: number, bytes: number): Uint8Array {
  return new Uint8Array(Array.from({ length: bytes }, (_, i) => (n / 256 ** i) & 255));
}

const webpVp8x = (w: number, h: number) => concat([utf8("RIFF\x00\x00\x00\x00WEBPVP8X"), new Uint8Array(8), le(w - 1, 3), le(h - 1, 3)]);
const webpVp8l = (w: number, h: number) =>
  concat([utf8("RIFF\x00\x00\x00\x00WEBPVP8L"), new Uint8Array(4), new Uint8Array([0x2f]), le((w - 1) + (h - 1) * 2 ** 14, 4)]);

describe("images", () => {
  it("sizes from headers", () => {
    expect(imageSize(png(832, 1216))).toEqual([832, 1216]);
    expect(imageSize(jpeg(1024, 768))).toEqual([1024, 768]);
    expect(imageSize(webpVp8x(1536, 640))).toEqual([1536, 640]);
    expect(imageSize(webpVp8l(300, 200))).toEqual([300, 200]);
    expect(imageSize(concat([utf8("GIF89a"), le(64, 2), le(32, 2)]))).toEqual([64, 32]);
    expect(imageSize(utf8("not an image"))).toBeNull();
    expect(imageSize(png(1, 1).subarray(0, 20))).toBeNull(); // truncated
  });

  it("sniffMime", () => {
    expect(sniffMime(png(1, 1))).toBe("image/png");
    expect(sniffMime(jpeg(1, 1))).toBe("image/jpeg");
    expect(sniffMime(webpVp8x(1, 1))).toBe("image/webp");
    expect(sniffMime(utf8("hello"))).toBeNull();
  });

  it("base64 of a large image doesn't blow the stack", () => {
    const big = new Uint8Array(3_000_000).map((_, i) => (i * 7) & 255);
    const back = fromBase64(toBase64(big));
    expect(back.length).toBe(big.length);
    expect(back.every((b, i) => b === big[i])).toBe(true);
  });
});

describe("refs", () => {
  const KEY = utf8("k".repeat(32));

  it("image ids: 8 random base62 characters, read back from what the model passes", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => refs.newImageId()));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(refs.IMAGE_ID);
    const chars = new Set([...ids].join(""));
    expect(chars.size).toBe(62); // every character is used
    expect(refs.imageIdIn("  h3Kd9QxA\n")).toBe("h3Kd9QxA");
    expect(refs.imageIdIn("image_id: h3Kd9QxA")).toBe("h3Kd9QxA"); // the label copied along
    expect(refs.imageKey("h3Kd9QxA")).toBe("img/h3Kd9QxA");
    for (const bad of ["", "h3Kd9Qx", "h3Kd9QxAB", "h3Kd9Qx-", "../etc/pa", "m7.Ab3d"]) expect(() => refs.imageIdIn(bad), bad).toThrow(refs.RefError);
  });

  it("storage links: the object until expiry; an upload token is no storage link", async () => {
    const token = await refs.mintStore(KEY, "lora/a.safetensors", 1000, 60);
    expect(await refs.checkStore(token, KEY, 1060)).toBe("lora/a.safetensors");
    await expect(refs.checkStore(token, KEY, 1061)).rejects.toThrow(/expired/);
    await expect(refs.checkStore(token, utf8("other key".repeat(4)), 1000)).rejects.toBeInstanceOf(refs.RefError);
    await expect(refs.checkStore(await refs.mintUpload(KEY, 1000, 60), KEY, 1000)).rejects.toThrow(/Invalid storage link/);
    await expect(refs.checkUpload(token, KEY, 1000)).resolves.toBe("s:lora/a.safetensors"); // harmless: not an image id
  });

  it("loadValue", () => {
    expect(new OutputImage("a.png", "", "output").loadValue()).toBe("a.png [output]");
    expect(new OutputImage("a.png", "sub", "input").loadValue()).toBe("sub/a.png");
  });

  it("upload tokens expire", async () => {
    const token = await refs.mintUpload(KEY, 1000, 600);
    const nonce = await refs.checkUpload(token, KEY, 1500);
    expect(nonce).toMatch(refs.IMAGE_ID); // the uploaded image's id
    await expect(refs.checkUpload(token, KEY, 1601)).rejects.toThrow(/expired/);
    await expect(refs.checkUpload(token + "x", KEY, 1500)).rejects.toBeInstanceOf(refs.RefError);
    expect(refs.uploadFilename(nonce, "image/jpeg").endsWith(".jpg")).toBe(true);
    expect(refs.uploadFilename("../x", "image/png")).not.toContain("/");
  });
});
