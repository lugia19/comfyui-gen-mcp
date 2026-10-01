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

  it("round trip, and tampering is rejected", async () => {
    const img = new OutputImage("comfy-gen_00001_.png", "sub", "output");
    const ref = await refs.sign(img, KEY);
    expect(await refs.verify(ref, KEY)).toEqual({ image: img, backend: "main" });
    const pcRef = await refs.sign(img, KEY, "pc");
    expect(pcRef).not.toBe(ref); // the same file name on the PC is a different image
    expect(await refs.verify(pcRef, KEY)).toEqual({ image: img, backend: "pc" });
    await expect(refs.verify(ref, utf8("other key".repeat(4)))).rejects.toBeInstanceOf(refs.RefError);
    const mac = ref.split(".")[1];
    const forged = (await refs.sign(new OutputImage("../../etc/passwd", "", "output"), utf8("attacker".repeat(4)))).split(".")[0];
    await expect(refs.verify(`${forged}.${mac}`, KEY)).rejects.toBeInstanceOf(refs.RefError);
    await expect(refs.verify("garbage", KEY)).rejects.toBeInstanceOf(refs.RefError);
  });

  it("compact ids for the images this app names; others keep the JSON form", async () => {
    const out = (name: string, subfolder = "") => new OutputImage(name, subfolder, "output");
    const up = (name: string) => new OutputImage(name, refs.UPLOAD_SUBFOLDER, "input");
    const nonce = refs.uploadFilename((await refs.checkUpload(await refs.mintUpload(KEY, 0, 60), KEY, 1)), "image/webp");
    for (const [img, prefix] of [
      [out("comfy-gen_00007_.png"), "m7."],
      [out("comfy-gen_99999_.png"), "m99999."],
      [out("comfy-gen_100000_.png"), "m100000."],
      [up("upload-abc.png"), "mupabc."],
      [up("upload-abc.jpg"), "mujabc."],
      [up(nonce), "muw"],
    ] as const) {
      const ref = await refs.sign(img, KEY);
      expect(ref.startsWith(prefix)).toBe(true);
      expect(ref.length).toBeLessThanOrEqual(32);
      expect(await refs.verify(ref, KEY)).toEqual({ image: img, backend: "main" });
      expect(await refs.verify(` ${ref}\n`, KEY)).toEqual({ image: img, backend: "main" }); // pasted with spaces
    }
    // Names that do not rebuild exactly stay JSON (and still round trip).
    for (const img of [
      out("comfy-gen_7_.png"), out("comfy-gen_007_.png"), out("comfy-gen_000007_.png"), out("comfy-gen_00007_.png", "sub"),
      out("other_00007_.png"), out("comfy-gen_00007_.jpg"), new OutputImage("upload-abc.png", "", "input"),
      up("upload-abc.bmp"), up("upload-ünï.png"), up("upload-a.b.png"),
    ]) {
      const ref = await refs.sign(img, KEY, "pc");
      expect(ref.startsWith("Wy")).toBe(true);
      expect(await refs.verify(ref, KEY)).toEqual({ image: img, backend: "pc" });
    }
  });

  it("compact ids: any change is rejected", async () => {
    const ref = await refs.sign(new OutputImage("comfy-gen_00007_.png", "", "output"), KEY); // m7.<12>
    const [payload, mac] = ref.split(".");
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    const bad = [
      `m8.${mac}`, `p7.${mac}`, `m07.${mac}`, `m7.${flip(mac, 0)}`, `m7.${flip(mac, 11)}`, `m7.${mac.slice(0, 11)}`, `m7.${mac}A`,
      `${payload}.${(await refs.sign(new OutputImage("x.png", "sub", "output"), KEY)).split(".")[1]}`, // a JSON id's MAC length
      `mupabc.${mac}`, `${payload}.`, `.${mac}`, payload,
    ];
    for (const r of bad) await expect(refs.verify(r, KEY), r).rejects.toBeInstanceOf(refs.RefError);
    // A JSON payload with a compact MAC is no id either.
    const json = (await refs.sign(new OutputImage("x.png", "sub", "output"), KEY)).split(".")[0];
    await expect(refs.verify(`${json}.${mac}`, KEY)).rejects.toBeInstanceOf(refs.RefError);
  });

  it("loadValue", () => {
    expect(new OutputImage("a.png", "", "output").loadValue()).toBe("a.png [output]");
    expect(new OutputImage("a.png", "sub", "input").loadValue()).toBe("sub/a.png");
  });

  it("upload tokens expire", async () => {
    const token = await refs.mintUpload(KEY, 1000, 600);
    const nonce = await refs.checkUpload(token, KEY, 1500);
    expect(nonce).toBeTruthy();
    await expect(refs.checkUpload(token, KEY, 1601)).rejects.toThrow(/expired/);
    await expect(refs.checkUpload(token + "x", KEY, 1500)).rejects.toBeInstanceOf(refs.RefError);
    expect(refs.uploadFilename(nonce, "image/jpeg").endsWith(".jpg")).toBe(true);
    expect(refs.uploadFilename("../x", "image/png")).not.toContain("/");
  });
});
