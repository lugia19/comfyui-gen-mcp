// comfyPrompt and redrawPackFor on images written the way ComfyUI writes them (Pillow, as its
// SaveAnimatedWEBP and SaveImage do): a WebP with EXIF 0x0110 "prompt:{json}" (and a workflow in
// 0x010F), a PNG with "prompt" and "workflow" text chunks.

import { describe, expect, it } from "vitest";
import { OutputImage } from "../src/comfyui.ts";
import { imageSize } from "../src/images.ts";
import { comfyPrompt, redrawPackFor, withExifOf } from "../src/metadata.ts";
import { MAX_INLINE_BYTES, previewImage } from "../src/results.ts";
import { FakeComfy, fastClient } from "./fake-comfy.ts";
import { builtinPacks } from "../src/packs.ts";
import { withPrompt as bytes } from "./metadata-fixtures.ts";

const PACKS = builtinPacks();
const unet = (p: Record<string, any> | null) => Object.values<any>(p ?? {}).find((n) => n.class_type === "UNETLoader")?.inputs.unet_name;

describe("comfyPrompt", () => {
  it("reads the prompt from a WebP's EXIF and a PNG's text chunk", () => {
    expect(unet(comfyPrompt(bytes("webpAnima")))).toBe("anima-base-v1.0.safetensors");
    expect(unet(comfyPrompt(bytes("pngTurbo")))).toBe("anima-turbo-v1.0.safetensors");
  });

  it("is null without one, and for anything that isn't an image", () => {
    expect(comfyPrompt(bytes("webpPlain"))).toBeNull();
    expect(comfyPrompt(null)).toBeNull();
    expect(comfyPrompt(new TextEncoder().encode("not an image at all"))).toBeNull();
    const cut = bytes("webpAnima").subarray(0, 60); // truncated inside the EXIF chunk
    expect(comfyPrompt(cut)).toBeNull();
  });
});

describe("redrawPackFor", () => {
  it("names the redraw pack whose model drew the image", () => {
    expect(redrawPackFor(bytes("webpAnima"), PACKS)).toBe("anima");
    expect(redrawPackFor(bytes("pngTurbo"), PACKS)).toBe("anima_turbo");
  });

  it("is null for a model no redraw pack uses, or no metadata", () => {
    expect(redrawPackFor(bytes("webpKlein"), PACKS)).toBeNull();
    expect(redrawPackFor(bytes("webpPlain"), PACKS)).toBeNull();
    expect(redrawPackFor(null, PACKS)).toBeNull();
  });
});

describe("withExifOf: a re-encoded WebP keeps the prompt (and its seed) of the file it came from", () => {
  // Decoding needs Pillow or a browser: their output, checked 2026-10-26, was the same pixels (and
  // alpha) as before for each kind below, and Pillow read the EXIF back.
  const prompt = comfyPrompt(bytes("webpAnima"));
  const chunks = (b: Uint8Array) => {
    const out: string[] = [];
    for (let at = 12; at + 8 <= b.length; ) {
      const size = new DataView(b.buffer, b.byteOffset).getUint32(at + 4, true);
      out.push(String.fromCharCode(...b.subarray(at, at + 4)));
      at += 8 + size + (size & 1);
    }
    return out;
  };

  it("on each kind /view writes: lossy, lossy with alpha, lossless", () => {
    for (const [kind, vp8xFlags] of [["webpPlain", 0x08], ["webpAlpha", 0x18], ["webpLossless", 0x18]] as const) {
      const small = bytes(kind);
      const out = withExifOf(small, bytes("webpAnima"));
      expect(comfyPrompt(small), kind).toBeNull();
      expect(comfyPrompt(out), kind).toEqual(prompt);
      expect(imageSize(out), kind).toEqual(imageSize(small));
      expect(chunks(out).at(-1), kind).toBe("EXIF");
      expect(chunks(out)[0], kind).toBe("VP8X");
      expect(out[20], kind).toBe(vp8xFlags); // EXIF, and alpha where the image has it
      expect(new DataView(out.buffer).getUint32(4, true), kind).toBe(out.length - 8);
    }
  });

  it("once, however often; and leaves alone what it can't help", () => {
    const once = withExifOf(bytes("webpAlpha"), bytes("webpAnima"));
    expect(chunks(withExifOf(once, bytes("webpAnima"))).filter((c) => c === "EXIF")).toHaveLength(1);
    const small = bytes("webpAlpha");
    expect(withExifOf(small, bytes("webpPlain"))).toBe(small); // nothing to carry over
    expect(withExifOf(small, bytes("pngTurbo"))).toBe(small); // not a WebP: its text chunks aren't EXIF
    const png = bytes("pngTurbo");
    expect(withExifOf(png, bytes("webpAnima"))).toBe(png);
  });

  it("previewImage: the smaller copy of a big image comes back with the saved file's metadata", async () => {
    const comfy = new FakeComfy();
    const big = new Uint8Array(MAX_INLINE_BYTES + 1);
    big.set(bytes("webpAnima")); // a saved WebP's chunks, then padding: too big to send inline
    comfy.viewBody = big;
    comfy.previewBody = bytes("webpPlain");
    const out = await previewImage(fastClient(comfy), new OutputImage("a.webp", "", "output"));
    expect(comfy.calls.filter((c) => c[1] === "/view").map((c) => c[2]?.preview)).toEqual([undefined, "webp;75"]);
    expect(out.length).toBeLessThan(1000);
    expect(comfyPrompt(out)).toEqual(prompt);
  });
});
