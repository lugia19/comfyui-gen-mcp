// A fake Cloudflare for the setup Worker's and the Worker's tests: the OAuth token endpoint, the API
// calls core cfapi.ts makes, and a development release base (core releases.ts) serving one bundle
// under any tag.

import { cfapi, sha256Hex } from "../src/index.ts";

export const tokens = (n: number) => ({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 3600 });

export class FakeCloudflare {
  readonly base: string; // the release base
  latest = "v2.0.0";
  module = new TextEncoder().encode("export default {}");
  badHash = false;
  // OAuth: the last pair handed out is tokens(issued); a refresh needs its refresh token.
  issued = 1;
  refuse = false; // the grant was revoked
  exchanged: Record<string, string>[] = [];
  refreshes: string[] = [];
  /** Bearer tokens the API takes besides the current access token (an API token's login). */
  apiTokens = new Set<string>();
  r2 = true;
  subdomain: string | null = "someone";
  registered: string[] = [];
  scripts: Record<string, string | null> = {}; // name: migration tag
  known = new Set<string>(); // asset hashes Cloudflare already has
  assetBatches: string[][] = [];
  uploads: { script: string; meta: any }[] = [];
  buckets: string[] = []; // created
  lifecycles: string[] = [];
  crons: unknown[] = [];
  enabled: string[] = [];

  constructor(base: string) {
    this.base = base;
  }

  async manifest(): Promise<cfapi.WorkerManifest> {
    return {
      version: this.latest,
      module: { name: "index.js", sha256: this.badHash ? "0".repeat(64) : await sha256Hex(this.module), size: this.module.length },
      compatibility_date: "2026-09-26", compatibility_flags: [],
      durable_objects: [{ name: "STATE", class_name: "State" }, { name: "RELAY", class_name: "Relay" }],
      migrations: [{ tag: "v1", new_sqlite_classes: ["Relay"] }, { tag: "v2", new_sqlite_classes: ["State"] }],
      r2_binding: "STORE",
      assets: { binding: "ASSETS", config: {}, files: { "/index.html": { hash: "h1", size: 3 }, "/app.js": { hash: "h2", size: 3 } } },
      crons: ["17 4 * * *"],
    };
  }

  /** Its answer to *url*, or null when the URL isn't Cloudflare's or the release base's. */
  handle = async (url: string, init: RequestInit = {}): Promise<Response | null> => {
    const method = init.method ?? "GET";
    const ok = (result: unknown) => Response.json({ success: true, result, errors: [] });
    const fail = (code: number, message: string, status = 400) => Response.json({ success: false, errors: [{ code, message }] }, { status });

    if (url === cfapi.CF_OAUTH_TOKEN) {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      if (form.grant_type === "authorization_code") return (this.exchanged.push(form), Response.json(tokens(this.issued)));
      this.refreshes.push(form.refresh_token);
      if (this.refuse || form.refresh_token !== `r${this.issued}`) return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
      return Response.json(tokens(++this.issued));
    }
    if (url === `${this.base}/latest.txt`) return new Response(this.latest + "\n");
    if (url.startsWith(`${this.base}/`)) {
      const file = url.split("/").at(-1);
      if (file === "worker-manifest.json") return Response.json(await this.manifest());
      if (file === "worker-bundle.js") return new Response(this.module as BodyInit);
      if (file === "worker-assets.json") return Response.json({ h1: "aGkK", h2: "eD0x" });
      return new Response(null, { status: 404 });
    }
    if (!url.startsWith(cfapi.CF_API)) return null;

    const path = url.slice(cfapi.CF_API.length);
    if (path.includes("/workers/assets/upload")) { // with the upload session's token
      const hashes = [...(init.body as FormData).keys()];
      hashes.forEach((h) => this.known.add(h));
      this.assetBatches.push(hashes);
      return ok({ jwt: "DONE" });
    }
    const auth = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (auth !== `a${this.issued}` && !this.apiTokens.has(auth)) return fail(10000, "Authentication error", 403);
    if (path.startsWith("/accounts?")) return ok([{ id: "acct1", name: "Someone's Account" }]);
    if (path === "/accounts/acct1/workers/subdomain" && method === "GET") return this.subdomain ? ok({ subdomain: this.subdomain }) : fail(10007, "workers.api.error.not_found", 404);
    if (path === "/accounts/acct1/workers/subdomain" && method === "PUT") {
      this.subdomain = JSON.parse(String(init.body)).subdomain;
      this.registered.push(this.subdomain!);
      return ok({ subdomain: this.subdomain });
    }
    if (path === "/accounts/acct1/workers/scripts" && method === "GET") return ok(Object.entries(this.scripts).map(([id, migration_tag]) => ({ id, migration_tag })));
    if (path === "/accounts/acct1/r2/buckets" && method === "POST") {
      if (!this.r2) return fail(10042, "Please enable R2 through the Cloudflare Dashboard.", 403);
      const name = JSON.parse(String(init.body)).name;
      if (this.buckets.includes(name)) return fail(10004, "The bucket you tried to create already exists.", 409);
      this.buckets.push(name);
      return ok({});
    }
    let m = /^\/accounts\/acct1\/r2\/buckets\/([\w-]+)\/lifecycle$/.exec(path);
    if (m) return (this.lifecycles.push(m[1]), ok({}));
    if (path.endsWith("/assets-upload-session")) {
      const files = Object.values(JSON.parse(String(init.body)).manifest as Record<string, { hash: string }>);
      const wanted = files.map((f) => f.hash).filter((h) => !this.known.has(h));
      return ok({ jwt: "S", buckets: wanted.length ? [wanted] : [] });
    }
    m = /^\/accounts\/acct1\/workers\/scripts\/([\w-]+)$/.exec(path);
    if (m && method === "PUT") {
      this.uploads.push({ script: m[1], meta: JSON.parse(await ((init.body as FormData).get("metadata") as Blob).text()) });
      this.scripts[m[1]] = "v2";
      return ok({});
    }
    m = /^\/accounts\/acct1\/workers\/scripts\/([\w-]+)\/(schedules|subdomain)$/.exec(path);
    if (m?.[2] === "schedules") return (this.crons.push(JSON.parse(String(init.body))), ok({}));
    if (m?.[2] === "subdomain") return (this.enabled.push(m[1]), ok({}));
    return null; // not faked here
  };
}
