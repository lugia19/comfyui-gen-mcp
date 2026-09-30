import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfyUIError, fromUtf8, relay, utf8 } from "@comfy-gen/core";
import { createHash } from "node:crypto";
import { LoraRegistry, LoraUploads, paths, type Machine } from "@comfy-gen/local";
import { loadAgentConfig, parsePairingLink, saveAgentConfig } from "../src/config.ts";
import { agentHandler, viewFromDisk } from "../src/handlers.ts";
import { RelayClient } from "../src/relay-client.ts";

describe("pairing link", () => {
  const secret = "s".repeat(43);
  it("reads the Worker and the secret", () => {
    expect(parsePairingLink(` https://comfy-gen.me.workers.dev/agent#${secret} `)).toEqual(["https://comfy-gen.me.workers.dev", secret]);
    expect(parsePairingLink(`http://127.0.0.1:8787/agent#${secret}`)).toEqual(["http://127.0.0.1:8787", secret]); // wrangler dev
  });
  it("refuses anything else, with what to do", () => {
    expect(() => parsePairingLink("hello")).toThrow(/Copy the pairing link/);
    expect(() => parsePairingLink(`http://evil.example/agent#${secret}`)).toThrow(/https/);
    expect(() => parsePairingLink("https://comfy-gen.me.workers.dev/mcp/abc")).toThrow(/not a pairing link/);
    expect(() => parsePairingLink("https://comfy-gen.me.workers.dev/agent#short")).toThrow(/not a pairing link/);
  });
  it("keeps the config in agent.json, with defaults", () => {
    const p = paths({ COMFY_GEN_HOME: mkdtempSync(join(tmpdir(), "agent-")) });
    expect(loadAgentConfig(p)).toMatchObject({ worker_url: "", port: 9248, keep_warm_minutes: 5 });
    saveAgentConfig(p, { ...loadAgentConfig(p), worker_url: "https://w", secret });
    expect(loadAgentConfig(p)).toMatchObject({ worker_url: "https://w", secret });
  });
});

/** A WebSocket stand-in: the test plays the Worker's side. */
class FakeWS extends EventTarget {
  static last: FakeWS;
  static all: FakeWS[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: (string | Uint8Array)[] = [];
  url: string;
  opts: any;
  constructor(url: string, opts: any) {
    super();
    this.url = url;
    this.opts = opts;
    FakeWS.last = this;
    FakeWS.all.push(this);
  }
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close() {}
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  deliver(frames: (string | Uint8Array)[]) {
    for (const f of frames) this.dispatchEvent(Object.assign(new Event("message"), { data: typeof f === "string" ? f : f.slice().buffer }));
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("RelayClient", () => {
  afterEach(() => vi.useRealTimers());

  it("says hello with its secret and User-Agent, and answers requests", async () => {
    const client = new RelayClient({
      workerUrl: "https://w.example",
      secret: "sec",
      handle: async (m) => [200, `echo ${(m.header as any).path ?? (m.header as any).op}`],
      hello: () => ({ gpu: "nvidia" }),
      onOpen: () => opened++,
      WebSocketImpl: FakeWS as any,
    });
    let opened = 0;
    client.start();
    const ws = FakeWS.last;
    expect(ws.url).toBe("wss://w.example/agent");
    expect(ws.opts.headers).toMatchObject({ Authorization: "Bearer sec", "User-Agent": "comfy-gen-agent" });
    ws.open();
    expect(client.state).toBe("connected");
    expect(opened).toBe(1); // the LoRA sync catches up on each connection
    expect(JSON.parse(ws.sent[0] as string)).toMatchObject({ kind: "hello", info: { gpu: "nvidia" } });
    ws.deliver(relay.encodeMessage({ kind: "http", id: "r1", method: "GET", path: "/history/p1" }));
    await tick();
    const asm = new relay.Assembler();
    const reply = ws.sent.slice(1).map((f) => asm.push(f)).find(Boolean)!;
    expect(reply.header).toEqual({ kind: "reply", id: "r1", status: 200 });
    expect(fromUtf8(reply.body)).toBe("echo /history/p1");
    client.stop();
  });

  it("reconnects at once after a drop, and backs off while failing", async () => {
    vi.useFakeTimers();
    const client = new RelayClient({
      workerUrl: "https://w.example", secret: "s", handle: async () => [200, ""], hello: () => ({}),
      WebSocketImpl: FakeWS as any, fetchImpl: (async () => new Response(null, { status: 426 })) as any,
    });
    client.start();
    FakeWS.last.open();
    const before = FakeWS.all.length;
    FakeWS.last.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.all.length).toBe(before + 1); // at once
    FakeWS.last.drop(); // fails before opening: probe says paired (426), retry after a backoff
    await vi.advanceTimersByTimeAsync(10);
    expect(client.state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWS.all.length).toBe(before + 2);
    client.stop();
  });

  it("retries a handshake that fails with an error event alone (Node's WebSocket on a non-101)", async () => {
    vi.useFakeTimers();
    const client = new RelayClient({
      workerUrl: "https://w.example", secret: "s", handle: async () => [200, ""], hello: () => ({}),
      WebSocketImpl: FakeWS as any, fetchImpl: (async () => new Response("<html>", { status: 200 })) as any,
    });
    client.start();
    const n = FakeWS.all.length;
    FakeWS.last.dispatchEvent(new Event("error")); // no close event
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWS.all.length).toBeGreaterThan(n);
    expect(client.lastError).toContain("HTTP 200");
    client.stop();
  });

  it("stops insisting when the Worker no longer knows it", async () => {
    vi.useFakeTimers();
    const client = new RelayClient({
      workerUrl: "https://w.example", secret: "old", handle: async () => [200, ""], hello: () => ({}),
      WebSocketImpl: FakeWS as any, fetchImpl: (async () => new Response("no", { status: 401 })) as any,
    });
    client.start();
    FakeWS.last.drop();
    await vi.advanceTimersByTimeAsync(10);
    expect(client.state).toBe("refused");
    expect(client.lastError).toContain("not paired");
    const n = FakeWS.all.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.all.length).toBe(n); // no hammering
    client.stop();
  });
});

describe("agent handlers", () => {
  it("relays http to the local ComfyUI and runs machine operations", async () => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => res.writeHead(200, { "Content-Type": "text/plain" }).end(`${req.method} ${req.url} ${body}`));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(srv.address() as any).port}`;
    const ensured: any[] = [];
    const home = mkdtempSync(join(tmpdir(), "agent-up-"));
    const registry = new LoraRegistry(join(home, "loras.json"), () => join(home, "loras"));
    const uploads = new LoraUploads(registry, () => join(home, "loras"));
    const machine = {
      comfy: {
        url, state: "running", job: (fn: () => Promise<unknown>) => fn(), ensureRunning: async () => url,
        nodeClasses: async () => new Set(["KSampler"]),
      },
      ensurePack: async (pack: any) => {
        ensured.push(pack);
        if (pack.name === "big") throw new ComfyUIError("The Big model is downloading: 5% of 9.0 GB.");
      },
      loras: () => ({ "a.safetensors": 3 }),
      uploads,
      loraRegistry: registry,
      downloads: { status: () => ({ state: "done", done: 0, total: 0 }) },
    } as unknown as Machine;
    let keepWarm = 0;
    let syncs = 0;
    const sync = { sync: async () => void syncs++, jobs: { "b.safetensors": { to: "pc" as const, done: 1, total: 2 } } };
    const handle = agentHandler({ machine, setKeepWarm: (m) => (keepWarm = m), settingsNote: "x", sync });
    const call = async (header: any, body: Uint8Array = new Uint8Array()) => {
      const [status, out] = await handle({ header, body });
      return [status, typeof out === "string" ? out : fromUtf8(out)];
    };
    expect(await call({ kind: "http", id: "1", method: "POST", path: "/prompt", params: { a: "1" } }, utf8("{}"))).toEqual([200, "POST /prompt?a=1 {}"]);
    expect(await call({ kind: "control", id: "2", op: "ensure", args: { pack: { name: "p" }, keep_warm_minutes: 12 } })).toEqual([200, '{"ready":true}']);
    expect(keepWarm).toBe(12);
    expect(await call({ kind: "control", id: "3", op: "ensure", args: { pack: { name: "big" } } })).toEqual([500, "The Big model is downloading: 5% of 9.0 GB."]);
    expect((await call({ kind: "control", id: "4", op: "inventory" }))[0]).toBe(400); // custom workflows were removed
    expect(JSON.parse((await call({ kind: "control", id: "5", op: "loras" }))[1] as string)).toEqual({
      files: { "a.safetensors": 3 }, syncing: sync.jobs,
    });
    expect(await call({ kind: "control", id: "7", op: "sync" })).toEqual([200, '{"started":true}']);
    expect(syncs).toBe(1);
    // A LoRA upload relayed from the Worker's page: the chunk is the message body.
    const [, started] = await call({ kind: "control", id: "8", op: "upload_start", args: { filename: "u.safetensors", size: 3 } });
    const id = JSON.parse(started as string).id;
    const sha = createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex");
    expect(await call({ kind: "control", id: "9", op: "upload_chunk", args: { id, index: 0, sha256: sha } }, new Uint8Array([1, 2, 3]))).toEqual([200, '{"ok":true,"index":0}']);
    expect(await call({ kind: "control", id: "10", op: "upload_chunk", args: { id, index: 0, sha256: "0" } }, new Uint8Array([1, 2, 3]))).toEqual([400, "chunk 0 checksum mismatch"]);
    expect(await call({ kind: "control", id: "11", op: "upload_finish", args: { id } })).toEqual([200, '{"state":"done"}']);
    expect(registry.sizes()).toEqual({ "u.safetensors": 3 });
    expect(await call({ kind: "control", id: "12", op: "lora_delete", args: { name: "u.safetensors" } })).toEqual([200, '{"deleted":"u.safetensors"}']);
    expect((await call({ kind: "control", id: "13", op: "lora_delete", args: { name: "u.safetensors" } }))[0]).toBe(404);
    expect((await call({ kind: "control", id: "6", op: "nope" }))[0]).toBe(400);
    srv.close();
  });
});

describe("images while ComfyUI is stopped", () => {
  it("serves /view from ComfyUI's folders, and nothing outside them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comfy-"));
    mkdirSync(join(dir, "output", "sub"), { recursive: true });
    writeFileSync(join(dir, "output", "comfy-gen_00007_.png"), "png!");
    writeFileSync(join(dir, "output", "sub", "b.png"), "sub!");
    writeFileSync(join(dir, "secret.txt"), "no");
    const get = async (params: Record<string, string>) => {
      const data = await viewFromDisk(dir, params);
      return data && fromUtf8(data);
    };
    expect(await get({ filename: "comfy-gen_00007_.png", type: "output", subfolder: "" })).toBe("png!");
    expect(await get({ filename: "comfy-gen_00007_.png", preview: "webp;1" })).toBe("png!"); // the original
    expect(await get({ filename: "b.png", subfolder: "sub" })).toBe("sub!");
    expect(await get({ filename: "../secret.txt" })).toBeNull();
    expect(await get({ filename: "secret.txt", subfolder: ".." })).toBeNull();
    expect(await get({ filename: "x.png", type: "models" })).toBeNull();
    expect(await viewFromDisk(undefined, { filename: "comfy-gen_00007_.png" })).toBeNull();

    // Through the handler: ComfyUI stopped, the image still comes back, and nothing starts it.
    let jobs = 0;
    const machine = {
      comfy: { url: null, state: "stopped", install: { dir }, job: (fn: () => Promise<unknown>) => (jobs++, fn()) },
    } as unknown as Machine;
    const handle = agentHandler({ machine, setKeepWarm: () => {}, settingsNote: "x" });
    const [status, body] = await handle({ header: { kind: "http", id: "1", method: "GET", path: "/view", params: { filename: "comfy-gen_00007_.png", type: "output" } }, body: new Uint8Array() });
    expect([status, fromUtf8(body as Uint8Array), jobs]).toEqual([200, "png!", 0]);
    const [missing] = await handle({ header: { kind: "http", id: "2", method: "GET", path: "/view", params: { filename: "nope.png" } }, body: new Uint8Array() });
    expect(missing).toBe(503);
  });
});
