// A Worker made by the setup Worker (design §6): the claim, its OAuth tokens, updating itself
// through the Cloudflare API, and the storage check. The legacy (Workers Builds) path is app.test.ts's.

import { describe, expect, it } from "vitest";
import { FakeCloudflare, tokens } from "../../core/test/fake-cloudflare.ts";
import { request, TOKEN, world } from "./world.ts";

const DEV = "https://setup.example/dev";
const CLAIM = "claim-secret";
const body = async (resp: Response) => JSON.parse(await resp.text());

/** A Worker the setup Worker just created: CLAIM, the OAuth client and a dev release base set. */
function created() {
  const w = world();
  Object.assign(w.env, { CF_OAUTH_CLIENT: "cid", CLAIM, COMFY_GEN_SETUP: "https://setup.example", COMFY_GEN_RELEASES: DEV, SETUP_MODE: "cloud" });
  const cf = new FakeCloudflare(DEV);
  cf.latest = "v1.1.0";
  cf.scripts = { "comfy-gen-x": "v2" };
  cf.apiTokens.add(TOKEN);
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
    expect(state).toMatchObject({ cf_lost: null, cloudflare: { account_id: "acct1", script: "comfy-gen-x" } });
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

  it("a Cloudflare token still logs in (the way back without the password), and isn't kept", async () => {
    const w = created();
    await claimed(w);
    const resp = await w.app.handle(request("POST", "/api/login", { token: TOKEN }));
    expect(resp.status).toBe(200);
    expect((await w.app.store.secrets()).cf_token).toBeUndefined();
    delete w.cf.scripts["comfy-gen-x"];
    expect((await w.app.handle(request("POST", "/api/login", { token: TOKEN }))).status).toBe(401);
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
    w.clock.t += 3400;
    expect(await w.storage.cfAccessToken("cid")).toEqual({ token: "a3" });
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
    expect(await w.app.scheduled()).toMatch(/^not updating: Reconnect Cloudflare first .*invalid_grant/);
    expect((await w.app.store.setup()).update_tried).toBeUndefined(); // tried again once reconnected
    const update = await body(await w.app.handle(request("GET", "/api/update", undefined, cookie)));
    expect(update).toMatchObject({ path: "oauth", blocked: expect.stringContaining("invalid_grant") });
    expect((await body(await w.app.handle(request("GET", "/api/state", undefined, cookie)))).cf_lost).toContain("invalid_grant");
    expect((await w.app.handle(request("POST", "/api/update", undefined, cookie))).status).toBe(409);

    const { url } = await body(await w.app.handle(request("POST", "/api/cloudflare/reconnect", undefined, cookie)));
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://setup.example/reconnect");
    expect(u.searchParams.get("worker")).toBe("https://comfy-gen.someone.workers.dev");
    const code = u.searchParams.get("code")!;
    expect((await w.app.handle(request("POST", "/api/claim", { reconnect: "wrong", tokens: tokens(7) }))).status).toBe(403);
    w.cf.refuse = false;
    w.cf.issued = 7;
    expect((await w.app.handle(request("POST", "/api/claim", { reconnect: code, tokens: tokens(7), account_id: "other" }))).status).toBe(403);
    const back = await w.app.handle(request("POST", "/api/claim", { reconnect: code, tokens: tokens(7), account_id: "acct1" }));
    expect(back.status).toBe(200);
    expect((await body(back)).ticket).toBeTruthy();
    expect((await body(await w.app.handle(request("GET", "/api/state", undefined, cookie)))).cf_lost).toBeNull();
    expect((await w.app.handle(request("POST", "/api/claim", { reconnect: code, tokens: tokens(7), account_id: "acct1" }))).status).toBe(403); // one use
  });
});

describe("updating itself", () => {
  it("uploads the release with its bindings and state; unchanged assets aren't sent again", async () => {
    const w = created();
    const cookie = await claimed(w);
    const info = await body(await w.app.handle(request("GET", "/api/update", undefined, cookie)));
    expect(info).toMatchObject({ current: "v1.0.0", latest: "v1.1.0", newer: true, path: "oauth", blocked: null, failed: null, building: false });
    const resp = await w.app.handle(request("POST", "/api/update", undefined, cookie));
    expect(await body(resp)).toEqual({ latest: "v1.1.0", build: null }); // live already
    expect(w.cf.assetBatches).toEqual([["h1", "h2"]]);
    const meta = w.cf.uploads[0].meta;
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
    expect(await w.app.scheduled()).toBe("updating v1.0.0 -> v1.2.0: done");
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
    expect(await body(await w.app.handle(request("POST", "/api/setup/storage", undefined, cookie)))).toEqual({ storage: false, build: null });
    expect(w.cf.uploads).toEqual([]); // nothing would change
    w.cf.r2 = true;
    expect(await body(await w.app.handle(request("POST", "/api/setup/storage", undefined, cookie)))).toEqual({ storage: true, build: null });
    expect(w.cf.buckets).toEqual(["comfy-gen-x-storage"]);
    expect(w.cf.lifecycles).toEqual(["comfy-gen-x-storage"]);
    expect(await body(await w.app.handle(request("GET", "/api/setup/storage", undefined, cookie)))).toEqual({ storage: true });
    expect(w.cf.uploads[0].meta.bindings).toEqual(expect.arrayContaining([
      { type: "plain_text", name: "VERSION", text: "v1.0.0" }, // the same version, now with R2
      { type: "r2_bucket", name: "STORE", bucket_name: "comfy-gen-x-storage" },
    ]));
    // A later update finds the bucket there: no lifecycle again.
    w.cf.latest = "v1.2.0";
    await w.app.handle(request("POST", "/api/update", undefined, cookie));
    expect(w.cf.lifecycles).toHaveLength(1);
    expect(w.cf.uploads[1].meta.bindings).toEqual(expect.arrayContaining([{ type: "r2_bucket", name: "STORE", bucket_name: "comfy-gen-x-storage" }]));
  });
});
