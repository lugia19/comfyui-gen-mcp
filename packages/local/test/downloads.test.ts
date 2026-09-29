import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelDownloads, type ModelFile } from "../src/downloads.ts";
import { fetchFile } from "../src/fetchfile.ts";

const dir = () => mkdtempSync(join(tmpdir(), "dl-"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Serves *files* by path, honoring Range; records the Range headers it saw. */
function serve(files: Record<string, Buffer>) {
  const ranges: (string | undefined)[] = [];
  const srv = createServer((req, res) => {
    const body = files[req.url!];
    if (!body) return res.writeHead(404).end();
    ranges.push(req.headers.range);
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (m) {
      const from = Number(m[1]);
      return res.writeHead(206, { "Content-Length": body.length - from }).end(body.subarray(from));
    }
    res.writeHead(200, { "Content-Length": body.length }).end(body);
  });
  return new Promise<{ url: string; ranges: typeof ranges; close: () => void }>((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(srv.address() as any).port}`, ranges, close: () => srv.close() })),
  );
}

describe("resumable fetchFile", () => {
  it("continues a .part file and checks the whole file's hash", async () => {
    const body = Buffer.from("x".repeat(50_000) + "y".repeat(50_000));
    const srv = await serve({ "/m": body });
    const dest = join(dir(), "m.bin");
    writeFileSync(`${dest}.part`, body.subarray(0, 30_000));
    expect(await fetchFile(`${srv.url}/m`, dest, { resume: true, size: body.length, sha256: sha(body) })).toBe(sha(body));
    expect(srv.ranges).toEqual(["bytes=30000-"]);
    expect(readFileSync(dest)).toEqual(body);
    srv.close();
  });

  it("drops a .part file whose bytes turn out wrong", async () => {
    const body = Buffer.from("z".repeat(10_000));
    const srv = await serve({ "/m": body });
    const dest = join(dir(), "m.bin");
    writeFileSync(`${dest}.part`, Buffer.from("q".repeat(4_000)));
    await expect(fetchFile(`${srv.url}/m`, dest, { resume: true, size: body.length, sha256: sha(body) })).rejects.toThrow(/checksum/);
    expect(existsSync(`${dest}.part`)).toBe(false);
    srv.close();
  });
});

describe("ModelDownloads", () => {
  it("downloads what is missing into our folder and reports progress", async () => {
    const a = Buffer.from("a".repeat(1000));
    const b = Buffer.from("b".repeat(2000));
    const srv = await serve({ "/a": a, "/b": b });
    const own = dir();
    const shared = dir();
    mkdirSync(join(shared, "vae"));
    writeFileSync(join(shared, "vae", "shared.safetensors"), "s");
    const files: ModelFile[] = [
      { filename: "a.safetensors", subfolder: "unet", url: `${srv.url}/a`, size_bytes: a.length, sha256: sha(a) },
      { filename: "b.safetensors", subfolder: "clip", url: `${srv.url}/b`, size_bytes: b.length },
      { filename: "shared.safetensors", subfolder: "vae", url: `${srv.url}/nope`, size_bytes: 1 },
    ];
    const dl = new ModelDownloads(() => [own, shared]);
    expect(dl.status("p", files)).toEqual({ state: "missing", done: 0, total: 3000 });
    expect(["queued", "downloading"]).toContain(dl.start("p", files).state);
    expect(dl.start("p", files).state).not.toBe("done"); // not queued twice
    for (let i = 0; i < 100 && dl.status("p", files).state !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(dl.status("p", files).state).toBe("done");
    expect(readFileSync(join(own, "clip", "b.safetensors"))).toEqual(b);
    expect(existsSync(join(own, "vae", "shared.safetensors"))).toBe(false); // found in the shared folder
    srv.close();
  });

  it("reports a failure until the next start", async () => {
    const srv = await serve({});
    const files: ModelFile[] = [{ filename: "x.safetensors", subfolder: "unet", url: `${srv.url}/x`, size_bytes: 10 }];
    const dl = new ModelDownloads(() => [dir()]);
    dl.start("p", files);
    for (let i = 0; i < 100 && dl.status("p", files).state !== "failed"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(dl.status("p", files)).toMatchObject({ state: "failed", error: expect.stringContaining("404") });
    srv.close();
  });
});
