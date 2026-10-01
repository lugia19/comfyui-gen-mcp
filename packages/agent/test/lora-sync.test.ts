import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoraRegistry } from "@comfy-gen/local";
import { LoraSync } from "../src/lora-sync.ts";

const read = (req: IncomingMessage) =>
  new Promise<Buffer>((r) => {
    const parts: Buffer[] = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => r(Buffer.concat(parts)));
  });

/** The Worker: /agent/sync, its upload (answers each chunk's MD5, as R2 does) and storage links. */
async function fakeWorld(plan: (loras: Record<string, number>, base: string) => any) {
  const volume: Record<string, Buffer> = { "remote.safetensors": Buffer.from("r".repeat(50)) };
  const chunks: Record<number, Buffer> = {};
  const seen = { syncs: [] as any[], auth: [] as string[], finishes: 0, cut: 0, ranges: [] as string[], uploadAuth: new Set<string>(), damage: 1 };
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
    let m = /^\/agent\/loras\/uploads\/up\/(\d+)$/.exec(url);
    if (m && req.method === "PUT") {
      seen.uploadAuth.add(String(req.headers.authorization));
      chunks[+m[1]] = body;
      // The first chunk arrives damaged once: its ETag doesn't match, and the agent sends it again.
      const damaged = +m[1] === 0 && seen.damage-- > 0;
      return reply(200, { index: +m[1], etag: damaged ? "0".repeat(32) : createHash("md5").update(body).digest("hex") });
    }
    if (url === "/agent/loras/uploads/up/finish") {
      seen.finishes++;
      const parts = JSON.parse(body.toString()).parts as { index: number; etag: string }[];
      volume["local.safetensors"] = Buffer.concat(parts.sort((a, b) => a.index - b.index).map((p) => chunks[p.index]));
      return reply(200, { state: "done" });
    }
    m = /^\/store\/(\w+)$/.exec(url);
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
  it("pushes what only this PC has, pulls what only R2 has, and asks again after copying", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const dir = join(home, "loras");
    mkdirSync(dir);
    const local = Buffer.from(Array.from({ length: 37 }, (_, i) => i));
    writeFileSync(join(dir, "local.safetensors"), local);
    writeFileSync(join(dir, "theirs.safetensors"), "not ours"); // the user's own: never synced
    const loraRegistry = new LoraRegistry(join(home, "loras.json"), () => dir);
    loraRegistry.add("local.safetensors");
    const machine = { lorasDir: dir, loraRegistry, loraPaths: () => loraRegistry.paths(), loras: () => loraRegistry.sizes() };
    const world = await fakeWorld((loras, base) => ({
      push: "local.safetensors" in loras && !("local.safetensors" in world.volume) ? [{ name: "local.safetensors", size: 37, upload_url: `${base}/agent/loras/uploads/up`, chunk_size: 10, chunks: 4 }] : [],
      pull: "remote.safetensors" in loras ? [] : [{ name: "remote.safetensors", size: 50, url: `${base}/store/abc` }],
      errors: [],
    }));
    close = () => world.srv.close();
    const sync = new LoraSync({ machine, worker: () => ({ url: world.url, secret: "sec" }), sleep: async () => {} });
    await sync.sync();

    expect(world.volume["local.safetensors"]).toEqual(local); // pushed in 4 chunks, the damaged one again
    expect(world.seen.finishes).toBe(1);
    expect([...world.seen.uploadAuth]).toEqual(["Bearer sec"]); // the Worker's upload needs the pairing secret
    expect(readFileSync(join(dir, "remote.safetensors")).toString()).toBe("r".repeat(50)); // pulled, resumed after a cut
    expect(world.seen.ranges).toEqual(["bytes=20-"]);
    expect(world.seen.syncs.length).toBe(2); // a second round found nothing left
    expect(world.seen.syncs[0]).toEqual({ "local.safetensors": 37 }); // only ours
    expect(world.seen.syncs[1]).toEqual({ "local.safetensors": 37, "remote.safetensors": 50 }); // the pull is ours now
    expect(world.seen.auth[0]).toBe("Bearer sec comfy-gen-agent");
    expect(sync.jobs).toEqual({});
  });

  it("takes a same-size file already in the folder as ours, without downloading it", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const dir = join(home, "loras");
    mkdirSync(dir);
    writeFileSync(join(dir, "remote.safetensors"), "r".repeat(50)); // the user's own copy
    const loraRegistry = new LoraRegistry(join(home, "loras.json"), () => dir);
    const world = await fakeWorld((loras, base) => ({ push: [], pull: "remote.safetensors" in loras ? [] : [{ name: "remote.safetensors", size: 50, url: `${base}/store/abc` }] }));
    close = () => world.srv.close();
    const machine = { lorasDir: dir, loraRegistry, loraPaths: () => loraRegistry.paths(), loras: () => loraRegistry.sizes() };
    await new LoraSync({ machine, worker: () => ({ url: world.url, secret: "s" }), sleep: async () => {} }).sync();
    expect(world.seen.cut).toBe(0); // no download
    expect(loraRegistry.sizes()).toEqual({ "remote.safetensors": 50 });
  });

  it("keeps a failed copy's error for the settings page, and never throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loras-"));
    const world = await fakeWorld((_, base) => ({ push: [], pull: [{ name: "../evil.safetensors", size: 5, url: `${base}/store/x` }] }));
    close = () => world.srv.close();
    const sync = new LoraSync({ machine: { lorasDir: dir, loraPaths: () => ({}), loras: () => ({}), loraRegistry: { add() {}, delete() {} } }, worker: () => ({ url: world.url, secret: "s" }), sleep: async () => {} });
    await sync.sync();
    expect(sync.jobs["../evil.safetensors"]).toMatchObject({ to: "pc", error: "not a plain LoRA file name" });
    const unpaired = new LoraSync({ machine: { lorasDir: dir, loraPaths: () => ({}), loras: () => ({}), loraRegistry: { add() {}, delete() {} } }, worker: () => null });
    await unpaired.sync(); // nothing to ask
    const down = new LoraSync({ machine: { lorasDir: dir, loraPaths: () => ({}), loras: () => ({}), loraRegistry: { add() {}, delete() {} } }, worker: () => ({ url: "http://127.0.0.1:1", secret: "s" }) });
    await expect(down.sync()).resolves.toBeUndefined();
  });

  it("deletes what was deleted on the Worker while this PC was offline", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const dir = join(home, "loras");
    mkdirSync(dir);
    writeFileSync(join(dir, "gone.safetensors"), "x");
    const loraRegistry = new LoraRegistry(join(home, "loras.json"), () => dir);
    loraRegistry.add("gone.safetensors");
    const world = await fakeWorld((loras) => ({ push: [], pull: [], delete: "gone.safetensors" in loras ? ["gone.safetensors"] : [] }));
    close = () => world.srv.close();
    const machine = { lorasDir: dir, loraRegistry, loraPaths: () => loraRegistry.paths(), loras: () => loraRegistry.sizes() };
    await new LoraSync({ machine, worker: () => ({ url: world.url, secret: "s" }), sleep: async () => {} }).sync();
    expect(existsSync(join(dir, "gone.safetensors"))).toBe(false);
    expect(loraRegistry.sizes()).toEqual({});
  });
});
