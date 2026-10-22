import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfyUIError, fromUtf8, relay, utf8 } from "@comfy-gen/core";
import { createHash } from "node:crypto";
import { agentInstance, LoraRegistry, LoraUploads, paths, type Machine } from "@comfy-gen/local";
import { loadAgentConfig, parsePairingLink, saveAgentConfig } from "../src/config.ts";
import { AgentApp } from "../src/app.ts";
import { agentHandler, viewFromDisk } from "../src/handlers.ts";
import { RelayClient } from "../src/relay-client.ts";
import { isNewer, Updater } from "../src/update.ts";
import { quietForUpdate } from "../src/main.ts";

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
    expect(loadAgentConfig(p)).toMatchObject({ worker_url: "", port: 9248, keep_warm_minutes: 10 });
    saveAgentConfig(p, { ...loadAgentConfig(p), worker_url: "https://w", secret });
    expect(loadAgentConfig(p)).toMatchObject({ worker_url: "https://w", secret });
  });
  it("gives a second agent on the machine its own config, port and logs (a developer switch)", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-"));
    const first = paths({ COMFY_GEN_HOME: home });
    expect(agentInstance(first, { COMFY_GEN_AGENT_INSTANCE: "1" })).toBe(first); // 2 to 9 only
    expect(agentInstance(first, { COMFY_GEN_AGENT_INSTANCE: "x" })).toBe(first);
    const second = agentInstance(first, { COMFY_GEN_AGENT_INSTANCE: "2" });
    expect(second).toMatchObject({ comfyui: first.comfyui, logs: join(home, "instances", "2", "logs"), instance: { n: 2 } });
    saveAgentConfig(first, { ...loadAgentConfig(first), secret });
    expect(loadAgentConfig(second)).toMatchObject({ secret: "", port: 9249 }); // unpaired, the next port
    saveAgentConfig(second, { ...loadAgentConfig(second), secret: "t".repeat(43) });
    expect(loadAgentConfig(first).secret).toBe(secret);
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

  it("drops a connection the Worker stopped answering, and reconnects (a network outage)", async () => {
    vi.useFakeTimers();
    const client = new RelayClient({
      workerUrl: "https://w.example", secret: "s", handle: async () => [200, ""], hello: () => ({}),
      WebSocketImpl: FakeWS as any, fetchImpl: (async () => new Response(null, { status: 426 })) as any,
    });
    client.start();
    const ws = FakeWS.last;
    ws.open();
    const n = FakeWS.all.length;
    // Answered pings keep it up.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      ws.deliver(["pong"]);
    }
    expect([client.state, FakeWS.all.length]).toEqual(["connected", n]);
    // Then silence: the socket still says open, but nothing comes back.
    await vi.advanceTimersByTimeAsync(81_000); // the check after 60 s of silence, then the reconnect
    expect(FakeWS.all.length).toBe(n + 1); // a new connection
    expect(FakeWS.last).not.toBe(ws);
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
    expect(client.lastError).toContain("removed from the Worker");
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
      deleteLora: async (name: string) => ({ deleted: name, pending: registry.delete(name) }),
      downloads: { status: () => ({ state: "done", done: 0, total: 0 }) },
      storedModels: (files: string[]) => ({ [files[0]]: 3 }),
      deleteModels: async (files: string[]) => ({ deleted: { [files[0]]: 3 }, busy: [] }),
    } as unknown as Machine;
    let keepWarm = 0;
    let comfyArgs: string[] | null = null;
    let syncs = 0;
    const sync = { sync: async () => void syncs++, jobs: { "b.safetensors": { to: "pc" as const, done: 1, total: 2 } } };
    let paused = false;
    const handle = agentHandler({ machine, setKeepWarm: (m) => (keepWarm = m), setComfyArgs: (a) => (comfyArgs = a), settingsNote: "x", sync, setPaused: (v) => (paused = v), page: async () => [200, "{}"] });
    const call = async (header: any, body: Uint8Array = new Uint8Array()) => {
      const [status, out] = await handle({ header, body });
      return [status, typeof out === "string" ? out : fromUtf8(out)];
    };
    expect(await call({ kind: "http", id: "1", method: "POST", path: "/prompt", params: { a: "1" } }, utf8("{}"))).toEqual([200, "POST /prompt?a=1 {}"]);
    expect(await call({ kind: "control", id: "2", op: "ensure", args: { pack: { name: "p" }, keep_warm_minutes: 12 } })).toEqual([200, '{"ready":true}']);
    expect(keepWarm).toBe(12);
    expect(comfyArgs).toBeNull(); // a Worker from before ComfyUI flags sends none: the PC keeps its own
    await call({ kind: "control", id: "2b", op: "ensure", args: { pack: { name: "p" }, comfy_args: ["--listen", "0.0.0.0"] } });
    expect(comfyArgs).toBeNull(); // refused here too
    await call({ kind: "control", id: "2c", op: "ensure", args: { pack: { name: "p" }, comfy_args: ["--lowvram"] } });
    expect(comfyArgs).toEqual(["--lowvram"]);
    expect(await call({ kind: "control", id: "3", op: "ensure", args: { pack: { name: "big" } } })).toEqual([500, "The Big model is downloading: 5% of 9.0 GB."]);
    expect((await call({ kind: "control", id: "4", op: "inventory" }))[0]).toBe(400); // custom workflows were removed
    expect(JSON.parse((await call({ kind: "control", id: "5", op: "loras" }))[1] as string)).toEqual({
      files: { "a.safetensors": 3 }, syncing: sync.jobs,
    });
    expect(await call({ kind: "control", id: "7", op: "sync" })).toEqual([200, '{"started":true}']);
    expect(syncs).toBe(1);
    // Pause and resume from the Worker's page: the tray's flag.
    expect(await call({ kind: "control", id: "p1", op: "pause", args: { paused: true } })).toEqual([200, '{"paused":true}']);
    expect(paused).toBe(true);
    await call({ kind: "control", id: "p2", op: "pause", args: { paused: false } });
    expect(paused).toBe(false);
    // LoRA uploads come through R2 now: the relay's upload operations are gone.
    expect((await call({ kind: "control", id: "8", op: "upload_start", args: { filename: "u.safetensors", size: 3 } }))[0]).toBe(400);
    mkdirSync(join(home, "loras"), { recursive: true });
    writeFileSync(join(home, "loras", "u.safetensors"), "abc");
    registry.add("u.safetensors");
    expect(await call({ kind: "control", id: "12", op: "lora_delete", args: { name: "u.safetensors" } })).toEqual([200, '{"deleted":"u.safetensors","pending":false}']);
    expect((await call({ kind: "control", id: "13", op: "lora_delete", args: { name: "u.safetensors" } }))[0]).toBe(404);
    expect((await call({ kind: "control", id: "6", op: "nope" }))[0]).toBe(400);
    expect(await call({ kind: "control", id: "14", op: "models_stored", args: { files: ["vae/a.safetensors"] } })).toEqual([200, '{"vae/a.safetensors":3}']);
    expect(await call({ kind: "control", id: "15", op: "models_delete", args: { files: ["vae/a.safetensors"] } })).toEqual([200, '{"deleted":{"vae/a.safetensors":3},"busy":[]}']);
    srv.close();
  });
});

describe("the Worker's page managing this PC", () => {
  it("passes on any call of the page's API but pairing, which stays on the PC", async () => {
    const calls: string[] = [];
    const page = async (method: string, path: string, body?: string): Promise<[number, string]> => (calls.push(`${method} ${path} ${body ?? ""}`.trim()), [200, '{"ok":true}']);
    const handle = agentHandler({ machine: {} as Machine, setKeepWarm: () => {}, settingsNote: "x", page, setPaused: () => {} });
    const machine = (method: string, path: string, body?: string) =>
      handle({ header: { kind: "control", id: "1", op: "machine", args: { method, path, body } }, body: new Uint8Array() });
    expect(await machine("get", "/state")).toEqual([200, '{"ok":true}']);
    expect(await machine("POST", "/setup/install", '{"gpu":"nvidia"}')).toEqual([200, '{"ok":true}']);
    expect((await machine("POST", "/comfyui/restart"))[0]).toBe(200);
    expect((await machine("PUT", "/config", '{"config":{"extra_models_dir":"D:/models"}}'))[0]).toBe(200);
    expect((await machine("POST", "/open", '{"which":"output"}'))[0]).toBe(200);
    expect((await machine("GET", "/setup/install?x=1"))[0]).toBe(200);
    for (const [method, path] of [["POST", "/pair"], ["DELETE", "/pair"], ["POST", "/pair/"], ["POST", "/pair?x=1"], ["POST", "/state/../pair"]]) {
      expect(await machine(method, path)).toEqual([403, "Pair or unpair on the PC itself."]);
    }
    expect(calls).toEqual([
      "GET /state",
      'POST /setup/install {"gpu":"nvidia"}',
      "POST /comfyui/restart",
      'PUT /config {"config":{"extra_models_dir":"D:/models"}}',
      'POST /open {"which":"output"}',
      "GET /setup/install?x=1",
    ]);
  });
});

describe("the page's settings", () => {
  it("drops a ComfyUI of the user's own (removed in v1.16.0) from agent.json: the managed one takes over", () => {
    const p = paths({ COMFY_GEN_HOME: mkdtempSync(join(tmpdir(), "agent-")) });
    mkdirSync(p.home, { recursive: true });
    const file = join(p.home, "agent.json");
    writeFileSync(file, JSON.stringify({ worker_url: "https://w.example", secret: "s", comfyui_url: "http://127.0.0.1:8188", extra_models_dir: "" }));
    const cfg = loadAgentConfig(p);
    expect("comfyui_url" in cfg).toBe(false);
    expect(cfg.worker_url).toBe("https://w.example");
    expect(readFileSync(file, "utf8")).not.toContain("comfyui_url");
    expect(cfg.comfy_args).toEqual([]);
    writeFileSync(file, JSON.stringify({ comfy_args: ["--reserve-vram", "2"] }));
    expect(loadAgentConfig(p).comfy_args).toEqual(["--reserve-vram", "2"]); // the Worker's, from its last ensure
    writeFileSync(file, JSON.stringify({ comfy_args: ["--listen"] }));
    expect(loadAgentConfig(p).comfy_args).toEqual([]);
  });

  it("saves the models folder, and answers with it only: never the pairing secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "models-"));
    let cfg = { worker_url: "https://w.example", secret: "s".repeat(43), port: 9248, extra_models_dir: "" } as any;
    const machine = { api: async () => null, comfy: { state: "stopped" } } as unknown as Machine;
    const app = new AgentApp({ version: "t", port: 9248, machine, config: () => cfg, saveConfig: (c) => (cfg = c), reconnect: () => {}, relay: () => null, web: {} as any });
    const put = await app.handle(new Request("http://127.0.0.1:9248/api/config", { method: "PUT", headers: { host: "127.0.0.1:9248" }, body: JSON.stringify({ config: { extra_models_dir: dir } }) }), "127.0.0.1");
    const answer = await put.json();
    expect(answer).toEqual({ config: { extra_models_dir: dir }, warnings: [] });
    expect(JSON.stringify(answer)).not.toContain("s".repeat(43));
    expect([cfg.extra_models_dir, cfg.secret]).toEqual([dir, "s".repeat(43)]);
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
      comfy: { url: null, state: "stopped", install: { dir }, dataDir: dir, job: (fn: () => Promise<unknown>) => (jobs++, fn()) },
    } as unknown as Machine;
    const handle = agentHandler({ machine, setKeepWarm: () => {}, settingsNote: "x", setPaused: () => {}, page: async () => [200, "{}"] });
    const [status, body] = await handle({ header: { kind: "http", id: "1", method: "GET", path: "/view", params: { filename: "comfy-gen_00007_.png", type: "output" } }, body: new Uint8Array() });
    expect([status, fromUtf8(body as Uint8Array), jobs]).toEqual([200, "png!", 0]);
    const [missing] = await handle({ header: { kind: "http", id: "2", method: "GET", path: "/view", params: { filename: "nope.png" } }, body: new Uint8Array() });
    expect(missing).toBe(503);
  });
});

describe("the Update to vX button", () => {
  const host = (latest: string | null, downloads: string | null) => {
    const calls: string[] = [];
    return { calls, latest: async () => (calls.push("latest"), latest), update: async () => (calls.push("update"), downloads) };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("asks the shim to download now, then restarts into what it got", async () => {
    const h = host("v1.22.0", "v1.22.0");
    const restarted: string[] = [];
    const u = new Updater({ version: "v1.21.1", host: h, restart: (t) => restarted.push(t) });
    expect(await u.status()).toMatchObject({ current: "v1.21.1", latest: "v1.22.0", newer: true, can: true, state: "idle" });
    expect(u.start()).toBeNull();
    await settle();
    expect([h.calls, restarted, u.state]).toEqual([["latest", "update"], ["v1.22.0"], "restarting"]);
  });

  it("restarts into a bundle the shim already has (updateReady) without asking it again", async () => {
    const h = host(null, null);
    const restarted: string[] = [];
    const u = new Updater({ version: "v1.21.1", host: h, restart: (t) => restarted.push(t) });
    u.ready = "v1.22.0";
    expect((await u.status()).latest).toBe("v1.22.0"); // GitHub unreadable: the ready bundle still counts
    u.start();
    await settle();
    expect([h.calls, restarted]).toEqual([["latest"], ["v1.22.0"]]);
  });

  it("says when the latest release isn't downloadable yet, and doesn't restart", async () => {
    const h = host("v1.22.0", "v1.21.1"); // the tag is out, its bundle not yet
    const restarted: string[] = [];
    const u = new Updater({ version: "v1.21.1", host: h, restart: (t) => restarted.push(t) });
    await u.status();
    u.start();
    await settle();
    expect(u.state).toBe("failed");
    expect(u.error).toContain("v1.22.0 isn't downloadable yet");
    expect(restarted).toEqual([]);
  });

  it("looks the latest release up once per ten minutes; a dev build is never offered one", async () => {
    let t = 0;
    const h = host("v1.22.0", null);
    const u = new Updater({ version: "v1.21.1", host: h, restart: () => {}, now: () => t });
    await u.status();
    await u.status();
    t += 10 * 60_000;
    await u.status();
    expect(h.calls).toEqual(["latest", "latest"]);
    expect((await new Updater({ version: "dev", host: h, restart: () => {} }).status()).newer).toBe(false);
    expect([isNewer("v1.10.0", "v1.9.9"), isNewer("v1.9.9", "v1.10.0"), isNewer(null, "v1.0.0")]).toEqual([true, false, false]);
  });

  it("without the shim's host (an older launcher): no button, and a POST says why", async () => {
    const u = new Updater({ version: "v1.21.1", host: null, restart: () => {} });
    expect(await u.status()).toMatchObject({ can: false, newer: false });
    const machine = { api: async () => null, comfy: { state: "stopped" } } as unknown as Machine;
    const cfg = { worker_url: "", secret: "", port: 9248, extra_models_dir: "" } as any;
    const app = new AgentApp({ version: "v1.21.1", port: 9248, machine, config: () => cfg, saveConfig: () => {}, reconnect: () => {}, relay: () => null, updater: u, web: {} as any });
    const call = (method: string) => app.handle(new Request("http://127.0.0.1:9248/api/update", { method, headers: { host: "127.0.0.1:9248" } }), "127.0.0.1");
    expect(await (await call("GET")).json()).toMatchObject({ current: "v1.21.1", can: false });
    const post = await call("POST");
    expect(post.status).toBe(409);
    expect(await post.text()).toContain("restart the agent");
  });

  it("the page's POST answers at once; the restart waits for a generation to end", async () => {
    let release = (_: string) => {};
    const h = { latest: async () => "v1.22.0", update: () => new Promise<string>((r) => (release = r)) }; // downloading until released
    const u = new Updater({ version: "v1.21.1", host: h, restart: () => {} });
    const machine = { api: async () => null, comfy: { state: "stopped" } } as unknown as Machine;
    const cfg = { worker_url: "", secret: "", port: 9248, extra_models_dir: "" } as any;
    const app = new AgentApp({ version: "v1.21.1", port: 9248, machine, config: () => cfg, saveConfig: () => {}, reconnect: () => {}, relay: () => null, updater: u, web: {} as any });
    const post = await app.handle(new Request("http://127.0.0.1:9248/api/update", { method: "POST", headers: { host: "127.0.0.1:9248" } }), "127.0.0.1");
    expect(post.status).toBe(200);
    expect((await post.json()).state).toBe("downloading");
    release("v1.22.0");
    await settle();
    expect(u.state).toBe("restarting");

    const m = (install: string, comfy: string, quiet: number) => ({ install: { state: install }, comfy: { state: comfy, quietFor: () => quiet } }) as any;
    expect(quietForUpdate(m("idle", "running", 0))).toBe(false); // a generation runs
    expect(quietForUpdate(m("idle", "running", 5_000))).toBe(false); // its image may not be fetched yet
    expect(quietForUpdate(m("running", "stopped", 60_000))).toBe(false); // ComfyUI being installed
    expect(quietForUpdate(m("idle", "starting", 60_000))).toBe(false);
    expect(quietForUpdate(m("done", "running", 15_000))).toBe(true);
  });
});
