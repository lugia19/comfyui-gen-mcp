import { describe, expect, it } from "vitest";
import { checkUpload, chunkLength, isLoraName, md5, sendChunks, UploadError } from "../src/index.ts";

describe("LoRA upload rules", () => {
  it("names, sizes and chunks", () => {
    expect(isLoraName("style (v2).safetensors")).toBe(true);
    for (const name of ["a.ckpt", "../a.safetensors", "a/b.safetensors", "", 7]) expect(isLoraName(name)).toBe(false);
    expect(checkUpload("a.safetensors", 25, 10)).toEqual({ name: "a.safetensors", chunks: 3 });
    expect(() => checkUpload("a.safetensors", 0, 10)).toThrow(/size/);
    expect(() => checkUpload("a.ckpt", 1, 10)).toThrow(UploadError);
    expect([0, 1, 2].map((i) => chunkLength(25, 10, i))).toEqual([10, 10, 5]);
    expect(() => chunkLength(25, 10, 3)).toThrow(/out of range/);
  });

  it("md5 matches the reference", () => {
    expect(md5(new TextEncoder().encode("The quick brown fox jumps over the lazy dog"))).toBe("9e107d9d372bb6826bd81d3542a419d6");
    expect(md5(new Uint8Array())).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });
});

describe("sending a file", () => {
  // The server: answers each chunk with its MD5 (the first damaged once), a 503 once, then joins.
  function server() {
    const got: Record<number, Uint8Array> = {};
    let damage = 1;
    let busy = 1;
    const seen = { finish: null as any, requests: 0 };
    const request = async (url: string, init: RequestInit) => {
      seen.requests++;
      const m = /\/(\d+|finish)$/.exec(url)!;
      if (m[1] === "finish") {
        seen.finish = JSON.parse(String(init.body));
        return Response.json({ state: "done" });
      }
      if (busy-- > 0) return Response.json({ error: "busy" }, { status: 503 });
      const bytes = init.body as Uint8Array;
      got[+m[1]] = bytes;
      const etag = +m[1] === 0 && damage-- > 0 ? "0".repeat(32) : md5(bytes);
      return Response.json({ index: +m[1], etag });
    };
    return { got, seen, request };
  }
  const file = new Uint8Array(25).map((_, i) => i);
  const read = async (offset: number, length: number) => file.slice(offset, offset + length);

  it("sends every chunk until its MD5 matches, then finishes with the parts", async () => {
    const s = server();
    const progress: number[] = [];
    await sendChunks({ upload_url: "/up/x", chunk_size: 10, chunks: 3 }, { size: 25, read, request: s.request, finish: { group: "anima" }, onProgress: (n) => progress.push(n), sleep: async () => {} });
    expect(Object.keys(s.got).sort()).toEqual(["0", "1", "2"]);
    expect(s.seen.finish.group).toBe("anima");
    expect(s.seen.finish.parts.sort((a: any, b: any) => a.index - b.index)).toEqual([0, 1, 2].map((i) => ({ index: i, etag: md5(file.slice(i * 10, i * 10 + 10)) })));
    expect(progress.at(-1)).toBe(25);
  });

  it("a 4xx is final, with the server's reason", async () => {
    const request = async () => Response.json({ error: "chunk 0 must be 10 bytes" }, { status: 400 });
    await expect(sendChunks({ upload_url: "/up/x", chunk_size: 10, chunks: 3 }, { size: 25, read, request, sleep: async () => {} })).rejects.toThrow("chunk 0 must be 10 bytes");
  });
});
