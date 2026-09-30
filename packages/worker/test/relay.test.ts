import { describe, expect, it } from "vitest";
import { fromUtf8, relay, utf8 } from "@comfy-gen/core";
import { RelayCore, RelayTransport } from "../src/relay.ts";

/** A socket whose other end is an agent answering http requests with *answer*. */
function agentSocket(core: () => RelayCore, answer: (h: any, body: Uint8Array) => [number, Uint8Array | string] | null) {
  const asm = new relay.Assembler();
  const sent: (string | Uint8Array)[] = [];
  const socket = {
    send(frame: string | Uint8Array) {
      sent.push(frame);
      const msg = asm.push(frame);
      if (!msg) return;
      const reply = answer(msg.header, msg.body);
      if (!reply) return; // silence
      queueMicrotask(() => {
        for (const f of relay.encodeMessage({ kind: "reply", id: (msg.header as any).id, status: reply[0] }, reply[1])) core().onFrame(f);
      });
    },
  };
  return { socket, sent };
}

describe("RelayCore", () => {
  it("relays a request and its reply, bodies of any size", async () => {
    let core!: RelayCore;
    const big = new Uint8Array(relay.CHUNK + 10).fill(7);
    const { socket } = agentSocket(() => core, (h, body) => [200, h.path === "/echo" ? body : big]);
    core = new RelayCore(() => socket);
    const r = await core.http({ method: "POST", path: "/echo", body: utf8("hi") });
    expect([r.status, fromUtf8(r.body)]).toEqual([200, "hi"]);
    const v = await core.http({ method: "GET", path: "/view" });
    expect(v.body.length).toBe(relay.CHUNK + 10);
  });

  it("waits a while for an agent to connect, then says it is offline", async () => {
    let socket: any = null;
    let slept = 0;
    const core = new RelayCore(() => socket, { waitMs: 2000, sleep: async (ms) => void (slept += ms) });
    const r = await core.control("status");
    expect(r).toMatchObject({ status: 503, offline: true });
    expect(slept).toBe(2000);
    // an agent that comes back within the wait is used
    let polls = 0;
    const late = new RelayCore(() => (++polls > 2 ? agentSocket(() => late, () => [200, "{}"]).socket : null), { sleep: async () => {} });
    expect((await late.control("status")).status).toBe(200);
  });

  it("fails the requests of a connection that drops, and times out silence", async () => {
    let core!: RelayCore;
    const { socket } = agentSocket(() => core, () => null);
    core = new RelayCore(() => socket);
    const pending = core.http({ method: "GET", path: "/history/p1" });
    await new Promise((r) => setTimeout(r, 0)); // the request is on its way
    core.onClose(socket);
    expect(await pending).toMatchObject({ status: 503 });
    const silent = await core.http({ method: "GET", path: "/x" }, 0.01);
    expect(silent.status).toBe(504);
  });

  it("returns a hello's info and ignores garbage", () => {
    const core = new RelayCore(() => null);
    expect(core.onFrame(JSON.stringify({ kind: "hello", info: { gpu: "amd" } }))).toEqual({ gpu: "amd" });
    expect(core.onFrame("garbage")).toBeNull();
    expect(core.onFrame(JSON.stringify({ kind: "reply", id: "nobody", status: 200 }))).toBeNull();
  });
});

describe("RelayTransport", () => {
  it("maps a relay failure to 503", async () => {
    const t = new RelayTransport({
      request: async () => {
        throw new Error("object reset");
      },
    } as any);
    expect((await t.request("GET", "/system_stats")).status).toBe(503);
  });
});
