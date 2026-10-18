// A fake of Modal's control plane behind the gRPC-web proxy: each call decoded with the client's
// own schemas, answered by a handler, and framed as gRPC-web (data frames, then the trailer frame).
// It behaves like Modal for setup: the sign-in is approved after a few waits, the setup image
// builds on the first join, a Sandbox prints lines and ends.

import { concat, utf8 } from "@comfy-gen/core";
import { frame } from "../src/modal/client.ts";
import * as pb from "../src/modal/proto.ts";

export const GRPC = "https://grpc.example";
const SERVICE = `${GRPC}/modal.client.ModalClient/`;

/** [request schema, response schema] per method. */
const METHODS: Record<string, [pb.Schema, pb.Schema]> = {
  AuthTokenGet: [pb.Empty, pb.AuthTokenGetResponse],
  TokenFlowCreate: [pb.TokenFlowCreateRequest, pb.TokenFlowCreateResponse],
  TokenFlowWait: [pb.TokenFlowWaitRequest, pb.TokenFlowWaitResponse],
  SecretGetOrCreate: [pb.SecretGetOrCreateRequest, pb.SecretGetOrCreateResponse],
  AppGetOrCreate: [pb.AppGetOrCreateRequest, pb.AppGetOrCreateResponse],
  ImageGetOrCreate: [pb.ImageGetOrCreateRequest, pb.ImageGetOrCreateResponse],
  ImageJoinStreaming: [pb.ImageJoinStreamingRequest, pb.ImageJoinStreamingResponse],
  SandboxCreate: [pb.SandboxCreateRequest, pb.SandboxCreateResponse],
  SandboxGetLogs: [pb.SandboxGetLogsRequest, pb.TaskLogsBatch],
  SandboxWait: [pb.SandboxWaitRequest, pb.SandboxWaitResponse],
};

/** Thrown by a handler: the call fails with this gRPC status. */
export class Status {
  code: number;
  message: string;
  constructor(code: number, message: string) {
    this.code = code;
    this.message = message;
  }
}

type Handler = (req: any, headers: Headers) => any;

export class FakeModal {
  calls: { method: string; req: any; headers: Headers }[] = [];
  approveAfter = 1; // TokenFlowWait answers {timeout} this many times first
  waits = 0;
  imageBuilt = false;
  imageFails = false;
  secrets: Record<string, Record<string, string>> = {};
  sandboxes: { id: string; definition: any }[] = [];
  logLines = ["Cloning…\n", "Deploying…\n"];
  sandboxDone = false;
  sandboxExit = 0;
  chunk = 0; // >0: the response body arrives in pieces this big
  handlers: Record<string, Handler> = {
    AuthTokenGet: () => ({ token: "auth-jwt" }),
    TokenFlowCreate: () => ({ token_flow_id: "tf-1", web_url: "https://modal.com/token-flow/tf-1", wait_secret: "ws-1" }),
    TokenFlowWait: (r) => {
      if (r.wait_secret !== "ws-1") throw new Status(7, "bad wait secret");
      return this.waits++ < this.approveAfter ? { timeout: true } : { token_id: "ak-new", token_secret: "as-new" };
    },
    SecretGetOrCreate: (r) => {
      this.secrets[r.deployment_name] = Object.fromEntries(r.env_dict.map((e: any) => [e.key, e.value]));
      return { secret_id: `st-${r.deployment_name}` };
    },
    AppGetOrCreate: (r) => ({ app_id: `ap-${r.app_name}` }),
    ImageGetOrCreate: () => ({ image_id: "im-1", ...(this.imageBuilt ? { result: { status: 1 } } : {}) }),
    ImageJoinStreaming: () => {
      this.imageBuilt = !this.imageFails;
      return [{ entry_id: "e1" }, { result: this.imageFails ? { status: 2, exception: "pip failed" } : { status: 1 } }];
    },
    SandboxCreate: (r) => {
      const id = `sb-${this.sandboxes.length + 1}`;
      this.sandboxes.push({ id, definition: r.definition });
      return { sandbox_id: id };
    },
    SandboxGetLogs: (r) => {
      const from = Number(r.last_entry_id || 0);
      const items = this.logLines.slice(from).map((data) => ({ data }));
      return [{ items, entry_id: String(this.logLines.length), eof: this.sandboxDone }];
    },
    SandboxWait: () => (this.sandboxDone ? { result: { status: this.sandboxExit ? 2 : 1, exitcode: this.sandboxExit } } : {}),
  };

  /** Its answer to *url*, or null when it isn't Modal's API (or npm's version lookup). */
  handle = async (url: string, init: RequestInit = {}): Promise<Response | null> => {
    if (url === "https://registry.npmjs.org/modal/latest") return Response.json({ version: "0.9.0" });
    if (!url.startsWith(SERVICE)) return null;
    const method = url.slice(SERVICE.length);
    const schemas = METHODS[method];
    if (!schemas) return new Response("not an allowed method\n", { status: 403 });
    const body = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
    const req = pb.decode(schemas[0], body.subarray(5));
    const headers = new Headers(init.headers);
    this.calls.push({ method, req, headers });
    let answers: any[];
    try {
      const a = this.handlers[method](req, headers);
      answers = Array.isArray(a) ? a : [a];
    } catch (e) {
      if (!(e instanceof Status)) throw e;
      // A trailers-only answer, as Modal gives for an error.
      return new Response(null, { headers: { "content-type": "application/grpc-web+proto", "grpc-status": String(e.code), "grpc-message": encodeURIComponent(e.message) } });
    }
    const all = concat([...answers.map((a) => frame(pb.encode(schemas[1], a))), frame(utf8("grpc-status: 0\r\ngrpc-message: \r\n"), 0x80)]);
    const size = this.chunk || all.length;
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < all.length; i += size) c.enqueue(all.slice(i, i + size));
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "application/grpc-web+proto" } });
  };
}
