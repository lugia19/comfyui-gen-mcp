// Vectors that pin what users already hold and must keep working across versions: image ids and
// upload tokens in chats, and (checked in the Worker's tests) session cookies. Plus the resolution
// and edit-scaling maths, whose exact numbers the packs were tuned against. Generated from v0 (the
// Python implementation); change them only with a migration.

import { describe, expect, it } from "vitest";
import golden from "./golden.json" with { type: "json" };
import { fromHex } from "../src/bytes.ts";
import { OutputImage } from "../src/comfyui.ts";
import * as refs from "../src/refs.ts";
import { builtinPacks, prepare } from "../src/packs.ts";
import { normalize } from "../src/config.ts";
import { calcDimensions, splitLossless } from "../src/workflow.ts";
import { editWorkflow } from "../src/brain.ts";

const g: any = golden;
const KEY = fromHex(g.key_hex);
const PACKS = builtinPacks();

describe("golden: what users hold", () => {
  it("image ids: ASCII ones are identical, and every v0 id verifies", async () => {
    for (const { image, ref } of g.refs) {
      const img = new OutputImage(image[2], image[1], image[0]);
      expect(await refs.verify(ref, KEY)).toEqual(img);
      if (/^[\x00-\x7f]*$/.test(image.join(""))) expect(await refs.sign(img, KEY)).toBe(ref);
    }
  });

  it("upload tokens and file names", async () => {
    for (const t of g.upload_tokens) expect(await refs.checkUpload(t.token, KEY, t.now + 1)).toBe(t.nonce);
    for (const f of g.upload_filenames) expect(refs.uploadFilename(f.nonce, f.mime)).toBe(f.name);
  });

  it("pack order", () => {
    expect(PACKS.map((p) => p.name)).toEqual(g.pack_names);
  });
});

describe("golden: sizing maths", () => {
  it("dimensions", () => {
    for (const d of g.dimensions) expect([d.aspect, d.max_pixels, calcDimensions(d.aspect, d.max_pixels)]).toEqual([d.aspect, d.max_pixels, d.wh]);
  });

  it("split_lossless", () => {
    for (const s of g.split_lossless) expect(splitLossless(s.in)).toEqual(s.out);
  });

  it("edit scaling: loaded images and megapixels per scale node", () => {
    for (const e of g.edit_scaling) {
      const pack = prepare(PACKS.find((x) => x.name === e.pack)!, normalize({}));
      const [wf, promptNode] = editWorkflow(pack, e.images);
      expect(promptNode).toBe(e.prompt_node);
      for (const [node, mp] of Object.entries(e.megapixels)) expect(wf[node].inputs.megapixels).toBe(mp);
      for (const [node, value] of Object.entries(e.loads)) expect(wf[node].inputs.image).toBe(value);
    }
  });
});
