import { describe, expect, it } from "vitest";
import { cfapi } from "@comfy-gen/core";
import { handle, open, seal, type Env } from "../src/setup.ts";

const ORIGIN = "https://setup.example";
const DEV = `${ORIGIN}/dev`;
const env: Env = { CF_OAUTH_CLIENT: "cid", COOKIE_KEY: "ab".repeat(32), COMFY_GEN_RELEASES: DEV };
const MODULE = new TextEncoder().encode("export default {}");

/** Cloudflare (OAuth and the API), the dev release base and the new Worker's /api/claim, faked. */
class Fake {
  now = 1000;
  r2 = true;
  subdomain: string | null = "someone";
  scripts: Record<string, string | null> = { "other-worker": "v2" };
  exchanged: Record<string, string>[] = [];
  puts: { script: string; meta: any }[] = [];
  buckets: string[] = [];
  crons: any[] = [];
  enabled: string[] = [];
  registered: string[] = [];
  claims: { url: string; body: any }[] = [];
  notYet = 2; // the new address answers 404 this many times first
  slept = 0;

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const ok = (result: unknown) => Response.json({ success: true, result, errors: [] });
    const fail = (code: number, message: string, status = 400) => Response.json({ success: false, errors: [{ code, message }] }, { status });
    if (url === cfapi.CF_OAUTH_TOKEN) {
      this.exchanged.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 });
    }
    if (url === `${DEV}/latest.txt`) return new Response("v2.0.0\n");
    if (url === `${DEV}/v2.0.0/worker-manifest.json`) return Response.json(await manifest());
    if (url === `${DEV}/v2.0.0/worker-bundle.js`) return new Response(MODULE as BodyInit);
    if (url === `${DEV}/v2.0.0/worker-assets.json`) return Response.json({ h1: "aGkK" });
    if (url.endsWith("/api/claim")) {
      if (this.notYet-- > 0) return new Response("nothing here yet", { status: 404 });
      const body = JSON.parse(String(init.body));
      this.claims.push({ url, body });
      return body.claim === "wrong" ? Response.json({ error: "no" }, { status: 403 }) : Response.json({ ticket: "TICKET" });
    }
    if (!url.startsWith(cfapi.CF_API)) return new Response(null, { status: 404 });
    if (new Headers(init.headers).get("authorization") !== "Bearer AT" && !url.includes("/assets/upload")) return fail(10000, "Authentication error", 403);
    const path = url.slice(cfapi.CF_API.length);
    if (path.startsWith("/accounts?")) return ok([{ id: "acct1", name: "Someone's Account" }]);
    if (path === "/accounts/acct1/workers/subdomain" && method === "GET") return this.subdomain ? ok({ subdomain: this.subdomain }) : fail(10007, "workers.api.error.not_found", 404);
    if (path === "/accounts/acct1/workers/subdomain" && method === "PUT") {
      this.subdomain = JSON.parse(String(init.body)).subdomain;
      this.registered.push(this.subdomain!);
      return ok({ subdomain: this.subdomain });
    }
    if (path === "/accounts/acct1/workers/scripts" && method === "GET") return ok(Object.entries(this.scripts).map(([id, migration_tag]) => ({ id, migration_tag })));
    if (path === "/accounts/acct1/r2/buckets") {
      if (!this.r2) return fail(10042, "Please enable R2 through the Cloudflare Dashboard.", 403);
      this.buckets.push(JSON.parse(String(init.body)).name);
      return ok({});
    }
    if (path.endsWith("/lifecycle")) return ok({});
    if (path.endsWith("/assets-upload-session")) return ok({ jwt: "S", buckets: [["h1"]] });
    if (path.includes("/workers/assets/upload")) return ok({ jwt: "DONE" });
    let m = /^\/accounts\/acct1\/workers\/scripts\/([\w-]+)$/.exec(path);
    if (m && method === "PUT") {
      this.puts.push({ script: m[1], meta: JSON.parse(await ((init.body as FormData).get("metadata") as Blob).text()) });
      this.scripts[m[1]] = "v2";
      return ok({});
    }
    m = /^\/accounts\/acct1\/workers\/scripts\/([\w-]+)\/(schedules|subdomain)$/.exec(path);
    if (m?.[2] === "schedules") return (this.crons.push(JSON.parse(String(init.body))), ok({}));
    if (m?.[2] === "subdomain") return (this.enabled.push(m[1]), ok({}));
    return fail(7003, `unexpected ${method} ${path}`, 404);
  };

  deps = { fetch: this.fetch, now: () => this.now, sleep: async (s: number) => void (this.slept += s) };
  call = (method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) =>
    handle(new Request(ORIGIN + path, {
      method, headers: opts.cookie ? { cookie: opts.cookie } : {}, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }), env, this.deps);
}

async function manifest(): Promise<cfapi.WorkerManifest> {
  return {
    version: "v2.0.0", module: { name: "index.js", sha256: await cfapi.sha256Hex(MODULE), size: MODULE.length },
    compatibility_date: "2026-09-26", compatibility_flags: [],
    durable_objects: [{ name: "STATE", class_name: "State" }], migrations: [{ tag: "v1", new_sqlite_classes: ["State"] }],
    r2_binding: "STORE", assets: { binding: "ASSETS", config: {}, files: { "/index.html": { hash: "h1", size: 3 } } }, crons: ["17 4 * * *"],
  };
}

const cookies = (resp: Response) => resp.headers.getSetCookie();
const cookieValue = (resp: Response, name: string) => cookies(resp).find((c) => c.startsWith(name + "="))!.split(";")[0];

/** Through the sign-in: start, Cloudflare's redirect back. The tokens cookie, and the start's redirect. */
async function signIn(f: Fake, start = "/oauth/start") {
  const s = await f.call("GET", start);
  const to = new URL(s.headers.get("location")!);
  const back = await f.call("GET", `/oauth/callback?code=CODE&state=${to.searchParams.get("state")}`, { cookie: cookieValue(s, "cg_oauth") });
  return { start: s, to, back };
}

describe("sealed cookies", () => {
  it("open what was sealed until it expires; anything else is nothing", async () => {
    const s = await seal(env, { a: 1 }, 2000);
    expect(await open(env, s, 1999)).toEqual({ a: 1 });
    expect(await open(env, s, 2000)).toBeNull();
    expect(await open(env, s.slice(0, -2) + (s.endsWith("AA") ? "BB" : "AA"), 1000)).toBeNull();
    expect(await open({ ...env, COOKIE_KEY: "cd".repeat(32) }, s, 1000)).toBeNull();
    expect(await open(env, null, 1000)).toBeNull();
  });
});

describe("signing in", () => {
  it("PKCE: the verifier waits in a sealed cookie; the callback checks the state and exchanges the code", async () => {
    const f = new Fake();
    const { start, to, back } = await signIn(f);
    expect(to.origin + to.pathname).toBe(cfapi.CF_OAUTH_AUTHORIZE);
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/callback`);
    expect(cookies(start)[0]).toMatch(/^cg_oauth=[\w-]+; Path=\/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    const verifier = f.exchanged[0].code_verifier;
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    expect(challenge).toBe(to.searchParams.get("code_challenge"));
    expect(f.exchanged[0]).toMatchObject({ grant_type: "authorization_code", code: "CODE", client_id: "cid" });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/#connected");
    expect(cookies(back).some((c) => c.startsWith("cg_tokens=") && c.includes("Path=/api"))).toBe(true);
  });

  it("refuses a callback with the wrong state, without the cookie, or after ten minutes", async () => {
    const f = new Fake();
    const s = await f.call("GET", "/oauth/start");
    const state = new URL(s.headers.get("location")!).searchParams.get("state");
    const pending = cookieValue(s, "cg_oauth");
    expect((await f.call("GET", "/oauth/callback?code=C&state=nope", { cookie: pending })).status).toBe(400);
    expect((await f.call("GET", `/oauth/callback?code=C&state=${state}`)).status).toBe(400);
    f.now += 601;
    expect((await f.call("GET", `/oauth/callback?code=C&state=${state}`, { cookie: pending })).status).toBe(400);
    expect(f.exchanged).toEqual([]);
    const denied = await f.call("GET", "/oauth/callback?error=access_denied");
    expect(await denied.text()).toContain("chose not to allow access");
  });

  it("lists the accounts the sign-in reaches, with their workers.dev subdomains", async () => {
    const f = new Fake();
    expect((await f.call("GET", "/api/accounts")).status).toBe(401);
    const { back } = await signIn(f);
    const r = await f.call("GET", "/api/accounts", { cookie: cookieValue(back, "cg_tokens") });
    expect(await r.json()).toEqual({ accounts: [{ id: "acct1", name: "Someone's Account", subdomain: "someone" }] });
  });
});

describe("creating the Worker", () => {
  const create = async (f: Fake, body: Record<string, unknown>) => {
    const { back } = await signIn(f);
    return f.call("POST", "/api/create", { cookie: cookieValue(back, "cg_tokens"), body: { account_id: "acct1", name: "comfy-gen", mode: "cloud", ...body } });
  };

  it("bucket, the latest release with a one-time claim, cron, workers.dev; then the hand-off", async () => {
    const f = new Fake();
    const r = await create(f, {});
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: "https://comfy-gen.someone.workers.dev", ticket: "TICKET", version: "v2.0.0", storage: true });
    expect(cookies(r)[0]).toMatch(/^cg_tokens=; Path=\/api; Max-Age=0/); // the tokens are the Worker's now
    expect(f.buckets).toEqual(["comfy-gen-storage"]);
    const meta = f.puts[0].meta;
    expect(f.puts[0].script).toBe("comfy-gen");
    const claim = meta.bindings.find((b: any) => b.name === "CLAIM");
    expect(claim.type).toBe("secret_text");
    expect(meta.bindings).toEqual(expect.arrayContaining([
      { type: "plain_text", name: "VERSION", text: "v2.0.0" },
      { type: "plain_text", name: "SETUP_MODE", text: "cloud" },
      { type: "plain_text", name: "CF_OAUTH_CLIENT", text: "cid" },
      { type: "plain_text", name: "COMFY_GEN_SETUP", text: ORIGIN },
      { type: "plain_text", name: "COMFY_GEN_RELEASES", text: DEV },
      { type: "r2_bucket", name: "STORE", bucket_name: "comfy-gen-storage" },
    ]));
    expect(meta.migrations).toEqual({ new_tag: "v1", steps: [{ new_sqlite_classes: ["State"] }] });
    expect(f.crons).toEqual([[{ cron: "17 4 * * *" }]]);
    expect(f.enabled).toEqual(["comfy-gen"]);
    // The new address 404s at first: waited for, then the claim with the same secret.
    expect(f.slept).toBe(4);
    expect(f.claims).toEqual([{ url: "https://comfy-gen.someone.workers.dev/api/claim", body: {
      claim: claim.text, tokens: { access_token: "AT", refresh_token: "RT", expires_in: 3600 }, account_id: "acct1", script: "comfy-gen",
    } }]);
  });

  it("R2 off: no bucket binding (the Worker's storage step adds it later)", async () => {
    const f = new Fake();
    f.r2 = false;
    expect(await (await create(f, {})).json()).toMatchObject({ storage: false });
    expect(f.puts[0].meta.bindings.some((b: any) => b.type === "r2_bucket")).toBe(false);
  });

  it("an account without a workers.dev subdomain gets the one chosen", async () => {
    const f = new Fake();
    f.subdomain = null;
    expect((await create(f, {})).status).toBe(400);
    expect(f.puts).toEqual([]);
    expect(await (await create(f, { subdomain: "mine" })).json()).toMatchObject({ url: "https://comfy-gen.mine.workers.dev" });
    expect(f.registered).toEqual(["mine"]);
  });

  it("refuses a taken name, a bad name, another account, and creating without signing in", async () => {
    const f = new Fake();
    const taken = await create(f, { name: "other-worker" });
    expect(taken.status).toBe(409);
    expect((await create(f, { name: "-Bad" })).status).toBe(400);
    expect((await create(f, { account_id: "acct2" })).status).toBe(400);
    expect((await create(f, { mode: "nope" })).status).toBe(400);
    expect((await f.call("POST", "/api/create", { body: { account_id: "acct1", name: "x", mode: "cloud" } })).status).toBe(401);
    expect(f.puts).toEqual([]);
  });
});

describe("reconnecting a Worker", () => {
  it("hands new tokens to a Worker in the signed-in account, which answers a login ticket", async () => {
    const f = new Fake();
    f.notYet = 0;
    const { back } = await signIn(f, "/reconnect?worker=https%3A%2F%2Fother-worker.someone.workers.dev&code=CODE1");
    expect(back.headers.get("location")).toBe("https://other-worker.someone.workers.dev#ticket=TICKET");
    expect(f.claims[0].body).toEqual({ reconnect: "CODE1", tokens: { access_token: "AT", refresh_token: "RT", expires_in: 3600 }, account_id: "acct1" });
  });

  it("refuses a Worker outside the account, or an address that isn't a workers.dev Worker", async () => {
    const f = new Fake();
    f.notYet = 0;
    const { back } = await signIn(f, "/reconnect?worker=https%3A%2F%2Fcomfy-gen.someone-else.workers.dev&code=C");
    expect(back.status).toBe(400);
    expect(await back.text()).toContain("isn't a Worker in the Cloudflare account");
    expect((await signIn(f, "/reconnect?worker=https%3A%2F%2Fnot-in-account.someone.workers.dev&code=C")).back.status).toBe(400);
    expect((await f.call("GET", "/reconnect?worker=https%3A%2F%2Fevil.example&code=C")).status).toBe(400);
    expect(f.claims).toEqual([]);
  });
});
