// A Worker made by the setup Worker (design §6): the claim, its OAuth tokens, updating itself
// through the Cloudflare API, and the storage check. The legacy (Workers Builds) path is app.test.ts's.

import { describe, expect, it } from "vitest";
import { cfapi } from "@comfy-gen/core";
import { request, world } from "./world.ts";

const DEV = "https://setup.example/dev";
const CLAIM = "claim-secret";
const tokens = (n: number) => ({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 3600 });
const body = async (resp: Response) => JSON.parse(await resp.text());

/** The Cloudflare API, its OAuth token endpoint and a development release base, faked. */
class FakeCloudflare {
  latest = "v1.1.0";
  module = new TextEncoder().encode("export default {}");
  badHash = false;
  r2 = true;
  known = new Set<string>(); // asset hashes Cloudflare already has
  issued = 1; // the last token pair handed out
  refreshes: string[] = []; // refresh tokens presented
  refuse = false; // the refresh token was revoked
  uploads: any[] = []; // script metadata
  buckets: string[] = [];
  lifecycles: string[] = [];
  assetBatches: string[][] = [];

  async manifest(): Promise<cfapi.WorkerManifest> {
    return {
      version: this.latest,
      module: { name: "index.js", sha256: this.badHash ? "0".repeat(64) : await cfapi.sha256Hex(this.module), size: this.module.length },
      compatibility_date: "2026-09-26", compatibility_flags: [],
      durable_objects: [{ name: "STATE", class_name: "State" }, { name: "RELAY", class_name: "Relay" }],
      migrations: [{ tag: "v1", new_sqlite_classes: ["Relay"] }, { tag: "v2", new_sqlite_classes: ["State"] }],
      r2_binding: "STORE",
      assets: { binding: "ASSETS", config: {}, files: { "/index.html": { hash: "h1", size: 4 }, "/app.js": { hash: "h2", size: 4 } } },
      crons: ["17 4 * * *"],
    };
  }

  handle = async (url: string, init: RequestInit): Promise<Response | null> => {
    const method = init.method ?? "GET";
    const ok = (result: unknown) => Response.json({ success: true, result, errors: [] });
    if (url === cfapi.CF_OAUTH_TOKEN) {
      const form = new URLSearchParams(String(init.body));
      this.refreshes.push(form.get("refresh_token")!);
      if (this.refuse || form.get("refresh_token") !== `r${this.issued}`) return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
      return Response.json(tokens(++this.issued));
    }
    if (url === `${DEV}/latest.txt`) return new Response(this.latest + "\n");
    if (url.startsWith(`${DEV}/`)) {
      const file = url.split("/").at(-1);
      if (file === "worker-manifest.json") return Response.json(await this.manifest());
      if (file === "worker-bundle.js") return new Response(this.module as BodyInit);
      if (file === "worker-assets.json") return Response.json({ h1: "aGkK", h2: "eD0x" });
      return new Response(null, { status: 404 });
    }
    if (!url.startsWith(cfapi.CF_API)) return null;
    const path = url.slice(cfapi.CF_API.length);
    const auth = new Headers(init.headers).get("authorization");
    if (path.endsWith("/assets-upload-session")) {
      const wanted = Object.values(JSON.parse(String(init.body)).manifest as Record<string, { hash: string }>).map((f) => f.hash).filter((h) => !this.known.has(h));
      return ok({ jwt: "S", buckets: wanted.length ? [wanted] : [] });
    }
    if (path.includes("/workers/assets/upload")) {
      const hashes = [...(init.body as FormData).keys()];
      hashes.forEach((h) => this.known.add(h));
      this.assetBatches.push(hashes);
      return ok({ jwt: "DONE" });
    }
    if (auth !== `Bearer a${this.issued}`) return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
    if (path === "/accounts/acct1/workers/scripts" && method === "GET") return ok([{ id: "comfy-gen-x", migration_tag: "v2" }]);
    if (path === "/accounts/acct1/workers/scripts/comfy-gen-x" && method === "PUT") {
      this.uploads.push(JSON.parse(await ((init.body as FormData).get("metadata") as Blob).text()));
      return ok({});
    }
    if (path === "/accounts/acct1/r2/buckets" && method === "POST") {
      if (!this.r2) return Response.json({ success: false, errors: [{ code: 10042, message: "Please enable R2" }] }, { status: 403 });
      this.buckets.push(JSON.parse(String(init.body)).name);
      return ok({});
    }
    if (path.endsWith("/lifecycle")) return (this.lifecycles.push(path.split("/")[5]), ok({}));
    return null;
  };
}

/** A Worker the setup Worker just created: CLAIM, the OAuth client and a dev release base set. */
function created() {
  const w = world();
  Object.assign(w.env, { CF_OAUTH_CLIENT: "cid", CLAIM, COMFY_GEN_SETUP: "https://setup.example", COMFY_GEN_RELEASES: DEV, SETUP_MODE: "cloud" });
  const cf = new FakeCloudflare();
  w.net.intercept = cf.handle;
  return { ...w, cf };
}

const claim = (w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) =>
  w.app.handle(request("POST", "/api/claim", { claim: CLAIM, tokens: tokens(1), account_id: "acct1", script: "comfy-gen-x", ...extra }));

/** Claimed, and logged in with the ticket: the session's cookie header. */
async function claimed(w: ReturnType<typeof created>) {
  const { ticket } = await body(await claim(w));
  const resp = await w.app.handle(request("POST", "/api/login", { ticket }));
  expect(resp.status).toBe(200);
  return { cookie: resp.headers.get("set-cookie")!.split(";")[0] };
}

describe("the claim", () => {
  it("takes the setup Worker's hand-off once, and answers a one-use login ticket", async () => {
    const w = created();
    expect((await claim(w, { claim: "wrong" })).status).toBe(403);
    const first = await claim(w);
    expect(first.status).toBe(200);
    const { ticket } = await body(first);
    expect((await claim(w)).status).toBe(403); // once only
    const s = await w.app.store.secrets();
    expect(s).toMatchObject({ cf_account_id: "acct1", cf_script: "comfy-gen-x" });
    const login = await w.app.handle(request("POST", "/api/login", { ticket }));
    expect(login.status).toBe(200);
    const cookie = { cookie: login.headers.get("set-cookie")!.split(";")[0] };
    const state = await body(await w.app.handle(request("GET", "/api/state", undefined, cookie)));
    expect(state).toMatchObject({ update_path: "oauth", cf_lost: null, cloudflare: { account_id: "acct1", script: "comfy-gen-x" } });
    expect((await w.app.handle(request("POST", "/api/login", { ticket }))).status).toBe(401); // used
  });

  it("a ticket lasts ten minutes; a Worker without CLAIM (made from a repository) refuses claims", async () => {
    const w = created();
    const { ticket } = await body(await claim(w));
    w.clock.t += 601;
    expect((await w.app.handle(request("POST", "/api/login", { ticket }))).status).toBe(401);
    const legacy = world();
    expect((await legacy.app.handle(request("POST", "/api/claim", { claim: "", tokens: tokens(1), account_id: "a", script: "s" }))).status).toBe(403);
    expect((await w.app.handle(request("POST", "/api/claim", { claim: CLAIM, account_id: "a", script: "s" }))).status).toBe(400);
  });
});

describe("the OAuth tokens", () => {
  it("are refreshed when due, one refresh at a time, and the rotated pair is stored", async () => {
    const w = created();
    await claimed(w);
    expect(await w.storage.cfAccessToken("cid")).toEqual({ token: "a1" }); // fresh: no refresh
    w.clock.t += 3400;
    const [x, y] = await Promise.all([w.storage.cfAccessToken("cid"), w.storage.cfAccessToken("cid")]);
    expect([x, y]).toEqual([{ token: "a2" }, { token: "a2" }]);
    expect(w.cf.refreshes).toEqual(["r1"]); // the second waited and found the new token
    expect(JSON.parse(w.storage.data.get("cf_oauth")!)).toMatchObject({ refresh_token: "r2" });
    expect(await w.storage.cfAccessToken("cid", true)).toEqual({ token: "a3" });
    expect(w.cf.refreshes).toEqual(["r1", "r2"]);
  });

  it("the daily check refreshes even with nothing to update", async () => {
    const w = created();
    await claimed(w);
    w.cf.latest = "v1.0.0";
    w.clock.t += 86400;
    expect(await w.app.scheduled()).toBe("up to date (v1.0.0)");
    expect(w.cf.refreshes).toEqual(["r1"]);
  });

  it("invalid_grant: the connection is lost until Reconnect Cloudflare hands over new tokens", async () => {
    const w = created();
    const cookie = await claimed(w);
    w.cf.refuse = true;
    w.clock.t += 3600;
    expect(await w.app.scheduled()).toMatch(/^Cloudflare connection lost: .*invalid_grant/);
    const update = await body(await w.app.handle(request("GET", "/api/update", undefined, cookie)));
    expect(update).toMatchObject({ path: "oauth", can: false, lost: expect.stringContaining("invalid_grant") });
    expect((await body(await w.app.handle(request("GET", "/api/state", undefined, cookie)))).cf_lost).toContain("invalid_grant");
    expect((await w.app.handle(request("POST", "/api/update", undefined, cookie))).status).toBe(502);

    const { url } = await body(await w.app.handle(request("POST", "/api/cloudflare/reconnect", undefined, cookie)));
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://setup.example/reconnect");
    expect(u.searchParams.get("worker")).toBe("https://comfy-gen.someone.workers.dev");
    const code = u.searchParams.get("code")!;
    expect((await w.app.handle(request("POST", "/api/claim", { reconnect: "wrong", tokens: tokens(7) }))).status).toBe(403);
    w.cf.refuse = false;
    w.cf.issued = 7;
    const back = await w.app.handle(request("POST", "/api/claim", { reconnect: code, tokens: tokens(7) }));
    expect(back.status).toBe(200);
    expect((await body(back)).ticket).toBeTruthy();
    expect((await body(await w.app.handle(request("GET", "/api/state", undefined, cookie)))).cf_lost).toBeNull();
    expect((await w.app.handle(request("POST", "/api/claim", { reconnect: code, tokens: tokens(7) }))).status).toBe(403); // one use
  });
});

describe("updating itself", () => {
  it("uploads the release with its bindings and state; unchanged assets aren't sent again", async () => {
    const w = created();
    const cookie = await claimed(w);
    const info = await body(await w.app.handle(request("GET", "/api/update", undefined, cookie)));
    expect(info).toMatchObject({ current: "v1.0.0", latest: "v1.1.0", newer: true, can: true, path: "oauth" });
    const resp = await w.app.handle(request("POST", "/api/update", undefined, cookie));
    expect(await body(resp)).toEqual({ updated: "v1.1.0", uploaded: 2 });
    const meta = w.cf.uploads[0];
    expect(meta.bindings).toEqual(expect.arrayContaining([
      { type: "plain_text", name: "VERSION", text: "v1.1.0" },
      { type: "plain_text", name: "SETUP_MODE", text: "cloud" },
      { type: "plain_text", name: "CF_OAUTH_CLIENT", text: "cid" },
      { type: "plain_text", name: "COMFY_GEN_RELEASES", text: DEV },
      { type: "r2_bucket", name: "STORE", bucket_name: "comfy-gen-x-storage" },
    ]));
    expect(meta.bindings.some((b: any) => b.name === "CLAIM")).toBe(false); // kept by Cloudflare, not re-sent
    expect(meta.keep_bindings).toEqual(["secret_text"]);
    expect(meta.migrations).toEqual({ old_tag: "v2", new_tag: "v2", steps: [] });

    w.cf.latest = "v1.2.0";
    expect(await w.app.scheduled()).toBe("updated v1.0.0 -> v1.2.0");
    expect(w.cf.assetBatches).toHaveLength(1); // the second upload had nothing new
    expect(await w.app.scheduled()).toBe("already tried v1.2.0");
  });

  it("refuses a bundle that doesn't match its manifest, and says so", async () => {
    const w = created();
    const cookie = await claimed(w);
    w.cf.badHash = true;
    const resp = await w.app.handle(request("POST", "/api/update", undefined, cookie));
    expect(resp.status).toBe(502);
    expect(await resp.text()).toContain("doesn't match its manifest");
    expect(w.cf.uploads).toEqual([]);
    expect(await w.app.scheduled()).toMatch(/^could not update to v1.1.0: .*manifest/);
    expect((await w.app.store.setup()).update_error).toContain("manifest");
  });

  it("storage, Check now: no bucket while R2 is off; once on, the bucket, its lifecycle and the binding", async () => {
    const w = created();
    const cookie = await claimed(w);
    w.cf.r2 = false;
    expect(await body(await w.app.handle(request("POST", "/api/setup/storage", undefined, cookie)))).toEqual({ storage: false });
    expect(w.cf.uploads).toEqual([]);
    w.cf.r2 = true;
    expect(await body(await w.app.handle(request("POST", "/api/setup/storage", undefined, cookie)))).toEqual({ storage: true });
    expect(w.cf.buckets).toEqual(["comfy-gen-x-storage"]);
    expect(w.cf.lifecycles).toEqual(["comfy-gen-x-storage"]);
    expect(w.cf.uploads[0].bindings).toEqual(expect.arrayContaining([
      { type: "plain_text", name: "VERSION", text: "v1.0.0" }, // the same version, now with R2
      { type: "r2_bucket", name: "STORE", bucket_name: "comfy-gen-x-storage" },
    ]));
  });
});
