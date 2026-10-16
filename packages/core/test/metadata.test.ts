// comfyPrompt and redrawPackFor on images written the way ComfyUI writes them (Pillow, as its
// SaveAnimatedWEBP and SaveImage do): a WebP with EXIF 0x0110 "prompt:{json}" (and a workflow in
// 0x010F), a PNG with "prompt" and "workflow" text chunks.

import { describe, expect, it } from "vitest";
import { comfyPrompt, redrawPackFor } from "../src/metadata.ts";
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
