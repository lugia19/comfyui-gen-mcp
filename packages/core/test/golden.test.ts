// Vectors that pin what users already hold and must keep working across versions: upload tokens
// and storage links in flight, and (checked in the Worker's tests) session cookies. Plus the resolution
// and edit-scaling maths, whose exact numbers the packs were tuned against. Generated from v0 (the
// Python implementation); change them only with a migration.

import { describe, expect, it } from "vitest";
import golden from "./golden.json" with { type: "json" };
import { fromHex } from "../src/bytes.ts";
import * as refs from "../src/refs.ts";
import { builtinPacks, prepare } from "../src/packs.ts";
import { normalize } from "../src/config.ts";
import { calcDimensions } from "../src/workflow.ts";
import { editWorkflow } from "../src/brain.ts";

const g: any = golden;
const KEY = fromHex(g.key_hex);
const PACKS = builtinPacks();

describe("golden: what users hold", () => {
  // Image ids are random R2 keys (8 base62 characters), nothing signed: no vectors to pin.
  it("upload tokens, storage links and file names", async () => {
    for (const t of g.upload_tokens) expect(await refs.checkUpload(t.token, KEY, t.now + 1)).toBe(t.nonce);
    for (const t of g.store_tokens) {
      expect(await refs.checkStore(t.token, KEY, t.now)).toBe(t.object);
      expect(await refs.mintStore(KEY, t.object, t.now, t.ttl)).toBe(t.token);
    }
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
