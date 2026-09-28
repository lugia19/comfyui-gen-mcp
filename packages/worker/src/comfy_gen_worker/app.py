"""The Worker's routes. Plain Python over the Platform services, so every route is tested under
CPython; entry.py adapts Cloudflare's runtime to it.

Keep the MCP path lean (design §3, "Worker CPU budget"): packs are loaded at import, which runs once
inside the deploy-time snapshot, and a warm call reads KV from the isolate cache.
"""

from __future__ import annotations

import hmac
import logging
import secrets as pysecrets

from comfy_gen_core import packs as packs_mod
from comfy_gen_core import refs
from comfy_gen_core.brain import Brain
from comfy_gen_core.comfyui import ComfyUIClient, ComfyUIError
from comfy_gen_core.config import SETTINGS_SCHEMA
from comfy_gen_core.images import sniff_mime
from comfy_gen_core.mcp import McpHandler

from comfy_gen_worker import auth, cloudflare, updates, uploads
from comfy_gen_worker.hooks import WorkerHooks
from comfy_gen_worker.http import FetchTransport, Platform, Request, Response
from comfy_gen_worker.render import render, text
from comfy_gen_worker.store import Store

log = logging.getLogger("comfy_gen")

PACKS = packs_mod.builtin_packs()

# Of the free plan's 50 external subrequests per invocation, what one MCP call may spend on ComfyUI.
# The rest covers downloading an edit_image URL and its upload.
REQUEST_BUDGET = 44
MODAL_COLD_START_S = 300

INSTRUCTIONS = (
    "Images come back inline, each followed by its image_id. Pass an image_id to edit_image to edit "
    "that image."
)


def pack_metadata() -> list[dict]:
    """What the settings page needs to render pack choices."""
    groups = packs_mod.group_by_tool(PACKS)
    return [
        {
            "tool_name": tool,
            "packs": [
                {
                    "name": p["name"],
                    "display_name": p.get("display_name", p["name"]),
                    "description": p.get("description", ""),
                    "download_size": packs_mod.download_size(p),
                    "is_default": bool(p.get("is_default")),
                    "config_key": packs_mod.config_key(p),
                    "max_pixels": p.get("max_pixels"),
                    "max_pixels_limit": p.get("max_pixels_limit"),
                    "default_artist_list": p.get("default_artist_list"),
                }
                for p in group
            ],
        }
        for tool, group in groups.items()
    ]


class App:
    def __init__(self, platform: Platform):
        self.p = platform
        self.store = Store(platform.kv, platform.now)

    @property
    def version(self) -> str:
        return self.p.env.get("VERSION") or "dev"

    # ── entry points ──────────────────────────────────────────────────

    async def handle(self, req: Request) -> Response:
        path = req.path
        try:
            if path.startswith("/mcp/"):
                return await self._mcp(req, path[len("/mcp/"):])
            if path.startswith("/img/") and req.method == "GET":
                return await self._image(path[len("/img/"):])
            if path.startswith("/upload/") and req.method == "POST":
                return await self._upload(req, path[len("/upload/"):])
            if path == "/build-callback" and req.method == "POST":
                return await self._build_callback(req)
            if path.startswith("/api/"):
                return await self._api(req, path[len("/api"):])
        except cloudflare.CloudflareError as e:
            return Response.error(502, str(e))
        return Response.error(404, "not found")

    async def scheduled(self) -> str:
        result = await updates.check(self.p.fetch, self.store, self.version)
        log.info("update check: %s", result)
        return result

    # ── MCP ───────────────────────────────────────────────────────────

    def _client(self, generator: dict | None) -> ComfyUIClient | None:
        if not generator or not generator.get("base_url"):
            return None
        transport = FetchTransport(self.p.fetch, generator["base_url"], generator.get("headers"))
        return ComfyUIClient(transport, cold_start_s=generator.get("cold_start_s", 0), request_budget=REQUEST_BUDGET)

    async def _mcp(self, req: Request, secret: str) -> Response:
        s = await self.store.secrets()
        if not hmac.compare_digest(secret.strip("/"), s["mcp_secret"]):
            return Response.error(404, "not found")
        if req.method != "POST":
            return Response(405, b"", {"Allow": "POST"})
        cfg = await self.store.config()
        key = bytes.fromhex(s["hmac_key"])
        client = self._client(s.get("generator"))
        brain = Brain(PACKS, cfg, client, "refs", hooks=WorkerHooks(client, key, self.p.fetch))
        served = {spec["name"] for spec in brain.specs}

        async def call(name: str, args: dict) -> tuple[list[dict], bool]:
            if name not in served:
                raise KeyError(name)
            if client is None:
                return [text(f"Error: the image generator is not set up yet. Finish setup at {req.base_url}/")], True
            if name == "request_upload":
                return uploads.request_upload(args, req.base_url, key, self.p.now())
            outcome = await brain.call(name, args)
            return await render(outcome, client, req.base_url, key)

        handler = McpHandler("Comfy-Gen-MCP", self.version, brain.specs, call, instructions=INSTRUCTIONS)
        status, body = await handler.handle(req.body)
        if body is None:
            return Response(status)
        return Response(status, body, {"Content-Type": "application/json"})

    async def _image(self, ref: str) -> Response:
        s = await self.store.secrets()
        try:
            image = refs.verify(ref, bytes.fromhex(s["hmac_key"]))
        except refs.RefError:
            return Response.error(404, "not found")
        client = self._client(s.get("generator"))
        if client is None:
            return Response.error(503, "generator not set up")
        try:
            resp = await client.view(image)
        except ComfyUIError as e:
            return Response.error(502, str(e))
        mime = sniff_mime(resp.content) or "application/octet-stream"
        return Response(200, resp.content, {"Content-Type": mime, "Cache-Control": "private, max-age=86400"})

    async def _upload(self, req: Request, token: str) -> Response:
        s = await self.store.secrets()
        client = self._client(s.get("generator"))
        if client is None:
            return Response.error(503, "generator not set up")
        return await uploads.receive(token, req.body, client, bytes.fromhex(s["hmac_key"]), self.p.now())

    # ── builds ────────────────────────────────────────────────────────

    async def _build_callback(self, req: Request) -> Response:
        data = req.json()
        setup = await self.store.setup()
        expected = setup.get("build_nonce")
        if not expected or not hmac.compare_digest(str(data.get("nonce", "")), expected):
            return Response.error(403, "bad nonce")
        modal = data.get("modal")
        if isinstance(modal, dict) and modal.get("server_url"):
            await self.store.update_secrets(
                generator={
                    "kind": "modal",
                    "base_url": modal["server_url"],
                    "headers": {"Modal-Key": modal.get("proxy_token_id", ""), "Modal-Secret": modal.get("proxy_token_secret", "")},
                    "cold_start_s": MODAL_COLD_START_S,
                },
                modal_admin_url=modal.get("admin_url"),
            )
        reports = (setup.get("reports") or [])[-9:]
        reports.append({k: data.get(k) for k in ("stage", "version", "modal_result")} | {"at": int(self.p.now())})
        await self.store.update_setup(reports=reports)
        return Response.json({"ok": True})

    # ── settings API ──────────────────────────────────────────────────

    async def _api(self, req: Request, sub: str) -> Response:
        s = await self.store.secrets()
        if sub == "/login" and req.method == "POST":
            if not auth.password_ok(str(req.json().get("password", "")), self.p.env.get("SETUP_PASSWORD")):
                return Response.error(401, "wrong password")
            session = auth.make_session(s["cookie_key"], self.p.now())
            return Response.json({"ok": True}, headers={"Set-Cookie": auth.cookie_header(session)})
        if sub == "/logout" and req.method == "POST":
            return Response.json({"ok": True}, headers={"Set-Cookie": auth.cookie_header("", 0)})
        if not auth.session_ok(auth.read_cookie(req.headers.get("cookie")), s["cookie_key"], self.p.now()):
            return Response.error(401, "log in first")

        if sub == "/state" and req.method == "GET":
            return Response.json(await self._state(req, s))
        if sub == "/config" and req.method == "PUT":
            cfg = await self.store.save_config(req.json().get("config"))
            return Response.json({"config": cfg})
        if sub == "/setup/cloudflare" and req.method == "POST":
            return await self._setup_cloudflare(req)
        if sub == "/setup/generator" and req.method == "POST":
            return await self._setup_generator(req)
        if sub == "/setup/build" and req.method == "POST":
            return await self._start_build(req, s)
        if sub == "/setup/build" and req.method == "GET":
            return await self._build_state(req, s)
        if sub == "/setup/rotate-connector" and req.method == "POST":
            await self.store.update_secrets(mcp_secret=pysecrets.token_urlsafe(24))
            return Response.json({"ok": True})
        return Response.error(404, "not found")

    async def _state(self, req: Request, s: dict) -> dict:
        gen = s.get("generator") or {}
        setup = await self.store.setup()
        return {
            "version": self.version,
            "cloudflare": {k: s.get(f"cf_{k}") for k in ("account_id", "script", "branch")} if s.get("cf_token") else None,
            "generator": {"kind": gen.get("kind"), "base_url": gen.get("base_url")} if gen else None,
            "build": setup.get("build"),
            "reports": setup.get("reports") or [],
            "connector_url": f"{req.base_url}/mcp/{s['mcp_secret']}",
            "config": await self.store.config(),
            "schema": SETTINGS_SCHEMA,
            "packs": pack_metadata(),
        }

    async def _setup_cloudflare(self, req: Request) -> Response:
        token = str(req.json().get("token", "")).strip()
        if not token:
            return Response.error(400, "paste a token")
        await cloudflare.verify_user_token(self.p.fetch, token)
        found = await cloudflare.discover(self.p.fetch, token, req.host)
        await self.store.update_secrets(
            cf_token=token, cf_account_id=found["account_id"], cf_script=found["script"], cf_tag=found["tag"],
            cf_trigger=found["trigger"], cf_branch=found["branch"],
        )
        return Response.json({k: found[k] for k in ("account_id", "script", "branch")})

    async def _setup_generator(self, req: Request) -> Response:
        """A ComfyUI the Worker can reach directly (advanced; Modal is configured by the build)."""
        data = req.json()
        base_url = str(data.get("base_url", "")).strip().rstrip("/")
        headers = data.get("headers") if isinstance(data.get("headers"), dict) else {}
        if not base_url.startswith(("https://", "http://")):
            return Response.error(400, "base_url must be an http(s) URL")
        probe = FetchTransport(self.p.fetch, base_url, headers)
        resp = await probe.request("GET", "/system_stats")
        if resp.status != 200:
            return Response.error(502, f"ComfyUI did not answer at {base_url}/system_stats (HTTP {resp.status})")
        await self.store.update_secrets(generator={"kind": "url", "base_url": base_url, "headers": headers})
        return Response.json({"ok": True, "system": resp.json().get("system", {})})

    async def _start_build(self, req: Request, s: dict) -> Response:
        if not s.get("cf_token"):
            return Response.error(400, "set up the Cloudflare token first")
        data = req.json()
        nonce = pysecrets.token_urlsafe(24)
        await cloudflare.set_build_vars(
            self.p.fetch, s["cf_token"], s["cf_account_id"], s["cf_trigger"],
            secret={"COMFY_GEN_NONCE": nonce, "MODAL_TOKEN_ID": data.get("modal_token_id"),
                    "MODAL_TOKEN_SECRET": data.get("modal_token_secret")},
            plain={"COMFY_GEN_CALLBACK": f"{req.base_url}/build-callback"},
        )
        build = await cloudflare.start_build(self.p.fetch, s["cf_token"], s["cf_account_id"], s["cf_trigger"], s.get("cf_branch") or "main")
        await self.store.update_setup(build=build, build_nonce=nonce)
        return Response.json({"build": build})

    async def _build_state(self, req: Request, s: dict) -> Response:
        setup = await self.store.setup()
        build = req.query.get("build") or setup.get("build")
        if not build or not s.get("cf_token"):
            return Response.json({"build": None})
        status = await cloudflare.build_status(self.p.fetch, s["cf_token"], s["cf_account_id"], build)
        logs = await cloudflare.build_logs(self.p.fetch, s["cf_token"], s["cf_account_id"], build, req.query.get("cursor"))
        return Response.json({"build": build, **status, **logs})
