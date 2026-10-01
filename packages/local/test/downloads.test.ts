import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelLocator } from "../src/discover.ts";
import { ModelDownloads, noRoom, type ModelFile } from "../src/downloads.ts";
import { mergeFolders, SHARED_SUBFOLDERS } from "../src/models.ts";
import { fetchFile } from "../src/fetchfile.ts";

const dir = () => mkdtempSync(join(tmpdir(), "dl-"));
/** Our folder plus shared ones, in standard layout. */
const locator = (own: string, ...shared: string[]) =>
  ({
    ownModels: own,
    folders: () => mergeFolders([own, ...shared].map((d) => Object.fromEntries(SHARED_SUBFOLDERS.map((s) => [s, [join(d, s)]])))),
  }) as unknown as ModelLocator;
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

describe("a full disk", () => {
  it("fails the download with the reason, instead of hanging (Linux: /dev/full answers every write with ENOSPC)", async () => {
    if (!existsSync("/dev/full")) return;
    const srv = await serve({ "/m": Buffer.alloc(8 << 20, 7) });
    const dest = join(dir(), "m.safetensors");
    symlinkSync("/dev/full", `${dest}.part`);
    await expect(fetchFile(`${srv.url}/m`, dest, { resume: true })).rejects.toThrow(/the disk is full/);
    srv.close();
  }, 20_000);

  it("is checked before a download starts, keeping 1 GB free", () => {
    expect(noRoom("/x", 2e9, 10e9)).toBeNull();
    expect(noRoom("/x", 2e9, 2.5e9)).toMatch(/not enough disk space: it needs 2.0 GB, and 2.5 GB is free where models go \(\/x\)/);
    expect(noRoom("/x", 2e9, null)).toBeNull(); // unknown: try
  });
});

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
    const dl = new ModelDownloads(locator(own, shared));
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
    const dl = new ModelDownloads(locator(dir()));
    dl.start("p", files);
    for (let i = 0; i < 100 && dl.status("p", files).state !== "failed"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(dl.status("p", files)).toMatchObject({ state: "failed", error: expect.stringContaining("404") });
    srv.close();
  });
});
