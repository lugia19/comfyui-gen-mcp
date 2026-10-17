import { describe, expect, it } from "vitest";
import { cfapi } from "../src/index.ts";

const M: cfapi.WorkerManifest = {
  version: "v9.9.9",
  module: { name: "index.js", sha256: "x", size: 3 },
  compatibility_date: "2026-09-26",
  compatibility_flags: [],
  durable_objects: [{ name: "STATE", class_name: "State" }, { name: "RELAY", class_name: "Relay" }],
  migrations: [{ tag: "v1", new_sqlite_classes: ["Relay"] }, { tag: "v2", new_sqlite_classes: ["State"] }],
  r2_binding: "STORE",
  assets: { binding: "ASSETS", config: { not_found_handling: "single-page-application" }, files: { "/index.html": { hash: "h1", size: 5 }, "/a.js": { hash: "h2", size: 9 } } },
  crons: ["17 4 * * *"],
};

type Call = { method: string; url: string; auth: string | null; body: any };
/** A fake api.cloudflare.com: *answer(call)* gives [status, envelope-or-raw]. */
function fakeApi(answer: (c: Call) => [number, unknown]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const c: Call = { method: init?.method ?? "GET", url, auth: headers.get("authorization"), body: init?.body };
    calls.push(c);
    const [status, json] = answer(c);
    return new Response(JSON.stringify(json), { status });
  };
  return { fetch, calls };
}
const ok = (result: unknown): [number, unknown] => [200, { success: true, result, errors: [] }];
const fail = (code: number, message = "nope"): [number, unknown] => [400, { success: false, errors: [{ code, message }] }];

describe("the Worker version's metadata (what wrangler builds from wrangler.jsonc)", () => {
  it("a new script gets every migration and its bindings; secrets set now, existing ones kept", () => {
    const meta: any = cfapi.versionMetadata(M, { bucket: "w-storage", vars: { VERSION: "v9.9.9" }, secrets: { CLAIM: "c" }, assetsJwt: "J" });
    expect(meta.migrations).toEqual({ new_tag: "v2", steps: [{ new_sqlite_classes: ["Relay"] }, { new_sqlite_classes: ["State"] }] });
    expect(meta.bindings).toEqual(expect.arrayContaining([
      { type: "durable_object_namespace", name: "STATE", class_name: "State" },
      { type: "assets", name: "ASSETS" },
      { type: "plain_text", name: "VERSION", text: "v9.9.9" },
      { type: "secret_text", name: "CLAIM", text: "c" },
      { type: "r2_bucket", name: "STORE", bucket_name: "w-storage" },
    ]));
    expect(meta.keep_bindings).toEqual(["secret_text"]);
    expect(meta.assets).toEqual({ jwt: "J", config: M.assets.config });
  });

  it("an update sends only the migrations after its tag; without a bucket there's no R2 binding", () => {
    const at = (fromTag: string | null) => (cfapi.versionMetadata(M, { bucket: null, vars: {}, assetsJwt: "J", fromTag }) as any).migrations;
    expect(at("v2")).toEqual({ old_tag: "v2", new_tag: "v2", steps: [] });
    expect(at("v1")).toEqual({ old_tag: "v1", new_tag: "v2", steps: [{ new_sqlite_classes: ["State"] }] });
    expect((cfapi.versionMetadata(M, { bucket: null, vars: {}, assetsJwt: "J" }) as any).bindings.some((b: any) => b.type === "r2_bucket")).toBe(false);
  });
});

describe("API calls", () => {
  it("R2: created, already there, or off (no card yet: error 10042)", async () => {
    for (const [answer, want] of [[ok({}), "created"], [fail(10004), "exists"], [fail(10042), "off"]] as const) {
      const api = fakeApi(() => answer);
      expect(await cfapi.createBucket(api.fetch, "T", "acc", "b")).toBe(want);
    }
    const api = fakeApi(() => fail(10001, "something else"));
    await expect(cfapi.createBucket(api.fetch, "T", "acc", "b")).rejects.toThrow("10001: something else");
  });

  it("uploads only the assets Cloudflare asks for, each batch with the session's token", async () => {
    const api = fakeApi((c) =>
      c.url.endsWith("/assets-upload-session") ? ok({ jwt: "S", buckets: [["h2"]] }) : ok({ jwt: "DONE" }),
    );
    const asked: string[][] = [];
    const r = await cfapi.uploadAssets(api.fetch, "T", "acc", "w", M, async (hashes) => (asked.push(hashes), { h2: "Ym9keQ==" }));
    expect(r).toEqual({ jwt: "DONE", uploaded: 1 });
    expect(asked).toEqual([["h2"]]);
    expect(api.calls[0].auth).toBe("Bearer T");
    expect(JSON.parse(api.calls[0].body).manifest).toEqual(M.assets.files);
    expect(api.calls[1].auth).toBe("Bearer S"); // the session token, not the user's
    expect(api.calls[1].url).toContain("/workers/assets/upload?base64=true");
    expect((api.calls[1].body as FormData).get("h2")).toBeInstanceOf(Blob);
  });

  it("nothing new to upload: the session's own token completes it", async () => {
    const api = fakeApi(() => ok({ jwt: "S", buckets: [] }));
    expect(await cfapi.uploadAssets(api.fetch, "T", "acc", "w", M, async () => ({}))).toEqual({ jwt: "S", uploaded: 0 });
  });

  it("the script goes up as multipart: metadata and the module", async () => {
    const api = fakeApi(() => ok({}));
    await cfapi.uploadScript(api.fetch, "T", "acc", "w", M, new TextEncoder().encode("x=1"), { bucket: null, vars: { VERSION: "v1" }, assetsJwt: "J", fromTag: "v2" });
    const form = api.calls[0].body as FormData;
    expect(api.calls[0]).toMatchObject({ method: "PUT", url: `${cfapi.CF_API}/accounts/acc/workers/scripts/w` });
    expect(JSON.parse(await (form.get("metadata") as Blob).text()).migrations.old_tag).toBe("v2");
    expect(await (form.get("index.js") as Blob).text()).toBe("x=1");
  });

  it("OAuth: a refused refresh says why (invalid_grant: connect again)", async () => {
    const fetch = async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "expired" }), { status: 400 });
    const e = await cfapi.refreshTokens(fetch, "cid", "old").catch((e) => e);
    expect(e).toBeInstanceOf(cfapi.OAuthError);
    expect(e.error).toBe("invalid_grant");
    const good = async () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r2", expires_in: 3600 }));
    expect(await cfapi.refreshTokens(good, "cid", "old")).toMatchObject({ refresh_token: "r2" });
  });

  it("PKCE: the challenge is the verifier's SHA-256, base64url", async () => {
    const { verifier, challenge } = await cfapi.pkcePair();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    const want = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    expect(challenge).toBe(want);
    const url = new URL(cfapi.authorizeUrl("cid", "https://x/cb", "st", challenge));
    expect(url.searchParams.get("scope")).toBe("workers-scripts.write workers-r2.write account-settings.read offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
