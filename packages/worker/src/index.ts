// Cloudflare Worker entry: adapts the runtime to App (plain TypeScript, tested in Node), and
// declares the Durable Objects. Keep this file thin; logic belongs in app.ts.

import { DurableObject } from "cloudflare:workers";
import { App } from "./app.ts";
import type { Bucket, StateStorage } from "./platform.ts";
import { CONTROL_TIMEOUT_S, liveSocket, RelayCore, type RelayReply, type RelayRequest, type RelayStatus, type RelayStub } from "./relay.ts";

export interface Env {
  STATE: DurableObjectNamespace<State>;
  RELAY: DurableObjectNamespace<Relay>;
  STORE?: R2Bucket; // bound once R2 is turned on in the account (deploy.py checks at each build)
  VERSION?: string;
  SETUP_MODE?: string; // the setup site's answer, from the template the Deploy button copied
  DEV_WORKER_HOST?: string;
}

/**
 * The State Durable Object as the app's key-value interface. A deploy resets the object ("Durable
 * Object reset because its code was updated"), and the build callback arrives seconds after one, so
 * calls retry, each on a fresh stub: one that threw is broken.
 */
class StateStub implements StateStorage {
  private ns: Env["STATE"];

  constructor(ns: Env["STATE"]) {
    this.ns = ns;
  }

  private async call<T>(fn: (stub: DurableObjectStub<State>) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(this.ns.getByName("state"));
      } catch (e) {
        const retryable = (e as { retryable?: boolean }).retryable || String(e).includes("reset");
        if (attempt === 2 || !retryable) throw e;
      }
    }
  }

  get(key: string): Promise<string | null> {
    return this.call((s) => s.read(key));
  }

  put(key: string, value: string): Promise<void> {
    return this.call((s) => s.write(key, value));
  }
}

function app(env: Env): App {
  return new App({
    storage: new StateStub(env.STATE),
    bucket: env.STORE ? (env.STORE as unknown as Bucket) : null,
    relays: (id) => env.RELAY.getByName(id) as unknown as RelayStub,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now() / 1000,
    env: { VERSION: env.VERSION, DEV_WORKER_HOST: env.DEV_WORKER_HOST, SETUP_MODE: env.SETUP_MODE },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The agent's WebSocket: checked here, then handed to its PC's Relay object, which keeps it.
    if (new URL(request.url).pathname === "/agent") {
      const a = app(env);
      const gate = await a.agentGate(request);
      return gate instanceof Response ? gate : env.RELAY.getByName(gate).fetch(request);
    }
    return app(env).handle(request);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(app(env).scheduled());
  },
} satisfies ExportedHandler<Env>;

/**
 * The Worker's config, secrets and setup state: one instance, strongly consistent. Workers KV was
 * used first, but it caches reads at the edge for up to a minute, so a read right after a write
 * could return the old value (seen live). Values are JSON strings (store.ts).
 */
export class State extends DurableObject<Env> {
  async read(key: string): Promise<string | null> {
    const value = await this.ctx.storage.get(key);
    return typeof value === "string" ? value : null;
  }

  async write(key: string, value: string): Promise<void> {
    await this.ctx.storage.put(key, value);
  }
}

type Attachment = { since: number; info: Record<string, unknown> | null };

/**
 * The PC path's mailbox (design §9): holds the agent's WebSocket with the hibernation API, so an
 * idle connection costs nothing (S6), and relays the Worker's ComfyUI requests down it. One agent:
 * a new connection replaces the old one. The agent sends "ping" text frames, answered by the
 * runtime without waking the object.
 */
export class Relay extends DurableObject<Env> {
  private core: RelayCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.core = new RelayCore(() => this.current() as unknown as { send(d: string | Uint8Array): void } | null);
  }

  /** The agent's socket, if it is connected (relay.ts liveSocket); sockets that stopped pinging are closed. */
  private current(): WebSocket | null {
    const sockets = this.ctx.getWebSockets().map((ws) => ({
      ws,
      open: ws.readyState === WebSocket.OPEN,
      since: (ws.deserializeAttachment() as Attachment | null)?.since ?? 0,
      lastPing: this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null,
    }));
    const { live, stale } = liveSocket(sockets, Date.now());
    for (const ws of stale) this.retire(ws, 1011, "no pings");
    return live;
  }

  /** Closes a socket this side; requests waiting on it fail now rather than at their timeout. */
  private retire(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closing
    }
    this.core.onClose(ws as unknown as { send(d: string | Uint8Array): void });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    for (const old of this.ctx.getWebSockets()) if (old.readyState === WebSocket.OPEN) this.retire(old, 4000, "replaced by a new connection");
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ since: Date.now(), info: null } satisfies Attachment);
    this.core.connected();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") return; // normally answered by the auto-response
    const info = this.core.onFrame(message);
    if (info) ws.serializeAttachment({ ...(ws.deserializeAttachment() as Attachment), info });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.core.onClose(ws as unknown as { send(d: string | Uint8Array): void });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.core.onClose(ws as unknown as { send(d: string | Uint8Array): void });
  }

  // RPC, from the Worker.
  async request(req: RelayRequest): Promise<RelayReply> {
    return this.core.http(req);
  }

  async control(op: string, args?: unknown, timeoutS = CONTROL_TIMEOUT_S, body?: Uint8Array): Promise<RelayReply> {
    return this.core.control(op, args, timeoutS, body);
  }

  async status(): Promise<RelayStatus> {
    const ws = this.current();
    const att = ws ? (ws.deserializeAttachment() as Attachment | null) : null;
    return { connected: Boolean(ws), since: att?.since ?? null, info: att?.info ?? null };
  }

  /** Unpairing: close the agent's connection (its secret no longer opens a new one). */
  async drop(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(4001, "unpaired");
  }
}
