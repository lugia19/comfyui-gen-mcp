// The TypeScript core against vectors generated from the Python implementation before the port.
// They pin what users already hold (image ids, session cookies) and what the model sees (tool list,
// descriptions, MCP bodies), and the workflow maths.

import { describe, expect, it } from "vitest";
import golden from "./golden.json" with { type: "json" };
import { fromHex } from "../src/bytes.ts";
import { OutputImage } from "../src/comfyui.ts";
import * as refs from "../src/refs.ts";
import { builtinPacks, prepare } from "../src/packs.ts";
import { normalize, SETTINGS_SCHEMA } from "../src/config.ts";
import { buildPrompt, calcDimensions, splitLossless } from "../src/workflow.ts";
import { customPack, editWorkflow, missingNodesMessage } from "../src/brain.ts";
import { toolSpecs } from "../src/tools.ts";
import { McpHandler } from "../src/mcp.ts";

const g: any = golden;
const KEY = fromHex(g.key_hex);
const PACKS = builtinPacks();
const fixedSeed = () => 123456789;

describe("golden: identity carried over from Python", () => {
  it("image ids: ASCII ones are identical, and every Python id verifies", async () => {
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

describe("golden: workflow maths", () => {
  it("dimensions", () => {
    for (const d of g.dimensions) expect([d.aspect, d.max_pixels, calcDimensions(d.aspect, d.max_pixels)]).toEqual([d.aspect, d.max_pixels, d.wh]);
  });

  it("split_lossless", () => {
    for (const s of g.split_lossless) expect(splitLossless(s.in)).toEqual(s.out);
  });

  it("generation workflows, with and without LoRAs and a resolution setting", () => {
    for (const p of g.prompts) {
      const pack = prepare(PACKS.find((x) => x.name === p.pack)!, p.cfg);
      expect(pack.max_pixels ?? null).toEqual(p.prepared_max_pixels);
      expect(pack.lora_toggles ?? null).toEqual(p.lora_toggles);
      const wf = buildPrompt(pack.workflow, "a @style fox", pack.prompt_node_id, pack.seed_nodes, {
        dimensionNodes: pack.dimension_nodes,
        aspectRatio: "portrait",
        maxPixels: pack.max_pixels ?? 1_048_576,
        loraToggles: pack.lora_toggles,
        rng: fixedSeed,
      });
      expect(wf).toEqual(p.workflow);
    }
  });

  it("edit workflows", () => {
    for (const e of g.edits) {
      const pack = prepare(PACKS.find((x) => x.name === e.pack)!, normalize({}));
      const [wf, pn, sn] = editWorkflow(pack, e.images);
      expect(pn).toBe(e.prompt_node);
      expect(buildPrompt(wf, "make it snowy", pn, sn, { rng: fixedSeed })).toEqual(e.workflow);
    }
  });

  it("custom workflow pack and the missing-nodes message", () => {
    const cp = customPack(g.custom_pack.in);
    expect([cp.prompt_node_id, cp.seed_nodes]).toEqual([g.custom_pack.prompt_node_id, g.custom_pack.seed_nodes]);
    expect(missingNodesMessage(["A", "UnetLoaderGGUF"], { UnetLoaderGGUF: "ComfyUI-GGUF" })).toBe(g.missing_nodes);
  });
});

describe("golden: what the model and the pages see", () => {
  it("tool specs in both modes", () => {
    for (const t of g.tool_specs) expect([t.cfg_name, t.mode, toolSpecs(PACKS, t.cfg, t.mode)]).toEqual([t.cfg_name, t.mode, t.specs]);
  });

  it("MCP bodies", async () => {
    const h = new McpHandler("Comfy-Gen-MCP", "v1.2.3", toolSpecs(PACKS, normalize({}), "refs"), async () => [[{ type: "text", text: "x" }], false], "Hi.");
    for (const m of g.mcp) {
      const [status, body] = await h.handle(JSON.stringify(m.request));
      expect([status, body === null ? null : JSON.parse(body)]).toEqual([m.status, m.body]);
    }
  });

  it("config", () => {
    expect(SETTINGS_SCHEMA).toEqual(g.settings_schema);
    for (const n of g.normalize) expect(normalize(n.in)).toEqual(n.out);
  });
});
