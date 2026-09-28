// Test fixtures: the Worker's App over fake storage, a fake network and a controllable clock.

import { FakeComfy, png } from "../../core/test/fake-comfy.ts";
import { App } from "../src/app.ts";
import type { KV } from "../src/platform.ts";
import { clearCache } from "../src/store.ts";

export const COMFY = "https://comfy.example";
export const ADMIN = "https://admin.example"; // the Modal app's admin API
export const HOST = "comfy-gen.someone.workers.dev";
export const TOKEN = "cfut_owner";

export class FakeKV implements KV {
  data = new Map<string, string>();
  writes = 0;
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.writes += 1;
    this.data.set(key, value);
  }
}

const jsonResp = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const cf = (result: unknown, ok = true) =>
  jsonResp({ success: ok, result, errors: ok ? [] : [{ code: 1, message: "nope" }] }, ok ? 200 : 400);

async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  if (body === undefined || body === null) return "";
  return new Response(body).text();
}

/** The Worker's fetch: FakeComfy, a scripted Cloudflare API, the Modal admin API, GitHub, images. */
export class FakeNet {
  comfy: FakeComfy;
  calls: [string, string, Record<string, string>][] = [];
  latestRelease = "v1.0.0";
  tokenStatus = "active";
  scripts: Record<string, string> = { "comfy-gen": "tag1" }; // what the token can see
  buildsStarted: any[] = [];
  buildVars: Record<string, any> = {};
  adminCalls: [string, string, any][] = [];
  seedState: Record<string, any> = {};
  adminUp = true;

  constructor(comfy: FakeComfy) {
    this.comfy = comfy;
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const headers = { ...((init.headers as Record<string, string>) ?? {}) };
    this.calls.push([method, url, headers]);
    const u = new URL(url);
    if (url.startsWith(COMFY)) {
      const params = u.search ? Object.fromEntries(u.searchParams) : undefined;
      const body = init.body instanceof Uint8Array ? init.body : typeof init.body === "string" ? init.body : undefined;
      const r = await this.comfy.request(method, u.pathname, { params, headers, body });
      return new Response(r.status === 204 ? null : (r.content as BodyInit), { status: r.status });
    }
    if (url.startsWith(ADMIN)) {
      const text = await bodyText(init.body);
      return this.admin(method, u.pathname, text ? JSON.parse(text) : null);
    }
    if (u.host === "api.cloudflare.com") return this.cloudflare(method, u.pathname.replace(/^\/client\/v4/, ""), await bodyText(init.body));
    if (u.host === "api.github.com") return jsonResp({ tag_name: this.latestRelease });
    if (u.host === "images.example") return u.pathname.endsWith(".png") ? new Response(png(1600, 900) as BodyInit) : new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  };

  private cloudflare(method: string, path: string, body: string): Response {
    if (path === "/user/tokens/verify") {
      const ok = this.tokenStatus === "active";
      return cf(ok ? { id: "t", status: "active" } : null, ok);
    }
    if (path === "/accounts") return cf([{ id: "acct1", name: "Someone" }]);
    if (path.includes("/workers/scripts-search")) return cf(Object.entries(this.scripts).map(([name, id]) => ({ id, script_name: name })));
    if (path.endsWith("/builds/workers/tag1/triggers")) return cf([{ trigger_uuid: "trig1", branch_includes: ["main"] }]);
    if (path.endsWith("/environment_variables") && method === "PATCH") {
      Object.assign(this.buildVars, JSON.parse(body));
      return cf(null);
    }
    if (path.endsWith("/builds") && method === "POST") {
      this.buildsStarted.push(JSON.parse(body));
      return cf({ build_uuid: `build${this.buildsStarted.length}` });
    }
    if (path.includes("/builds/builds/") && path.endsWith("/logs")) return cf({ lines: [[1, "hello"], [2, "world"]], cursor: "c2" });
    if (path.includes("/builds/builds/")) return cf({ status: "running", build_outcome: null });
    return cf(null, false);
  }

  private admin(method: string, path: string, body: any): Response {
    if (!this.adminUp) return new Response("cold", { status: 503 });
    this.adminCalls.push([method, path, body]);
    if (method === "POST" && path === "/seed") {
      this.seedState[body.pack] = { state: "queued", done: 0, total: 1 };
      return jsonResp({ started: true, ...this.seedState[body.pack] });
    }
    if (method === "GET" && path.startsWith("/seed/")) return jsonResp(this.seedState[path.split("/").at(-1)!] ?? { state: "missing" });
    if (method === "GET" && path === "/status") return jsonResp({ reload: { ok: true } });
    if (method === "GET" && path === "/files") return jsonResp({ "vae/ae.safetensors": 3 });
    if (method === "POST" && path === "/idle") return jsonResp({ seconds: body.seconds });
    return new Response(null, { status: 404 });
  }
}

export class Clock {
  t = 1_800_000_000;
  now = () => this.t;
}

export function world() {
  clearCache();
  const comfy = new FakeComfy();
  const kv = new FakeKV();
  const net = new FakeNet(comfy);
  const clock = new Clock();
  const env: Record<string, string | undefined> = { VERSION: "v1.0.0" };
  const app = new App({ kv, fetch: net.fetch, now: clock.now, env, sleep: async (s) => void (clock.t += s) });
  return { app, kv, net, clock, comfy, env };
}

export function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, base = `https://${HOST}`): Request {
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array) payload = body as BodyInit;
  else if (body !== undefined) payload = JSON.stringify(body);
  return new Request(base + path, { method, headers, body: payload });
}
