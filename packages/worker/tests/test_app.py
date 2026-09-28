import base64
import json

import pytest
from conftest import COMFY, TOKEN, request
from fake_comfy import png

from comfy_gen_core import refs
from comfy_gen_core.comfyui import OutputImage
from comfy_gen_worker import updates
from comfy_gen_worker.app import REQUEST_BUDGET
from comfy_gen_worker.http import Request

pytestmark = pytest.mark.anyio


async def secrets_of(app):
    return await app.store.secrets()


async def mcp(app, method, params=None, id=1):
    s = await secrets_of(app)
    msg = {"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}}
    resp = await app.handle(request("POST", f"/mcp/{s['mcp_secret']}", msg))
    return resp.status, json.loads(resp.body) if resp.body else None


async def with_generator(app):
    await app.store.update_secrets(generator={"kind": "url", "base_url": COMFY, "headers": {"X-Test": "1"}})


async def login(app):
    resp = await app.handle(request("POST", "/api/login", {"token": TOKEN}))
    assert resp.status == 200
    return {"cookie": resp.headers["Set-Cookie"].split(";")[0]}


# ── MCP ───────────────────────────────────────────────────────────────

async def test_mcp_needs_the_secret_path_and_post(world):
    app, *_ = world
    assert (await app.handle(request("POST", "/mcp/wrong", {}))).status == 404
    s = await secrets_of(app)
    assert (await app.handle(request("GET", f"/mcp/{s['mcp_secret']}"))).status == 405


async def test_tools_list_is_refs_mode(world):
    app, *_ = world
    _, r = await mcp(app, "tools/list")
    names = [t["name"] for t in r["result"]["tools"]]
    assert "request_upload" in names and "edit_image" in names
    edit = next(t for t in r["result"]["tools"] if t["name"] == "edit_image")
    assert "image" in edit["inputSchema"]["properties"]


async def test_calls_before_setup_explain_what_to_do(world):
    app, *_ = world
    _, r = await mcp(app, "tools/call", {"name": "generate_realistic_image", "arguments": {"prompt": "x"}})
    assert r["result"]["isError"] and "not set up" in r["result"]["content"][0]["text"]
    _, r = await mcp(app, "tools/call", {"name": "no_such_tool"})
    assert r["error"]["code"] == -32602


async def test_generate_returns_inline_webp_and_an_image_id(world, comfy):
    app, _, net, _ = world
    await with_generator(app)
    _, r = await mcp(app, "tools/call", {"name": "generate_realistic_image", "arguments": {"prompt": "a harbor"}})
    image, info = r["result"]["content"]
    assert image["type"] == "image" and image["mimeType"] == "image/webp"
    assert base64.b64decode(image["data"]) == comfy.view_body
    view = next(c for c in comfy.calls if c[1] == "/view")
    assert view[2]["preview"] == "webp;90"
    ref = info["text"].split("image_id: ")[1].split("\n")[0]
    assert refs.verify(ref, bytes.fromhex((await secrets_of(app))["hmac_key"])).filename == "comfy-gen_00001_.png"
    assert "/img/" + ref in info["text"]
    comfy_calls = [c for c in net.calls if c[1].startswith(COMFY)]
    assert all(c[2].get("X-Test") == "1" for c in comfy_calls)  # generator headers on every call
    assert len(comfy_calls) <= REQUEST_BUDGET


async def test_large_results_are_re_requested_smaller(world, comfy):
    app, *_ = world
    await with_generator(app)
    comfy.view_body = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 800_000
    await mcp(app, "tools/call", {"name": "generate_realistic_image", "arguments": {"prompt": "x"}})
    previews = [c[2]["preview"] for c in comfy.calls if c[1] == "/view"]
    assert previews == ["webp;90", "webp;75"]


async def test_upload_round_trip_then_edit_by_id(world, comfy):
    app, _, _, clock = world
    await with_generator(app)
    _, r = await mcp(app, "tools/call", {"name": "request_upload", "arguments": {"filename": "cat.png"}})
    snippet = r["result"]["content"][0]["text"]
    assert "comfy-gen-upload" in snippet  # its own User-Agent
    token = snippet.split("/upload/")[1].split("'")[0]
    up = await app.handle(request("POST", f"/upload/{token}", png(640, 480)))
    assert up.status == 200
    image_id = json.loads(up.body)["image_id"]
    _, r = await mcp(app, "tools/call", {"name": "edit_image", "arguments": {"prompt": "add a hat", "image": image_id}})
    assert not r["result"]["isError"], r
    loads = [n["inputs"]["image"] for n in comfy.prompts[-1].values() if n["class_type"] == "LoadImage"]
    assert loads and loads[0].startswith("comfy-gen-uploads/upload-") and loads[0].endswith(".png")

    clock.t += 3600  # the link expires
    assert (await app.handle(request("POST", f"/upload/{token}", png()))).status == 403


async def test_edit_by_url_downloads_and_sizes_the_input(world, comfy):
    app, *_ = world
    await with_generator(app)
    _, r = await mcp(app, "tools/call", {"name": "edit_image", "arguments": {"prompt": "x", "image": "https://images.example/a.png"}})
    assert not r["result"]["isError"], r
    assert comfy.uploads  # the URL's bytes went to ComfyUI
    _, r = await mcp(app, "tools/call", {"name": "edit_image", "arguments": {"prompt": "x", "image": "forged.id"}})
    assert r["result"]["isError"] and "image_id" in r["result"]["content"][0]["text"]


async def test_image_route_streams_full_resolution(world, comfy):
    app, *_ = world
    await with_generator(app)
    key = bytes.fromhex((await secrets_of(app))["hmac_key"])
    ref = refs.sign(OutputImage("comfy-gen_00001_.png"), key)
    resp = await app.handle(request("GET", f"/img/{ref}"))
    assert resp.status == 200 and resp.body == comfy.view_body
    assert "preview" not in comfy.calls[-1][2]
    assert (await app.handle(request("GET", "/img/bogus"))).status == 404


async def test_fetch_result_resumes(world, comfy):
    app, *_ = world
    await with_generator(app)
    comfy.history = ["running"] * 200  # longer than one invocation's budget
    _, r = await mcp(app, "tools/call", {"name": "generate_realistic_image", "arguments": {"prompt": "x"}})
    txt = r["result"]["content"][0]["text"]
    assert "fetch_result" in txt
    token = txt.split("request_token '")[1].split("'")[0]
    comfy.history = []
    _, r = await mcp(app, "tools/call", {"name": "fetch_result", "arguments": {"request_token": token}})
    assert r["result"]["content"][0]["type"] == "image"


# ── settings API ──────────────────────────────────────────────────────

async def test_login_with_a_token_that_sees_this_worker(world):
    app, _, net, _ = world
    assert (await app.handle(request("GET", "/api/state"))).status == 401
    cookie = await login(app)
    s = await secrets_of(app)
    assert (s["cf_account_id"], s["cf_script"], s["cf_branch"], s["cf_trigger"]) == ("acct1", "comfy-gen", "main", "trig1")
    assert s["cf_token"] == TOKEN
    assert all(headers["User-Agent"] == "comfy-gen-worker" for _, _, headers in net.calls)  # every outbound call
    resp = await app.handle(request("GET", "/api/state", headers=cookie))
    state = json.loads(resp.body)
    assert state["generator"] is None and state["cloudflare"]["script"] == "comfy-gen"
    assert state["connector_url"].startswith("https://comfy-gen.someone.workers.dev/mcp/")
    assert any(g["tool_name"] == "generate_illustrated_image" for g in state["packs"])


async def test_config_is_normalized_on_save(world):
    app, *_ = world
    cookie = await login(app)
    resp = await app.handle(request("PUT", "/api/config", {"config": {"keep_warm_minutes": -3, "extra": 1}}, headers=cookie))
    cfg = json.loads(resp.body)["config"]
    assert cfg["keep_warm_minutes"] == 5 and cfg["extra"] == 1


async def test_login_refuses_other_tokens(world):
    app, _, net, _ = world
    assert (await app.handle(request("POST", "/api/login", {}))).status == 400
    net.scripts = {"someone-elses-worker": "tag9"}  # a token for another account
    bad = await app.handle(request("POST", "/api/login", {"token": "cfut_stranger"}))
    assert bad.status == 401 and "cannot see a Worker named comfy-gen" in json.loads(bad.body)["error"]
    net.token_status = "revoked"
    bad = await app.handle(request("POST", "/api/login", {"token": "acct_token"}))
    assert bad.status == 401 and "My Profile" in json.loads(bad.body)["error"]
    assert "Set-Cookie" not in bad.headers and "cf_token" not in await secrets_of(app)


async def test_dev_login_checks_the_named_worker(world):
    app, *_ = world
    app.p.env["DEV_WORKER_HOST"] = "comfy-gen.someone.workers.dev"
    resp = await app.handle(Request("POST", "/api/login", "127.0.0.1:8788", body=b'{"token": "cfut_owner"}', scheme="http"))
    assert resp.status == 200


async def test_direct_generator_is_probed_before_saving(world, comfy):
    app, *_ = world
    cookie = await login(app)
    bad = await app.handle(request("POST", "/api/setup/generator", {"base_url": "https://nothing.example"}, headers=cookie))
    assert bad.status == 502 and (await secrets_of(app)).get("generator") is None
    ok = await app.handle(request("POST", "/api/setup/generator", {"base_url": COMFY + "/"}, headers=cookie))
    assert json.loads(ok.body)["system"]["comfyui_version"] == "0.37.0"
    assert (await secrets_of(app))["generator"] == {"kind": "url", "base_url": COMFY, "headers": {}}


async def test_build_and_callback(world):
    app, _, net, _ = world
    cookie = await login(app)
    await app.handle(request("POST", "/api/setup/cloudflare", {"token": "cfut_x"}, headers=cookie))
    resp = await app.handle(request("POST", "/api/setup/build", {"modal_token_id": "ak-1", "modal_token_secret": "as-1"}, headers=cookie))
    assert json.loads(resp.body) == {"build": "build1"}
    assert net.build_vars["MODAL_TOKEN_SECRET"] == {"value": "as-1", "is_secret": True}
    assert net.build_vars["COMFY_GEN_CALLBACK"]["value"] == "https://comfy-gen.someone.workers.dev/build-callback"
    nonce = net.build_vars["COMFY_GEN_NONCE"]["value"]

    status = json.loads((await app.handle(request("GET", "/api/setup/build", headers=cookie))).body)
    assert status["lines"] == ["hello", "world"] and status["status"] == "running"

    assert (await app.handle(request("POST", "/build-callback", {"nonce": "wrong"}))).status == 403
    ok = await app.handle(request("POST", "/build-callback", {
        "nonce": nonce, "stage": "after-deploy", "version": "v1.0.0",
        "modal": {"server_url": "https://m.modal.run", "admin_url": "https://a.modal.run",
                  "proxy_token_id": "wk-1", "proxy_token_secret": "ws-1"}}))
    assert ok.status == 200
    gen = (await secrets_of(app))["generator"]
    assert gen["kind"] == "modal" and gen["headers"] == {"Modal-Key": "wk-1", "Modal-Secret": "ws-1"}


# ── updates ───────────────────────────────────────────────────────────

async def test_update_check(world):
    app, _, net, _ = world
    assert "no Cloudflare token" in await updates.check(net, app.store, "v0.9.0")
    cookie = await login(app)
    await app.handle(request("POST", "/api/setup/cloudflare", {"token": "cfut_x"}, headers=cookie))
    assert "up to date" in await updates.check(net, app.store, "v1.0.0")
    assert "updating v0.9.0 -> v1.0.0" in await updates.check(net, app.store, "v0.9.0")
    assert "already tried" in await updates.check(net, app.store, "v0.9.0")
    assert len(net.builds_started) == 1


def test_parse_version():
    assert updates.parse_version("v1.2.3") == (1, 2, 3)
    assert updates.parse_version("dev") is None
