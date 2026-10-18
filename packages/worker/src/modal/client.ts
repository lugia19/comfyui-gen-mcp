// Modal's control plane from a Worker (design §6, "Setup without a repository"): gRPC-web over
// fetch, through our proxy (grpc.lugia19.com → Envoy on Cloud Run → api.modal.com), with Modal's
// headers as its JS SDK (libmodal) sends them. Unary calls and server streams; the protobuf
// messages are proto.ts's.

import { concat, fromBase64Url, fromUtf8 } from "@comfy-gen/core";
import type { Fetch } from "../platform.ts";
import * as pb from "./proto.ts";

/** Our gRPC-web proxy for Modal's API. */
export const MODAL_GRPC = "https://grpc.lugia19.com";

export class GrpcError extends Error {
  name = "GrpcError";
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export type ModalToken = { id: string; secret: string };

// libmodal's version, which Modal checks: looked up on npm, kept a day (plain data, fine at module
// scope; a failed lookup ten minutes), and looked up again once if Modal says the client is too old.
let libmodal: { v: string; until: number } | null = null;
async function libmodalVersion(fetch: Fetch, now: number, fresh: boolean): Promise<string> {
  if (!fresh && libmodal && now < libmodal.until) return libmodal.v;
  const r = await fetch("https://registry.npmjs.org/modal/latest").catch(() => null);
  const v = r?.ok ? String(((await r.json()) as any).version ?? "") : "";
  libmodal = v ? { v, until: now + 86400 } : { v: libmodal?.v ?? "0.0.0", until: now + 600 };
  return libmodal.v;
}

// Modal's auth tokens (JWTs), per Modal token id, until a minute before they expire: plain data.
const authTokens = new Map<string, { jwt: string; until: number }>();
function expiry(jwt: string, now: number): number {
  try {
    const exp = Number(JSON.parse(fromUtf8(fromBase64Url(jwt.split(".")[1]))).exp);
    if (exp > now) return exp - 60;
  } catch {}
  return now + 300;
}

const tooOld = (e: unknown) => e instanceof GrpcError && /version|upgrade|deprecated|too old/i.test(e.message);

/** A gRPC-web frame: a flag byte (0x80: trailers), the length, the message. */
export function frame(bytes: Uint8Array, flag = 0): Uint8Array {
  const out = new Uint8Array(5 + bytes.length);
  out[0] = flag;
  new DataView(out.buffer).setUint32(1, bytes.length);
  out.set(bytes, 5);
  return out;
}

function checkStatus(status: string | null | undefined, message: string | null | undefined) {
  const code = Number(status ?? 0);
  if (code !== 0) throw new GrpcError(code, decodeURIComponent(message ?? "") || `gRPC status ${code}`);
}

function trailers(text: string): Record<string, string> {
  const t: Record<string, string> = {};
  for (const line of text.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) t[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return t;
}

export type ClientOptions = { fetch: Fetch; now: () => number; token?: ModalToken | null; base?: string };

/** A client for a request or a job: it gets an auth token on its first authenticated call (or
 * finds one still valid from an earlier client with the same token). */
export class ModalClient {
  private readonly o: ClientOptions;
  private authToken: string | null = null;
  private authing: Promise<void> | null = null; // calls started together wait for one AuthTokenGet

  constructor(o: ClientOptions) {
    this.o = o;
  }

  private async headers(fresh: boolean, auth: boolean): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      "content-type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      "x-modal-client-type": "8", // CLIENT_TYPE_LIBMODAL_JS
      "x-modal-client-version": "1.0.0", // libmodal's: behaves like this Python SDK version
      "x-modal-libmodal-version": `modal-js/${await libmodalVersion(this.o.fetch, this.o.now(), fresh)}`,
    };
    const t = this.o.token;
    if (t) {
      h["x-modal-token-id"] = t.id;
      h["x-modal-token-secret"] = t.secret;
      if (auth && this.authToken) h["x-modal-auth-token"] = this.authToken;
    }
    return h;
  }

  /** One call's data frames, as they arrive; the trailer frame's status ends it. */
  private async *frames(method: string, body: Uint8Array, fresh: boolean, timeoutS: number): AsyncGenerator<Uint8Array> {
    const resp = await this.o.fetch(`${this.o.base ?? MODAL_GRPC}/modal.client.ModalClient/${method}`, {
      method: "POST", headers: await this.headers(fresh, method !== "AuthTokenGet"), body: frame(body) as BodyInit,
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
    if (resp.status !== 200) throw new GrpcError(-resp.status, `Modal's API: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    checkStatus(resp.headers.get("grpc-status"), resp.headers.get("grpc-message")); // a trailers-only answer
    const reader = resp.body!.getReader();
    let buf = new Uint8Array(0);
    for (;;) {
      while (buf.length >= 5) {
        const n = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
        if (buf.length < 5 + n) break;
        const flag = buf[0];
        const payload = buf.subarray(5, 5 + n);
        buf = buf.subarray(5 + n);
        if (flag & 0x80) {
          const t = trailers(fromUtf8(payload));
          return checkStatus(t["grpc-status"], t["grpc-message"]);
        }
        yield payload;
      }
      const { value, done } = await reader.read();
      if (done) return;
      buf = buf.length ? concat([buf, value]) : value;
    }
  }

  private auth(): Promise<void> {
    const t = this.o.token;
    if (!t || this.authToken) return Promise.resolve();
    const cached = authTokens.get(t.id);
    if (cached && this.o.now() < cached.until) {
      this.authToken = cached.jwt;
      return Promise.resolve();
    }
    return (this.authing ??= this.unary<{ token?: string }>("AuthTokenGet", pb.Empty, {}, pb.AuthTokenGetResponse).then((r) => {
      this.authToken = r.token || null;
      if (r.token) authTokens.set(t.id, { jwt: r.token, until: expiry(r.token, this.o.now()) });
    }).finally(() => (this.authing = null)));
  }

  /** A unary call (*timeoutS* for the whole call). Throws GrpcError. */
  async unary<T = Record<string, any>>(method: string, req: pb.Schema, value: Record<string, any>, res: pb.Schema, timeoutS = 60): Promise<T> {
    if (method !== "AuthTokenGet") await this.auth();
    const body = pb.encode(req, value);
    const once = async (fresh: boolean) => {
      let out: Uint8Array = new Uint8Array(0);
      for await (const f of this.frames(method, body, fresh, timeoutS)) out = f;
      return pb.decode<T>(res, out);
    };
    try {
      return await once(false);
    } catch (e) {
      if (!tooOld(e)) throw e;
      return once(true);
    }
  }

  /** A server stream's messages. Throws GrpcError. */
  async *stream<T = Record<string, any>>(method: string, req: pb.Schema, value: Record<string, any>, res: pb.Schema, timeoutS = 60): AsyncGenerator<T> {
    await this.auth();
    for await (const f of this.frames(method, pb.encode(req, value), false, timeoutS)) yield pb.decode<T>(res, f);
  }

  // ── The calls setup makes ──

  /** Start Modal's sign-in: the person approves at *web_url*. Needs no token. */
  tokenFlowCreate() {
    return this.unary<{ token_flow_id: string; web_url: string; wait_secret: string }>(
      "TokenFlowCreate", pb.TokenFlowCreateRequest, { utm_source: "comfy-gen" }, pb.TokenFlowCreateResponse);
  }

  /** Wait up to *waitS* for the approval: the token, or {timeout: true}. */
  tokenFlowWait(flowId: string, waitSecret: string, waitS: number) {
    return this.unary<{ token_id?: string; token_secret?: string; timeout?: boolean }>(
      "TokenFlowWait", pb.TokenFlowWaitRequest, { token_flow_id: flowId, wait_secret: waitSecret, timeout: waitS }, pb.TokenFlowWaitResponse, waitS + 15);
  }

  /** A named Secret holding *env*, replaced if it exists: its id. */
  async secretPut(name: string, env: Record<string, string>): Promise<string> {
    const r = await this.unary<{ secret_id: string }>("SecretGetOrCreate", pb.SecretGetOrCreateRequest, {
      deployment_name: name, object_creation_type: pb.CREATE_OVERWRITE_IF_EXISTS, env_dict: env,
    }, pb.SecretGetOrCreateResponse);
    return r.secret_id;
  }

  async appId(name: string): Promise<string> {
    return (await this.unary<{ app_id: string }>("AppGetOrCreate", pb.AppGetOrCreateRequest, { app_name: name, object_creation_type: pb.CREATE_IF_MISSING }, pb.AppGetOrCreateResponse)).app_id;
  }

  /** An image from Dockerfile *commands* in *appId*, built if needed (waiting up to *waitS*): its id.
   * Throws GrpcError when the build fails or doesn't finish in time. */
  async image(appId: string, commands: string[], waitS: number): Promise<string> {
    const r = await this.unary<{ image_id: string; result?: { status?: number; exception?: string } }>(
      "ImageGetOrCreate", pb.ImageGetOrCreateRequest, { app_id: appId, image: { dockerfile_commands: commands }, builder_version: "2024.10" }, pb.ImageGetOrCreateResponse);
    let result = r.result;
    let last = "";
    const until = this.o.now() + waitS;
    while (!result?.status) {
      if (this.o.now() >= until) throw new GrpcError(4, "Modal is still building the setup image: try again in a minute.");
      for await (const m of this.stream<{ result?: { status?: number; exception?: string }; entry_id?: string }>(
        "ImageJoinStreaming", pb.ImageJoinStreamingRequest, { image_id: r.image_id, timeout: 25, last_entry_id: last }, pb.ImageJoinStreamingResponse, 40)) {
        if (m.entry_id) last = m.entry_id;
        if (m.result?.status) result = m.result;
      }
    }
    if (result.status !== pb.STATUS_SUCCESS) throw new GrpcError(13, `Modal couldn't build the setup image: ${result.exception || `status ${result.status}`}`);
    return r.image_id;
  }

  async sandboxCreate(appId: string, definition: { image_id: string; secret_ids: string[]; entrypoint_args: string[]; timeout_secs: number }): Promise<string> {
    const r = await this.unary<{ sandbox_id: string }>("SandboxCreate", pb.SandboxCreateRequest, {
      app_id: appId, definition: { ...definition, network_access: { network_access_type: pb.NETWORK_OPEN } },
    }, pb.SandboxCreateResponse);
    return r.sandbox_id;
  }

  /** A Sandbox's output after *lastEntry*, waiting up to *waitS* for some: the lines, where to go
   * on from, and whether it has ended. */
  async sandboxLogs(sandboxId: string, lastEntry: string, waitS: number): Promise<{ lines: string[]; entry: string; eof: boolean }> {
    const lines: string[] = [];
    let entry = lastEntry;
    let eof = false;
    for await (const b of this.stream<{ items: { data?: string }[]; entry_id?: string; eof?: boolean }>(
      "SandboxGetLogs", pb.SandboxGetLogsRequest, { sandbox_id: sandboxId, file_descriptor: pb.STDOUT, timeout: waitS, last_entry_id: lastEntry }, pb.TaskLogsBatch, waitS + 15)) {
      for (const i of b.items) if (i.data) lines.push(i.data);
      if (b.entry_id) entry = b.entry_id;
      if (b.eof) eof = true;
    }
    return { lines, entry, eof };
  }

  /** The Sandbox's result once it has ended (waiting up to *waitS*), else null. */
  async sandboxResult(sandboxId: string, waitS: number): Promise<{ status: number; exitcode: number; exception: string } | null> {
    const r = await this.unary<{ result?: { status?: number; exitcode?: number; exception?: string } }>(
      "SandboxWait", pb.SandboxWaitRequest, { sandbox_id: sandboxId, timeout: waitS }, pb.SandboxWaitResponse, waitS + 15);
    return r.result?.status ? { status: r.result.status, exitcode: r.result.exitcode ?? 0, exception: r.result.exception ?? "" } : null;
  }
}
