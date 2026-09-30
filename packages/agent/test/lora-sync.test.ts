import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoraSync } from "../src/lora-sync.ts";

const read = (req: IncomingMessage) =>
  new Promise<Buffer>((r) => {
    const parts: Buffer[] = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => r(Buffer.concat(parts)));
  });

/** The Worker's /agent/sync and the Modal app's upload endpoint, in one server. */
async function fakeWorld(plan: (loras: Record<string, number>, base: string) => any) {
  const volume: Record<string, Buffer> = { "remote.safetensors": Buffer.from("r".repeat(50)) };
  const chunks: Record<number, Buffer> = {};
  const seen = { syncs: [] as any[], auth: [] as string[], finishes: 0, cut: 0, ranges: [] as string[] };
  let state = "uploading";
  const srv = createServer(async (req, res) => {
    const body = await read(req);
    const url = req.url!;
    const reply = (status: number, data: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    if (url === "/agent/sync") {
      seen.auth.push(`${req.headers.authorization} ${req.headers["user-agent"]}`);
      const loras = JSON.parse(body.toString()).loras;
      seen.syncs.push(loras);
      return reply(200, plan(loras, `http://127.0.0.1:${(srv.address() as any).port}`));
    }
    let m = /^\/u\/up\/(\d+)$/.exec(url);
    if (m && req.method === "PUT") {
      if (createHash("sha256").update(body).digest("hex") !== req.headers["x-chunk-sha256"]) return reply(400, { error: "checksum" });
      chunks[+m[1]] = body;
      return reply(200, { ok: true });
    }
    if (url === "/u/up/finish") {
      seen.finishes++;
      state = "done";
      volume["local.safetensors"] = Buffer.concat(Object.keys(chunks).sort((a, b) => +a - +b).map((k) => chunks[+k]));
      return reply(200, { state: "assembling" });
    }
    if (url === "/u/up") return reply(200, { state });
    m = /^\/d\/(\w+)$/.exec(url);
    if (m) {
      const data = volume["remote.safetensors"];
      const range = req.headers.range;
      if (range) seen.ranges.push(range);
      const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      res.writeHead(range ? 206 : 200, { "Content-Length": String(data.length - from) });
      if (!range && seen.cut++ === 0) {
        res.write(data.subarray(0, 20)); // cut off after 20 bytes, like Modal's request limit
        return void setTimeout(() => res.destroy(), 50);
      }
      return res.end(data.subarray(from));
    }
    reply(404, { error: "no" });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { srv, volume, seen, url: `http://127.0.0.1:${(srv.address() as any).port}` };
}

let close: (() => void) | null = null;
afterEach(() => close?.());

describe("LoraSync", () => {
  it("pushes what only this PC has, pulls what only Modal has, and asks again after copying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loras-"));
    const shared = mkdtempSync(join(tmpdir(), "shared-"));
    const local = Buffer.from(Array.from({ length: 37 }, (_, i) => i));
    writeFileSync(join(shared, "local.safetensors"), local);
    const paths = () => {
      const out: Record<string, string> = {};
      for (const d of [dir, shared]) for (const n of ["local.safetensors", "remote.safetensors"]) if (!out[n] && existsSync(join(d, n))) out[n] = join(d, n);
      return out;
    };
    const machine = {
      lorasDir: dir,
      loraPaths: paths,
      loras: () => Object.fromEntries(Object.entries(paths()).map(([n, p]) => [n, readFileSync(p).length])),
    };
    const world = await fakeWorld((loras, base) => ({
      push: "local.safetensors" in loras && !("local.safetensors" in world.volume) ? [{ name: "local.safetensors", size: 37, upload_url: `${base}/u/up`, chunk_size: 10, chunks: 4 }] : [],
      pull: "remote.safetensors" in loras ? [] : [{ name: "remote.safetensors", size: 50, url: `${base}/d/abc` }],
      errors: [],
    }));
    close = () => world.srv.close();
    mkdirSync(dir, { recursive: true });
    const sync = new LoraSync({ machine, worker: () => ({ url: world.url, secret: "sec" }), sleep: async () => {} });
    await sync.sync();

    expect(world.volume["local.safetensors"]).toEqual(local); // pushed in 4 chunks, from a shared folder
    expect(world.seen.finishes).toBe(1);
    expect(readFileSync(join(dir, "remote.safetensors")).toString()).toBe("r".repeat(50)); // pulled, resumed after a cut
    expect(world.seen.ranges).toEqual(["bytes=20-"]);
    expect(world.seen.syncs.length).toBe(2); // a second round found nothing left
    expect(world.seen.syncs[1]).toEqual({ "local.safetensors": 37, "remote.safetensors": 50 });
    expect(world.seen.auth[0]).toBe("Bearer sec comfy-gen-agent");
    expect(sync.jobs).toEqual({});
  });

  it("keeps a failed copy's error for the settings page, and never throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loras-"));
    const world = await fakeWorld((_, base) => ({ push: [], pull: [{ name: "../evil.safetensors", size: 5, url: `${base}/d/x` }] }));
    close = () => world.srv.close();
    const sync = new LoraSync({ machine: { lorasDir: dir, loraPaths: () => ({}), loras: () => ({}) }, worker: () => ({ url: world.url, secret: "s" }), sleep: async () => {} });
    await sync.sync();
    expect(sync.jobs["../evil.safetensors"]).toMatchObject({ to: "pc", error: "not a plain LoRA file name" });
    const unpaired = new LoraSync({ machine: { lorasDir: dir, loraPaths: () => ({}), loras: () => ({}) }, worker: () => null });
    await unpaired.sync(); // nothing to ask
    const down = new LoraSync({ machine: { lorasDir: dir, loraPaths: () => ({}), loras: () => ({}) }, worker: () => ({ url: "http://127.0.0.1:1", secret: "s" }) });
    await expect(down.sync()).resolves.toBeUndefined();
  });
});
