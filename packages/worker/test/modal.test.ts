import { describe, expect, it } from "vitest";
import * as pb from "../src/modal/proto.ts";
import { GrpcError, ModalClient } from "../src/modal/client.ts";
import { FakeModal, GRPC, Status } from "./fake-modal.ts";

describe("the protobuf codec", () => {
  it("round-trips the kinds used, and skips fields it doesn't know", () => {
    const bytes = pb.encode(pb.SecretGetOrCreateRequest, { deployment_name: "comfy-gen-token", object_creation_type: 3, env_dict: { A: "1", "B é": "2" } });
    expect(pb.decode(pb.SecretGetOrCreateRequest, bytes)).toEqual({
      deployment_name: "comfy-gen-token", object_creation_type: 3, env_dict: [{ key: "A", value: "1" }, { key: "B é", value: "2" }],
    });
    const wait = pb.decode(pb.TokenFlowWaitRequest, pb.encode(pb.TokenFlowWaitRequest, { timeout: 20, token_flow_id: "tf" }));
    expect(wait).toEqual({ timeout: 20, token_flow_id: "tf" }); // defaults are left out
    const result = pb.decode(pb.SandboxWaitResponse, pb.encode(pb.SandboxWaitResponse, { result: { status: 2, exitcode: -9, exception: "killed" } }));
    expect(result).toEqual({ result: { status: 2, exitcode: -9, exception: "killed" } });
    // A message with more fields than the schema: the others are skipped.
    const full = pb.encode(pb.TokenFlowCreateResponse, { token_flow_id: "a", web_url: "u", code: "c", wait_secret: "w" });
    expect(pb.decode(pb.SandboxCreateResponse, full)).toEqual({ sandbox_id: "a" });
  });

  it("matches protobuf's own encoding (bytes from protobuf-es with Modal's api.proto, 2026-10-17)", () => {
    // SandboxCreateRequest{app_id:"ap", definition:{entrypoint_args:["bash"], timeout_secs:900, network_access:{network_access_type:1}}}
    const bytes = pb.encode(pb.SandboxCreateRequest, { app_id: "ap", definition: { entrypoint_args: ["bash"], timeout_secs: 900, network_access: { network_access_type: 1 } } });
    expect(Buffer.from(bytes).toString("hex")).toBe("0a026170120e0a0462617368388407b201020801");
  });
});

function client(fake: FakeModal, token = true) {
  const fetch = async (url: string, init?: RequestInit) => (await fake.handle(url, init)) ?? new Response(null, { status: 404 });
  return new ModalClient({ fetch, now: () => 1000, base: GRPC, token: token ? { id: "ak", secret: "as" } : null });
}

describe("the gRPC-web client", () => {
  it("sends Modal's headers, and an auth token from AuthTokenGet once", async () => {
    const fake = new FakeModal();
    const c = client(fake);
    expect(await c.appId("comfy-gen-setup")).toBe("ap-comfy-gen-setup");
    await c.appId("other");
    expect(fake.calls.map((x) => x.method)).toEqual(["AuthTokenGet", "AppGetOrCreate", "AppGetOrCreate"]);
    const h = fake.calls[1].headers;
    expect(h.get("x-modal-client-type")).toBe("8");
    expect(h.get("x-modal-libmodal-version")).toBe("modal-js/0.9.0");
    expect([h.get("x-modal-token-id"), h.get("x-modal-token-secret"), h.get("x-modal-auth-token")]).toEqual(["ak", "as", "auth-jwt"]);
    expect(fake.calls[0].headers.get("x-modal-auth-token")).toBeNull();
  });

  it("the sign-in needs no token; a refusal is a GrpcError with Modal's message", async () => {
    const fake = new FakeModal();
    const c = client(fake, false);
    const flow = await c.tokenFlowCreate();
    expect(flow).toMatchObject({ token_flow_id: "tf-1", wait_secret: "ws-1" });
    expect(await c.tokenFlowWait("tf-1", "ws-1", 20)).toEqual({ timeout: true });
    expect(await c.tokenFlowWait("tf-1", "ws-1", 20)).toMatchObject({ token_id: "ak-new", workspace_username: "someone" });
    const e = await c.tokenFlowWait("tf-1", "nope", 20).catch((e) => e);
    expect(e).toBeInstanceOf(GrpcError);
    expect([e.code, e.message]).toEqual([7, "bad wait secret"]);
    expect(fake.calls.some((x) => x.method === "AuthTokenGet")).toBe(false);
  });

  it("streams arrive in any pieces; an error in the trailer frame throws", async () => {
    const fake = new FakeModal();
    fake.chunk = 3;
    const c = client(fake);
    expect(await c.image("ap", ["FROM python:3.12-slim"], 120)).toBe("im-1"); // built on the first join
    fake.logLines = ["a\n", "b\n", "c\n"];
    expect(await c.sandboxLogs("sb-1", "", 5)).toEqual({ lines: ["a\n", "b\n", "c\n"], entry: "3", eof: false });
    expect(await c.sandboxLogs("sb-1", "2", 5)).toEqual({ lines: ["c\n"], entry: "3", eof: false });
    fake.handlers.SandboxGetLogs = () => { throw new Status(5, "no such sandbox"); };
    await expect(c.sandboxLogs("sb-x", "", 5)).rejects.toThrow("no such sandbox");
    fake.imageBuilt = false;
    fake.imageFails = true;
    await expect(c.image("ap", ["FROM x"], 120)).rejects.toThrow("pip failed");
  });

  it("a too-old client looks its version up again and retries once", async () => {
    const fake = new FakeModal();
    let tries = 0;
    fake.handlers.AppGetOrCreate = (_r, h) => {
      tries++;
      if (tries === 1) throw new Status(9, "Please upgrade your client version");
      return { app_id: `ap-${h.get("x-modal-libmodal-version")}` };
    };
    expect(await client(fake).appId("x")).toBe("ap-modal-js/0.9.0");
    expect(tries).toBe(2);
    fake.handlers.AppGetOrCreate = () => { throw new Status(9, "too old"); };
    await expect(client(fake).appId("x")).rejects.toThrow("too old"); // once only
  });

  it("an HTTP error (the proxy's 403 for a method it doesn't allow) is a GrpcError too", async () => {
    const fake = new FakeModal();
    const c = client(fake);
    const e = await c.unary("AppList", pb.Empty, {}, pb.Empty).catch((e) => e);
    expect(e).toBeInstanceOf(GrpcError);
    expect(e.code).toBe(-403);
  });
});
