"""Spike S4, worker side: with a pasted user API token, find this Worker's own Builds trigger, write
build variables, start a build, and follow its logs. The token is never stored.

Needs a user-scoped token with Workers Builds Configuration: Edit and Workers Scripts: Read
(account-scoped tokens are rejected by the Builds API).
"""

import json
import secrets
import time
from urllib.parse import quote

from workers import fetch

API = "https://api.cloudflare.com/client/v4"


class CFError(Exception):
    pass


async def cf(token: str, method: str, path: str, body=None) -> object:
    headers = {"Authorization": f"Bearer {token}"}
    kw = {"method": method, "headers": headers}
    if body is not None:
        headers["Content-Type"] = "application/json"
        kw["body"] = json.dumps(body)
    resp = await fetch(API + path, **kw)
    data = await resp.json()
    if not data.get("success", False):
        raise CFError(f"{method} {path}: HTTP {resp.status} {json.dumps(data.get('errors'))[:500]}")
    return data.get("result")


async def discover(token: str, host: str) -> dict:
    """Account id, script tag and Builds triggers of the Worker serving *host*.

    A Worker has no runtime API for its own account or name, so the name comes from the
    workers.dev hostname (<name>.<subdomain>.workers.dev) and the account from the token.
    """
    if not host.endswith(".workers.dev"):
        raise CFError(f"Can't infer the script name from {host}; use the workers.dev URL")
    name = host.split(".")[0]
    steps = [f"script name from hostname: {name}"]
    accounts = await cf(token, "GET", "/accounts?per_page=50")
    steps.append(f"token sees {len(accounts)} account(s)")
    for acct in accounts:
        found = await cf(token, "GET", f"/accounts/{acct['id']}/workers/scripts-search?name={quote(name)}")
        match = next((s for s in found or [] if s.get("script_name") == name), None)
        if not match:
            continue
        tag = match["id"]
        steps.append(f"found in account {acct['name']} ({acct['id']}), tag {tag}")
        triggers = await cf(token, "GET", f"/accounts/{acct['id']}/builds/workers/{tag}/triggers")
        steps.append(f"{len(triggers)} trigger(s)")
        return {
            "account_id": acct["id"],
            "script": name,
            "tag": tag,
            "triggers": [
                {k: t.get(k) for k in ("trigger_uuid", "trigger_name", "branch_includes", "build_command",
                                       "deploy_command", "root_directory")}
                | {"repo": (t.get("repo_connection") or {}).get("repo_name")}
                for t in triggers
            ],
            "steps": steps,
        }
    raise CFError(f"No script named {name} in the token's accounts. Steps: {steps}")


async def set_vars(token: str, account_id: str, trigger: str, env_kv, host: str, extra: dict) -> dict:
    """Write the callback URL and a fresh nonce (plus any extra vars, e.g. Modal tokens as secrets)."""
    nonce = secrets.token_urlsafe(24)
    await env_kv.put("nonce", nonce, expirationTtl=86400)
    body = {
        "SPIKE_CALLBACK": {"value": f"https://{host}/build-callback", "is_secret": False},
        "SPIKE_NONCE": {"value": nonce, "is_secret": True},
    }
    for key, value in (extra or {}).items():
        if value:
            body[key] = {"value": value, "is_secret": True}
    t = time.monotonic()
    await cf(token, "PATCH", f"/accounts/{account_id}/builds/triggers/{trigger}/environment_variables", body)
    return {"written": sorted(body), "api_s": round(time.monotonic() - t, 2)}


async def start_build(token: str, account_id: str, trigger: str, branch: str) -> dict:
    return await cf(token, "POST", f"/accounts/{account_id}/builds/triggers/{trigger}/builds", {"branch": branch})


async def build_status(token: str, account_id: str, build: str) -> dict:
    return await cf(token, "GET", f"/accounts/{account_id}/builds/builds/{build}")


async def build_logs(token: str, account_id: str, build: str, cursor: str | None) -> dict:
    q = f"?cursor={quote(cursor)}" if cursor else ""
    return await cf(token, "GET", f"/accounts/{account_id}/builds/builds/{build}/logs{q}")


PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Builds spike</title>
<style>
 body{font:14px system-ui,sans-serif;margin:16px;max-width:900px;background:#fff;color:#111}
 input,button,textarea{font:inherit} input{width:100%;box-sizing:border-box;margin:4px 0}
 pre{background:#f3f3f3;padding:8px;overflow:auto;max-height:420px;white-space:pre-wrap}
 fieldset{margin:12px 0}
</style></head><body>
<h1>S4: Workers Builds from inside the Worker</h1>
<p>User API token (Workers Builds Configuration: Edit, Workers Scripts: Read). Not stored.</p>
<input id="tok" type="password" placeholder="Cloudflare user API token">
<fieldset><legend>1. Discover</legend><button onclick="discover()">Find my account, tag, trigger</button></fieldset>
<fieldset><legend>2. Build variables</legend>
 Optional Modal token pair, stored as build secrets so the build can run <code>modal deploy</code>:
 <input id="mid" placeholder="MODAL_TOKEN_ID (ak-...)"><input id="msec" type="password" placeholder="MODAL_TOKEN_SECRET (as-...)">
 <button onclick="setvars()">Write SPIKE_CALLBACK, SPIKE_NONCE (+ Modal)</button></fieldset>
<fieldset><legend>3. Build</legend><button onclick="build()">Start a build</button>
 <button onclick="callbacks()">Show callbacks received</button></fieldset>
<pre id="out"></pre>
<script>
const base = location.pathname.replace(/\\/builds\\/?$/, '') + '/builds/api';
let info = null;
const out = document.getElementById('out');
function log(x){ out.textContent += (typeof x === 'string' ? x : JSON.stringify(x, null, 1)) + '\\n'; out.scrollTop = 1e9; }
async function api(path, body){
  const r = await fetch(base + path, {method: body ? 'POST' : 'GET',
    headers: {'X-CF-Token': document.getElementById('tok').value, 'Content-Type': 'application/json'},
    body: body ? JSON.stringify(body) : undefined});
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
}
async function discover(){ try { info = await api('/discover'); log(info); } catch(e){ log('ERROR ' + e.message); } }
function trig(){ if(!info || !info.triggers.length) throw new Error('discover first (and the Worker must be connected to a repo)'); return info.triggers[0]; }
async function setvars(){ try { log(await api('/vars', {account_id: info.account_id, trigger: trig().trigger_uuid,
  extra: {MODAL_TOKEN_ID: document.getElementById('mid').value, MODAL_TOKEN_SECRET: document.getElementById('msec').value}})); } catch(e){ log('ERROR ' + e.message); } }
async function build(){
  try {
    const t = trig(); const branch = (t.branch_includes && t.branch_includes[0]) || 'main';
    const b = await api('/build', {account_id: info.account_id, trigger: t.trigger_uuid, branch});
    log('build ' + b.build_uuid + ' ' + b.status); const t0 = Date.now(); let cursor = null;
    while (true) {
      await new Promise(r => setTimeout(r, 3000));
      const l = await api('/logs?account_id=' + info.account_id + '&build=' + b.build_uuid + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      for (const [ts, line] of (l.lines || [])) log(line);
      cursor = l.cursor || cursor;
      const s = await api('/status?account_id=' + info.account_id + '&build=' + b.build_uuid);
      if (s.status === 'stopped') { log('== ' + s.build_outcome + ' after ' + Math.round((Date.now()-t0)/1000) + 's'); break; }
    }
  } catch(e){ log('ERROR ' + e.message); }
}
async function callbacks(){ try { log(await api('/callbacks')); } catch(e){ log('ERROR ' + e.message); } }
</script></body></html>
"""
