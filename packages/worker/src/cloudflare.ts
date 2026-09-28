// Cloudflare API calls the Worker makes about itself: token checks, self-discovery, Workers Builds.
//
// A Worker has no runtime API for its own account or name. The name comes from its workers.dev
// hostname (<name>.<subdomain>.workers.dev), the account from listing what the user's token can
// see (S4). The Builds API accepts only user tokens (design §8).

import type { Fetch } from "./platform.ts";

const API = "https://api.cloudflare.com/client/v4";

/** A Cloudflare API call failed. The message is meant for the setup page. */
export class CloudflareError extends Error {
  name = "CloudflareError";
}

export async function call(fetch: Fetch, token: string, method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let payload: any;
  try {
    payload = await resp.json();
  } catch {
    throw new CloudflareError(`${method} ${path}: HTTP ${resp.status}`);
  }
  if (!payload?.success) {
    const errors = (payload?.errors ?? []).map((e: any) => `${e.code}: ${e.message}`).join("; ");
    throw new CloudflareError(`${method} ${path}: ${errors || `HTTP ${resp.status}`}`);
  }
  return payload.result;
}

/** Throws CloudflareError with advice if the token isn't an active user token. */
export async function verifyUserToken(fetch: Fetch, token: string): Promise<void> {
  let result: any;
  try {
    result = await call(fetch, token, "GET", "/user/tokens/verify");
  } catch (e) {
    throw new CloudflareError(
      "That token was not accepted as a user API token. The Builds API needs a token created under " +
        "My Profile > API Tokens (not the account's API Tokens page). Use the link on this page. " +
        `(${(e as Error).message})`,
    );
  }
  if (result?.status !== "active") throw new CloudflareError("That token is not active.");
}

export type Discovery = { account_id: string; script: string; tag: string; trigger: string; branch: string };

/** Account, script, tag, build trigger and branch for the Worker serving *host*. */
export async function discover(fetch: Fetch, token: string, host: string): Promise<Discovery> {
  if (!host.endsWith(".workers.dev")) {
    throw new CloudflareError(`Open this page on the workers.dev address to finish setup (not ${host}).`);
  }
  const script = host.split(".")[0];
  const accounts = (await call(fetch, token, "GET", "/accounts?per_page=50")) ?? [];
  for (const acct of accounts) {
    const found = (await call(fetch, token, "GET", `/accounts/${acct.id}/workers/scripts-search?name=${encodeURIComponent(script)}`)) ?? [];
    const match = found.find((s: any) => s.script_name === script);
    if (!match) continue;
    const triggers = (await call(fetch, token, "GET", `/accounts/${acct.id}/builds/workers/${match.id}/triggers`)) ?? [];
    if (!triggers.length) throw new CloudflareError("This Worker is not connected to a Git repository, so it cannot update itself.");
    const trig = triggers[0];
    return { account_id: acct.id, script, tag: match.id, trigger: trig.trigger_uuid, branch: (trig.branch_includes ?? ["main"])[0] };
  }
  throw new CloudflareError(`The token cannot see a Worker named ${script}. Make sure it was created for the account this Worker lives in.`);
}

export async function setBuildVars(
  fetch: Fetch, token: string, accountId: string, trigger: string,
  secret: Record<string, unknown>, plain: Record<string, unknown>,
): Promise<void> {
  const body: Record<string, { value: unknown; is_secret: boolean }> = {};
  for (const [k, v] of Object.entries(secret)) if (v) body[k] = { value: v, is_secret: true };
  for (const [k, v] of Object.entries(plain)) if (v) body[k] = { value: v, is_secret: false };
  await call(fetch, token, "PATCH", `/accounts/${accountId}/builds/triggers/${trigger}/environment_variables`, body);
}

export async function startBuild(fetch: Fetch, token: string, accountId: string, trigger: string, branch: string): Promise<string> {
  const result = await call(fetch, token, "POST", `/accounts/${accountId}/builds/triggers/${trigger}/builds`, { branch });
  return result.build_uuid;
}

export async function buildStatus(fetch: Fetch, token: string, accountId: string, build: string) {
  const r = await call(fetch, token, "GET", `/accounts/${accountId}/builds/builds/${build}`);
  return { status: r?.status, outcome: r?.build_outcome };
}

export async function buildLogs(fetch: Fetch, token: string, accountId: string, build: string, cursor: string | null) {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const r = (await call(fetch, token, "GET", `/accounts/${accountId}/builds/builds/${build}/logs${q}`)) ?? {};
  return { lines: (r.lines ?? []).map((l: [unknown, string]) => l[1]), cursor: r.cursor || cursor };
}
