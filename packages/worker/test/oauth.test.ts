// A Worker made by the setup Worker (design §6): the claim, its OAuth tokens, updating itself
// through the Cloudflare API, and the storage check. The legacy (Workers Builds) path is app.test.ts's.

import { describe, expect, it } from "vitest";
import { FakeCloudflare, tokens } from "../../core/test/fake-cloudflare.ts";
import { FakeModal, GRPC } from "./fake-modal.ts";
import { ADMIN, COMFY, HOST, request, TOKEN, world } from "./world.ts";

const DEV = "https://setup.example/dev";
const CLAIM = "claim-secret";
const body = async (resp: Response) => JSON.parse(await resp.text());

/** A Worker the setup Worker just created: CLAIM, the OAuth client and a dev release base set. */
function created() {
  const w = world();
  Object.assign(w.env, { CF_OAUTH_CLIENT: "cid", CLAIM, COMFY_GEN_SETUP: "https://setup.example", COMFY_GEN_RELEASES: DEV, SETUP_MODE: "cloud", MODAL_GRPC: GRPC });
  const cf = new FakeCloudflare(DEV);
  cf.latest = "v1.1.0";
  cf.scripts = { "comfy-gen-x": "v2" };
  cf.apiTokens.add(TOKEN);
  const modal = new FakeModal();
  w.net.intercept = async (url, init) => (await cf.handle(url, init)) ?? (await modal.handle(url, init));
  return { ...w, cf, modal };
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

  it("the heavy work goes to the State object when the platform has one (its CPU budget)", async () => {
    const w = created();
    const cookie = await claimed(w);
    const jobs: any[] = [];
    (w.app as any).p.inState = (job: any) => (jobs.push(job), w.app.runJob(job));
    expect(await body(await w.app.handle(request("POST", "/api/update", undefined, cookie)))).toEqual({ latest: "v1.1.0", build: null });
    expect(await body(await w.app.handle(request("POST", "/api/setup/storage", undefined, cookie)))).toEqual({ storage: true, build: null });
    w.cf.latest = "v1.2.0";
    expect(await w.app.scheduled()).toBe("updating v1.0.0 -> v1.2.0: done");
    expect(jobs).toEqual([{ kind: "install", tag: "v1.1.0", modal: true }, { kind: "install", tag: "v1.0.0", modal: false }, { kind: "cron" }]);
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

describe("Modal without a build", () => {
  const api = (w: ReturnType<typeof created>, method: string, path: string, cookie: Record<string, string>, b?: unknown) =>
    w.app.handle(request(method, `/api${path}`, b, cookie)).then(async (r) => [r.status, await body(r)] as const);

  /** Claimed, logged in and Modal connected through its sign-in. */
  async function connected() {
    const w = created();
    const cookie = await claimed(w);
    expect(await api(w, "POST", "/modal/connect", cookie)).toEqual([200, { url: "https://modal.com/token-flow/tf-1" }]);
    expect(await api(w, "POST", "/modal/connect/wait", cookie)).toEqual([200, { connected: false }]);
    expect(await api(w, "POST", "/modal/connect/wait", cookie)).toEqual([200, { connected: true }]);
    return { w, cookie };
  }

  it("Connect Modal: the token is kept here and in a workspace Secret", async () => {
    const { w, cookie } = await connected();
    expect((await w.app.store.secrets()).modal_token).toEqual({ id: "ak-new", secret: "as-new" });
    expect(w.modal.secrets["comfy-gen-token"]).toEqual({ MODAL_TOKEN_ID: "ak-new", MODAL_TOKEN_SECRET: "as-new" });
    expect((await api(w, "GET", "/state", cookie))[1]).toMatchObject({ update_path: "oauth", modal_deploy: null });
    expect((await api(w, "POST", "/modal/connect/wait", cookie))[0]).toBe(409); // that sign-in is used
    // A pasted token instead: kept, then the deploy starts with it.
    expect((await api(w, "POST", "/setup/modal", cookie, { token_id: "nope", token_secret: "x" }))[0]).toBe(400);
    expect(await api(w, "POST", "/setup/modal", cookie, { token_id: " ak-2 ", token_secret: "as-2" })).toEqual([200, { started: true }]);
    expect((await w.app.store.secrets()).modal_token).toEqual({ id: "ak-2", secret: "as-2" });
    expect(w.modal.secrets["comfy-gen-token"].MODAL_TOKEN_ID).toBe("ak-2");
  });

  it("deploys from a Sandbox, which reports to /build-callback", async () => {
    const { w, cookie } = await connected();
    expect(await api(w, "POST", "/setup/modal", cookie)).toEqual([200, { started: true }]);
    const sb = w.modal.sandboxes[0].definition;
    expect(sb.secret_ids).toEqual(["st-comfy-gen-token"]);
    expect(sb.timeout_secs).toBe(1800);
    const script = sb.entrypoint_args[2];
    expect(script).toContain(`'${DEV}/v1.0.0/source.tar.gz'`);
    expect(script).toContain(`--callback 'https://${HOST}/build-callback'`);
    expect(script).toContain("--version 'v1.0.0'");
    expect((await api(w, "GET", "/state", cookie))[1].modal_deploy).toEqual({ started: 1800000000 });
    expect(await api(w, "GET", "/setup/modal/log", cookie)).toEqual([200, { lines: ["Cloning…\n", "Deploying…\n"], cursor: "2", done: false }]);
    expect((await api(w, "GET", "/setup/modal/log?cursor=2", cookie))[1].lines).toEqual([]);

    const nonce = (await w.app.store.setup()).build_nonce;
    const report = { nonce, stage: "modal", version: "v1.0.0", modal_result: "deployed", modal: { server_url: COMFY, admin_url: ADMIN, proxy_token_id: "wk", proxy_token_secret: "ws" } };
    expect((await w.app.handle(request("POST", "/build-callback", { ...report, nonce: "wrong" }))).status).toBe(403);
    expect((await w.app.handle(request("POST", "/build-callback", report))).status).toBe(200);
    const state = (await api(w, "GET", "/state", cookie))[1];
    expect(state.modal_deploy).toBeNull();
    expect(state.gpus.find((g: any) => g.kind === "modal")).toBeTruthy();
  });

  it("a Sandbox that ends without its report shows as Modal's error", async () => {
    const { w, cookie } = await connected();
    await api(w, "POST", "/setup/modal", cookie);
    w.modal.sandboxDone = true;
    w.modal.sandboxExit = 1;
    expect((await api(w, "GET", "/setup/modal/log", cookie))[1]).toMatchObject({ done: true });
    const state = (await api(w, "GET", "/state", cookie))[1];
    expect(state.modal_deploy).toBeNull();
    expect(state.modal_error).toContain("exit 1");
  });

  it("an update redeploys Modal with the new release; the storage check doesn't", async () => {
    const { w, cookie } = await connected();
    await api(w, "POST", "/setup/modal", cookie);
    const nonce = (await w.app.store.setup()).build_nonce;
    await w.app.handle(request("POST", "/build-callback", { nonce, stage: "modal", modal_result: "deployed", modal: { server_url: COMFY, admin_url: ADMIN, proxy_token_id: "wk", proxy_token_secret: "ws" } }));
    await api(w, "POST", "/setup/storage", cookie);
    expect(w.modal.sandboxes).toHaveLength(1);
    expect(await api(w, "POST", "/update", cookie)).toEqual([200, { latest: "v1.1.0", build: null }]);
    expect(w.modal.sandboxes).toHaveLength(2);
    expect(w.modal.sandboxes[1].definition.entrypoint_args[2]).toContain("--version 'v1.1.0'");
    expect((await w.app.store.setup()).build_nonce).not.toBe(nonce); // a fresh one per deploy
  });

  it("a failed start of Modal's update doesn't fail the Worker's", async () => {
    const { w, cookie } = await connected();
    await api(w, "POST", "/setup/modal", cookie);
    const nonce = (await w.app.store.setup()).build_nonce;
    await w.app.handle(request("POST", "/build-callback", { nonce, stage: "modal", modal_result: "deployed", modal: { server_url: COMFY, admin_url: ADMIN, proxy_token_id: "wk", proxy_token_secret: "ws" } }));
    w.modal.imageBuilt = false;
    w.modal.imageFails = true;
    expect(await w.app.scheduled()).toBe("updating v1.0.0 -> v1.1.0: done");
    expect((await w.app.store.setup()).modal_error).toContain("Updating Modal to v1.1.0 didn't start");
  });

  it("a Worker made from a repository keeps its build", async () => {
    const w = world();
    const resp = await w.app.handle(request("POST", "/api/login", { token: TOKEN }));
    const cookie = { cookie: resp.headers.get("set-cookie")!.split(";")[0] };
    expect((await w.app.handle(request("POST", "/api/modal/connect", undefined, cookie))).status).toBe(409);
  });
});

describe("moving an install made from a repository", () => {
  /** A Worker on the build path, logged in with a Cloudflare token (which found its build trigger). */
  async function legacy() {
    const w = world();
    w.env.SETUP_MODE = "both";
    const resp = await w.app.handle(request("POST", "/api/login", { token: TOKEN }));
    const cookie = { cookie: resp.headers.get("set-cookie")!.split(";")[0] };
    return { ...w, cookie };
  }
  /** What the setup Worker's upload of the latest release brings: the new setup's vars. */
  const uploaded = (env: Record<string, string | undefined>) => Object.assign(env, { CF_OAUTH_CLIENT: "cid", COMFY_GEN_SETUP: "https://setup.example" });

  it("Move signs in on the setup site; the claim deletes the build trigger and forgets the token", async () => {
    const w = await legacy();
    const { url } = await body(await w.app.handle(request("POST", "/api/cloudflare/move", undefined, w.cookie)));
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://comfy-setup.lugia19.com/move");
    expect(u.searchParams.get("worker")).toBe(`https://${HOST}`);
    expect((await w.app.store.setup()).mode).toBe("both"); // kept: the template's var goes with the old version
    uploaded(w.env);
    expect((await w.app.handle(request("POST", "/api/claim", { reconnect: u.searchParams.get("code"), tokens: tokens(1), account_id: "other" }))).status).toBe(403);
    const r = await w.app.handle(request("POST", "/api/claim", { reconnect: u.searchParams.get("code"), tokens: tokens(1), account_id: "acct1" }));
    expect(r.status).toBe(200);
    expect(w.net.triggersDeleted).toEqual(["trig1"]);
    const s = await w.app.store.secrets();
    expect([s.cf_token, s.cf_trigger, Boolean(s.cf_claimed), s.cf_script]).toEqual([undefined, undefined, true, "comfy-gen"]);
    const state = await body(await w.app.handle(request("GET", "/api/state", undefined, w.cookie)));
    expect(state).toMatchObject({ update_path: "oauth", move_note: expect.stringContaining("delete that repository"), modal_connected: false, setup_mode: "both" });
    expect((await w.app.handle(request("POST", "/api/cloudflare/move", undefined, w.cookie))).status).toBe(409); // done
  });

  it("a trigger Cloudflare won't delete leaves a note, and the move still completes", async () => {
    const w = await legacy();
    w.net.refuseTriggerDelete = true;
    const { url } = await body(await w.app.handle(request("POST", "/api/cloudflare/move", undefined, w.cookie)));
    uploaded(w.env);
    const code = new URL(url).searchParams.get("code");
    expect((await w.app.handle(request("POST", "/api/claim", { reconnect: code, tokens: tokens(1), account_id: "acct1" }))).status).toBe(200);
    const state = await body(await w.app.handle(request("GET", "/api/state", undefined, w.cookie)));
    expect(state.update_path).toBe("oauth");
    expect(state.move_note).toContain("Disconnect it yourself");
  });

  it("a Worker made by the setup site reconnects instead, and can't move", async () => {
    const w = created();
    const cookie = await claimed(w);
    expect((await w.app.handle(request("POST", "/api/cloudflare/move", undefined, cookie))).status).toBe(409);
    const legacyW = await legacy();
    expect((await legacyW.app.handle(request("POST", "/api/cloudflare/reconnect", undefined, legacyW.cookie))).status).toBe(409);
  });
});
