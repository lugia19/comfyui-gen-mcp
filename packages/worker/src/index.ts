// Cloudflare Worker entry: adapts the runtime to App (plain TypeScript, tested in Node), and
// declares the Durable Objects. Keep this file thin; logic belongs in app.ts.

import { DurableObject } from "cloudflare:workers";
import { App } from "./app.ts";
import type { StateStorage } from "./platform.ts";

export interface Env {
  STATE: DurableObjectNamespace<State>;
  RELAY: DurableObjectNamespace<Relay>;
  VERSION?: string;
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
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now() / 1000,
    env: { VERSION: env.VERSION, DEV_WORKER_HOST: env.DEV_WORKER_HOST },
  });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
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

/** The PC path's mailbox (design §9). Declared from the start so adding the agent later needs no
 * template change; the relay itself arrives with the agent. */
export class Relay extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response("The PC relay is not available yet.", { status: 501 });
  }
}
