// The agent's end of the relay (design §9): one outbound WebSocket to the Worker, carrying its
// ComfyUI requests and operations. S6: the connection drops every few minutes to hours, abruptly,
// so it reconnects at once, and its backoff resets after any connection that lasted.

import { relay } from "@comfy-gen/core";
import { log } from "@comfy-gen/local";

export const AGENT_USER_AGENT = "comfy-gen-agent"; // Cloudflare refuses some default user agents
const PING_MS = 20_000; // answered by the Durable Object's auto-response, without waking it
const LASTED_MS = 60_000; // a connection this long resets the backoff
const BACKOFF_MS = [0, 1000, 2000, 5000, 10_000, 30_000, 60_000];
const REFUSED_RETRY_MS = 5 * 60_000; // not paired (401): retry rarely; a new link reconnects at once
const CONNECT_TIMEOUT_MS = 30_000;

export type Reply = [status: number, body: Uint8Array | string];
export type Handler = (msg: relay.RelayMessage) => Promise<Reply>;
export type ConnectionState = "unpaired" | "connecting" | "connected" | "refused";

export type RelayClientOptions = {
  workerUrl: string;
  secret: string;
  handle: Handler;
  hello: () => Record<string, unknown>;
  /** For tests: a WebSocket constructor and timers. */
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
};

export class RelayClient {
  state: ConnectionState = "connecting";
  lastError: string | null = null;
  connectedSince: number | null = null;
  private opts: RelayClientOptions;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RelayClientOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close(1000, "agent stopping");
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.state = this.state === "refused" ? "refused" : "connecting";
    const url = this.opts.workerUrl.replace(/^http/, "ws") + "/agent";
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    // Node's WebSocket takes headers (undici); browsers' would not, and this never runs in one.
    const ws = new (WS as any)(url, { headers: { Authorization: `Bearer ${this.opts.secret}`, "User-Agent": AGENT_USER_AGENT } }) as WebSocket;
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let opened = 0;
    let down = false;
    const asm = new relay.Assembler();
    const connectTimer = setTimeout(() => {
      if (!opened) {
        try {
          ws.close();
        } catch {
          // never opened
        }
        onDown(1006);
      }
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();

    // Down once per socket: Node's WebSocket reports a failed handshake with "error" alone (no
    // "close", readyState stuck at CONNECTING; seen against a 200 answer), a dropped one with both.
    const onDown = (code: number) => {
      if (down || this.ws !== ws) return;
      down = true;
      clearTimeout(connectTimer);
      this.ws = null;
      if (this.ping) clearInterval(this.ping);
      this.connectedSince = null;
      if (this.stopped) return;
      const lasted = opened && Date.now() - opened >= LASTED_MS;
      if (lasted) this.attempt = 0;
      if (code === 4000 || code === 4001) {
        // replaced by another agent, or unpaired on the Worker: don't fight over the connection
        this.state = "refused";
        this.lastError = code === 4001 ? "Unpaired on the Worker. Paste a new pairing link." : "Another agent connected to this Worker.";
        log.warn(this.lastError);
        this.retry(REFUSED_RETRY_MS);
        return;
      }
      if (opened) log.warn(`Connection to the Worker dropped (${code}); reconnecting`);
      if (!opened) return void this.checkRefused();
      this.retry(BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]);
    };

    ws.addEventListener("open", () => {
      clearTimeout(connectTimer);
      opened = Date.now();
      this.state = "connected";
      this.connectedSince = opened;
      this.lastError = null;
      log.info(`Connected to ${this.opts.workerUrl}`);
      this.send(relay.encodeMessage({ kind: "hello", info: this.opts.hello() }));
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => ws.readyState === 1 && ws.send("ping"), PING_MS);
      this.ping.unref?.();
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      if (ev.data === "pong") return;
      let msg: relay.RelayMessage | null;
      try {
        msg = asm.push(ev.data as string | ArrayBuffer);
      } catch (e) {
        log.warn("relay:", (e as Error).message);
        return;
      }
      if (msg && (msg.header.kind === "http" || msg.header.kind === "control")) void this.answer(msg);
    });
    ws.addEventListener("close", (ev: CloseEvent) => onDown(ev.code));
    ws.addEventListener("error", () => {
      if (!opened) onDown(1006); // a failed handshake: no close event follows
    });
  }

  /** The connection failed before opening: ask the Worker whether this PC is still paired. */
  private async checkRefused(): Promise<void> {
    let status = 0;
    try {
      const resp = await (this.opts.fetchImpl ?? fetch)(`${this.opts.workerUrl}/agent`, {
        headers: { Authorization: `Bearer ${this.opts.secret}`, "User-Agent": AGENT_USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      status = resp.status;
    } catch (e) {
      this.lastError = `Cannot reach ${this.opts.workerUrl}: ${(e as Error).message}`;
    }
    if (status === 401) {
      this.state = "refused";
      this.lastError = "This PC is not paired with the Worker any more. Paste a new pairing link.";
      this.retry(REFUSED_RETRY_MS);
      return;
    }
    if (status && status !== 426) this.lastError = `The Worker answered HTTP ${status}.`;
    this.state = "connecting";
    this.retry(BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)] || 1000);
  }

  private retry(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), ms);
    this.timer.unref?.();
  }

  /** Tell the Worker what changed (the pause), with a fresh hello: it keeps the latest. */
  refreshHello(): void {
    if (this.state === "connected") this.send(relay.encodeMessage({ kind: "hello", info: this.opts.hello() }));
  }

  private send(frames: (string | Uint8Array)[]): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    for (const f of frames) ws.send(f as string | ArrayBufferView<ArrayBuffer>);
  }

  private async answer(msg: relay.RelayMessage): Promise<void> {
    const id = (msg.header as { id: string }).id;
    let reply: Reply;
    try {
      reply = await this.opts.handle(msg);
    } catch (e) {
      reply = [500, `The agent failed: ${(e as Error).message}`];
    }
    this.send(relay.encodeMessage({ kind: "reply", id, status: reply[0] }, reply[1]));
  }
}

