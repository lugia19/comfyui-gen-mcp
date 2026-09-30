// The PC path's relay, Worker side (design §9). The Relay Durable Object (index.ts) holds the
// agent's WebSocket; RelayCore is its logic, plain TypeScript so tests drive it with fake sockets.
// RelayTransport is core's Transport over the Durable Object, so the ComfyUI client, held waits
// and the brain work over the relay unchanged.

import { relay, Response as CoreResponse, tokenHex, utf8, type RequestOptions, type Transport } from "@comfy-gen/core";

export type RelayRequest = { method: string; path: string; params?: Record<string, string>; headers?: Record<string, string>; body?: Uint8Array };
/** offline: no agent connected (after waiting WAIT_FOR_AGENT_MS for one). */
export type RelayReply = { status: number; body: Uint8Array; offline?: boolean };
export type RelayStatus = { connected: boolean; since: number | null; info: Record<string, unknown> | null };

/** What the Worker calls on the Relay Durable Object (its RPC methods). */
export interface RelayStub {
  request(req: RelayRequest): Promise<RelayReply>;
  control(op: string, args?: unknown, timeoutS?: number, body?: Uint8Array): Promise<RelayReply>;
  status(): Promise<RelayStatus>;
  drop(): Promise<void>;
}

export interface Socket {
  send(data: string | Uint8Array): void;
}

// S6: the agent's connection drops every few minutes to few hours and comes back at once; a call
// that lands in the gap waits for it rather than failing.
export const WAIT_FOR_AGENT_MS = 10_000;
export const HTTP_TIMEOUT_S = 120; // a held wait is 50 s
export const CONTROL_TIMEOUT_S = 30;

type Pending = { socket: Socket; resolve: (r: RelayReply) => void; timer: ReturnType<typeof setTimeout> };

export class RelayCore {
  private socket: () => Socket | null;
  private sleep: (ms: number) => Promise<void>;
  private waitMs: number;
  private pending = new Map<string, Pending>();
  private assembler = new relay.Assembler();

  constructor(socket: () => Socket | null, opts: { sleep?: (ms: number) => Promise<void>; waitMs?: number } = {}) {
    this.socket = socket;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.waitMs = opts.waitMs ?? WAIT_FOR_AGENT_MS;
  }

  /** A new connection: whatever was half-received on the old one is gone. */
  connected(): void {
    this.assembler = new relay.Assembler();
  }

  /** One frame from the agent. Returns a hello's info (the caller keeps it), else null. */
  onFrame(frame: string | ArrayBuffer | Uint8Array): Record<string, unknown> | null {
    let msg: relay.RelayMessage | null;
    try {
      msg = this.assembler.push(frame);
    } catch (e) {
      this.assembler = new relay.Assembler(); // resynchronize on the next header
      console.log(`relay: ${(e as Error).message}`);
      return null;
    }
    if (!msg) return null;
    if (msg.header.kind === "hello") return msg.header.info ?? {};
    if (msg.header.kind === "reply") {
      const p = this.pending.get(msg.header.id);
      if (p) {
        this.pending.delete(msg.header.id);
        clearTimeout(p.timer);
        p.resolve({ status: msg.header.status, body: msg.body });
      }
    }
    return null;
  }

  /** The agent's socket closed: its unanswered requests fail as a dropped connection would. */
  onClose(socket: Socket): void {
    for (const [id, p] of this.pending) {
      if (p.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({ status: 503, body: utf8("The connection to your PC dropped.") });
    }
  }

  private async waitForSocket(): Promise<Socket | null> {
    for (let waited = 0; ; waited += 500) {
      const s = this.socket();
      if (s || waited >= this.waitMs) return s;
      await this.sleep(500);
    }
  }

  async send(header: relay.HttpMessage | relay.ControlMessage, body: Uint8Array | undefined, timeoutS: number): Promise<RelayReply> {
    const socket = await this.waitForSocket();
    if (!socket) return { status: 503, body: utf8("Your PC is not connected."), offline: true };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(header.id);
        resolve({ status: 504, body: utf8(`Your PC did not answer within ${timeoutS} s.`) });
      }, timeoutS * 1000);
      this.pending.set(header.id, { socket, resolve, timer });
      try {
        for (const frame of relay.encodeMessage(header, body)) socket.send(frame);
      } catch (e) {
        this.pending.delete(header.id);
        clearTimeout(timer);
        resolve({ status: 503, body: utf8(`Could not reach your PC: ${(e as Error).message}`) });
      }
    });
  }

  http(req: RelayRequest, timeoutS = HTTP_TIMEOUT_S): Promise<RelayReply> {
    const { body, ...rest } = req;
    return this.send({ kind: "http", id: tokenHex(8), ...rest }, body, timeoutS);
  }

  control(op: string, args?: unknown, timeoutS = CONTROL_TIMEOUT_S, body?: Uint8Array): Promise<RelayReply> {
    return this.send({ kind: "control", id: tokenHex(8), op, args }, body, timeoutS);
  }
}

/** ComfyUI over the relay. A relay failure reads as 503, as a network failure does over fetch. */
export class RelayTransport implements Transport {
  private stub: RelayStub;

  constructor(stub: RelayStub) {
    this.stub = stub;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<CoreResponse> {
    const body = typeof opts.body === "string" ? utf8(opts.body) : opts.body;
    try {
      const r = await this.stub.request({ method, path, params: opts.params, headers: opts.headers, body });
      return new CoreResponse(r.status, r.body);
    } catch (e) {
      return new CoreResponse(503, utf8(String(e)));
    }
  }
}
