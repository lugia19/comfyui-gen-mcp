// Test fixtures: the Worker's App over fake storage, a fake network and a controllable clock.

import { utf8 } from "@comfy-gen/core";
import { FakeComfy, png } from "../../core/test/fake-comfy.ts";
import { App } from "../src/app.ts";
import type { RelayReply, RelayRequest, RelayStatus, RelayStub } from "../src/relay.ts";
import type { StateStorage } from "../src/platform.ts";
import { clearCache } from "../src/store.ts";

export const COMFY = "https://comfy.example";
export const ADMIN = "https://admin.example"; // the Modal app's admin API
export const HOST = "comfy-gen.someone.workers.dev";
export const TOKEN = "cfut_owner";

export class FakeStorage implements StateStorage {
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
  latestRelease: string | null = "v1.0.0";
  tokenStatus = "active";
  scripts: Record<string, string> = { "comfy-gen": "tag1" }; // what the token can see
  buildsStarted: any[] = [];
  buildVars: Record<string, any> = {};
  adminCalls: [string, string, any][] = [];
  seedState: Record<string, any> = {};
  adminUp = true;
  loras: Record<string, number> = {};
  uploads: Record<string, any> = {};

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
    if (u.host === "github.com" && u.pathname.endsWith("/releases/latest")) {
      if (!this.latestRelease) return new Response(null, { status: 302, headers: { location: "https://github.com/lugia19/comfyui-gen-mcp/releases" } });
      return new Response(null, { status: 302, headers: { location: `https://github.com/lugia19/comfyui-gen-mcp/releases/tag/${this.latestRelease}` } });
    }
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
    if (method === "POST" && path === "/idle") return jsonResp({ seconds: body.seconds });
    if (method === "GET" && path === "/loras") return jsonResp(this.loras);
    if (method === "POST" && path === "/loras/uploads") {
      if (!String(body.filename).endsWith(".safetensors")) return jsonResp({ detail: "LoRA files must be .safetensors" }, 400);
      const id = "u".repeat(43);
      this.uploads[id] = { ...body, state: "uploading" };
      return jsonResp({ id, chunk_size: 16, chunks: Math.ceil(body.size / 16) });
    }
    const up = /^\/loras\/uploads\/([\w-]+)(\/finish)?$/.exec(path);
    if (up && this.uploads[up[1]]) {
      if (up[2]) this.uploads[up[1]].state = "assembling";
      return jsonResp({ state: this.uploads[up[1]].state });
    }
    if (up) return jsonResp({ detail: "unknown or expired upload" }, 404);
    if (method === "POST" && path === "/loras/downloads") {
      if (!(body.name in this.loras)) return jsonResp({ detail: `no LoRA named ${body.name}` }, 404);
      return jsonResp({ id: "d".repeat(43) });
    }
    if (method === "DELETE" && path.startsWith("/loras/")) {
      const name = decodeURIComponent(path.slice(7));
      if (!(name in this.loras)) return jsonResp({ detail: `no LoRA named ${name}` }, 404);
      delete this.loras[name];
      return jsonResp({ deleted: name });
    }
    return new Response(null, { status: 404 });
  }
}

export class Clock {
  t = 1_800_000_000;
  now = () => this.t;
}

/** The Relay Durable Object with an agent behind it: its own FakeComfy (the PC's ComfyUI), and
 * control operations answered from *controls* (op -> [status, JSON or message]). */
export class FakeRelay implements RelayStub {
  comfy = new FakeComfy();
  connected = true;
  controls: Record<string, (args: any) => [number, unknown]> = {
    ensure: () => [200, { ok: true }],
  };
  controlCalls: [string, any][] = [];
  dropped = 0;
  paused = false; // the agent's tray pause, as its hello reports it

  async request(req: RelayRequest): Promise<RelayReply> {
    if (!this.connected) return { status: 503, body: utf8("offline"), offline: true };
    const r = await this.comfy.request(req.method, req.path, { params: req.params, headers: req.headers, body: req.body });
    return { status: r.status, body: r.content };
  }

  async control(op: string, args?: unknown): Promise<RelayReply> {
    this.controlCalls.push([op, args]);
    if (!this.connected) return { status: 503, body: utf8("offline"), offline: true };
    const handler = this.controls[op];
    if (!handler) return { status: 400, body: utf8(`unknown op ${op}`) };
    const [status, data] = handler(args);
    return { status, body: utf8(status === 200 ? JSON.stringify(data) : String(data)) };
  }

  async status(): Promise<RelayStatus> {
    return { connected: this.connected, since: this.connected ? 1000 : null, info: this.connected ? { version: "t", gpu: "nvidia", paused: this.paused } : null };
  }

  async drop(): Promise<void> {
    this.dropped += 1;
  }
}

export function world() {
  clearCache();
  const comfy = new FakeComfy();
  const storage = new FakeStorage();
  const net = new FakeNet(comfy);
  const clock = new Clock();
  const pc = new FakeRelay();
  const env: Record<string, string | undefined> = { VERSION: "v1.0.0" };
  const app = new App({ storage, relay: pc, fetch: net.fetch, now: clock.now, env, sleep: async (s) => void (clock.t += s) });
  return { app, storage, net, clock, comfy, pc, env };
}

export function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, base = `https://${HOST}`): Request {
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array) payload = body as BodyInit;
  else if (body !== undefined) payload = JSON.stringify(body);
  return new Request(base + path, { method, headers, body: payload });
}
