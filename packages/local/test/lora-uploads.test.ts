import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LORA_CHUNK_SIZE, LoraRegistry, LoraUploads, UploadError } from "../src/lora-uploads.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "lora-up-"));
  const dir = join(home, "loras");
  const registry = new LoraRegistry(join(home, "loras.json"), () => dir);
  return { home, dir, registry, uploads: new LoraUploads(registry, () => dir) };
}

describe("LoRA uploads to this machine", () => {
  it("takes chunks in any order, retried ones included, and registers the file", async () => {
    const { dir, registry, uploads } = setup();
    const data = new Uint8Array(LORA_CHUNK_SIZE * 2 + 1000).map((_, i) => i % 251);
    const s = uploads.start("style.safetensors", data.length);
    expect(s.chunks).toBe(3);
    const part = (i: number) => data.subarray(i * LORA_CHUNK_SIZE, (i + 1) * LORA_CHUNK_SIZE);
    for (const i of [2, 0, 1, 0]) await uploads.chunk(s.id, i, part(i), sha(part(i)));
    expect(uploads.status(s.id)).toMatchObject({ state: "uploading", done: data.length });
    expect(registry.sizes()).toEqual({}); // not ours until finished
    expect(uploads.finish(s.id)).toEqual({ state: "done" });
    expect(uploads.finish(s.id)).toEqual({ state: "done" }); // a retried finish
    expect(sha(readFileSync(join(dir, "style.safetensors")))).toBe(sha(data)); // not toEqual: slow on MBs
    expect(registry.sizes()).toEqual({ "style.safetensors": data.length });
    expect(existsSync(join(dir, "style.safetensors.part-upload"))).toBe(false);
  });

  it("refuses bad names, sizes, chunks and early finishes", async () => {
    const { uploads } = setup();
    for (const name of ["a.ckpt", "../a.safetensors", "a/b.safetensors", ""]) expect(() => uploads.start(name, 1)).toThrow(UploadError);
    expect(() => uploads.start("a.safetensors", 0)).toThrow(/size/);
    const s = uploads.start("a.safetensors", 10);
    const ten = new Uint8Array(10);
    await expect(uploads.chunk(s.id, 0, ten, sha(new Uint8Array(1)))).rejects.toThrow(/checksum/);
    await expect(uploads.chunk(s.id, 0, new Uint8Array(9), null)).rejects.toThrow(/expected 10/);
    await expect(uploads.chunk(s.id, 1, ten, sha(ten))).rejects.toThrow(/out of range/);
    let e: UploadError | null = null;
    try {
      uploads.finish(s.id);
    } catch (err) {
      e = err as UploadError;
    }
    expect([e?.status, e?.message]).toEqual([409, "1 chunk(s) still missing"]);
    await expect(uploads.chunk("nope", 0, ten, sha(ten))).rejects.toMatchObject({ status: 404 });
  });

  it("lists and deletes only our LoRAs, never others in the same folder", () => {
    const { dir, registry } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "theirs.safetensors"), "x");
    writeFileSync(join(dir, "ours.safetensors"), "yy");
    registry.add("ours.safetensors");
    registry.add("gone.safetensors"); // registered, then removed by hand: not listed
    expect(registry.sizes()).toEqual({ "ours.safetensors": 2 });
    expect(() => registry.delete("theirs.safetensors")).toThrow(/no LoRA/);
    registry.delete("ours.safetensors");
    expect(existsSync(join(dir, "ours.safetensors"))).toBe(false);
    expect(existsSync(join(dir, "theirs.safetensors"))).toBe(true);
    expect(registry.sizes()).toEqual({});
  });
});

describe("the LoRA registry", () => {
  it("adopts LoRAs in use from other folders, and forgets (never deletes) those on delete", () => {
    const home = mkdtempSync(join(tmpdir(), "lora-reg-"));
    const dir = join(home, "loras");
    const shared = join(home, "shared-loras");
    mkdirSync(dir, { recursive: true });
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(dir, "own.safetensors"), "123");
    writeFileSync(join(shared, "old.safetensors"), "12345");
    writeFileSync(join(shared, "unused.safetensors"), "1");
    const registry = new LoraRegistry(join(home, "loras.json"), () => dir, () => [dir, shared]);
    expect(registry.sizes()).toEqual({});
    // Configured before the registry: ours if the file is somewhere ComfyUI looks.
    expect(registry.adopt(["old.safetensors", "own.safetensors", "missing.safetensors", "../x.safetensors"])).toEqual(["old.safetensors", "own.safetensors"]);
    expect(registry.adopt(["old.safetensors"])).toEqual([]); // once
    expect(registry.sizes()).toEqual({ "old.safetensors": 5, "own.safetensors": 3 }); // unused stays unlisted
    registry.delete("old.safetensors");
    expect(existsSync(join(shared, "old.safetensors"))).toBe(true); // not ours to delete, only to forget
    registry.delete("own.safetensors");
    expect(existsSync(join(dir, "own.safetensors"))).toBe(false);
    expect(registry.sizes()).toEqual({});
  });
});

