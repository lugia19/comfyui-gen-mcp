"""The Worker's routes. Plain Python over the Platform services, so every route is tested under
CPython; entry.py adapts Cloudflare's runtime to it.

Keep the MCP path lean (design §3, "Worker CPU budget"): packs are loaded at import, which runs once
inside the deploy-time snapshot, and a warm call reads KV from the isolate cache.
"""

from __future__ import annotations

import asyncio
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

from comfy_gen_worker import auth, cloudflare, modal_admin, updates, uploads
from comfy_gen_worker.hooks import WorkerHooks
from comfy_gen_worker.http import FetchTransport, Platform, Request, Response, with_user_agent
from comfy_gen_worker.render import render, text
from comfy_gen_worker.store import Store

log = logging.getLogger("comfy_gen")

PACKS = packs_mod.builtin_packs()
GROUPS = packs_mod.group_by_tool(PACKS)

# Of the free plan's 50 external subrequests per invocation, what one MCP call may spend on ComfyUI.
# The rest covers downloading an edit_image URL and its upload.
REQUEST_BUDGET = 44
MODAL_COLD_START_S = 300

INSTRUCTIONS = (
    "Images come back inline, each followed by its image_id. Pass an image_id to edit_image to edit "
    "that image."
)


def _pack_metadata() -> list[dict]:
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


PACK_METADATA = _pack_metadata()


def selected_packs(cfg: dict) -> list[dict]:
    return packs_mod.select(GROUPS, cfg["pack_selections"])


def _hmac_key(s: dict) -> bytes:
    return bytes.fromhex(s["hmac_key"])


class App:
    def __init__(self, platform: Platform):
        self.p = platform
        self.fetch = with_user_agent(platform.fetch)
        self.store = Store(platform.kv, platform.now)  # the MCP, image and upload routes
        self.fresh = Store(platform.kv, platform.now, cache=False)  # settings pages, callbacks

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
        result = await updates.check(self.fetch, self.store, self.version)
        log.info("update check: %s", result)
        return result

    # ── MCP ───────────────────────────────────────────────────────────

    def _client(self, generator: dict | None) -> ComfyUIClient | None:
        if not generator or not generator.get("base_url"):
            return None
        transport = FetchTransport(self.fetch, generator["base_url"], generator.get("headers"))
        return ComfyUIClient(transport, cold_start_s=generator.get("cold_start_s", 0), request_budget=REQUEST_BUDGET)

    async def _mcp(self, req: Request, secret: str) -> Response:
        s = await self.store.secrets()
        if not hmac.compare_digest(secret.strip("/"), s["mcp_secret"]):
            return Response.error(404, "not found")
        if req.method != "POST":
            return Response(405, b"", {"Allow": "POST"})
        cfg = await self.store.config()
        key = _hmac_key(s)
        client = self._client(s.get("generator"))
        hooks = WorkerHooks(client, key, self.fetch, admin=modal_admin.for_generator(self.fetch, s.get("generator")),
                            store=self.store, settings_url=f"{req.base_url}/")
        brain = Brain(PACKS, cfg, client, "refs", hooks=hooks)
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
            image = refs.verify(ref, _hmac_key(s))
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
        return await uploads.receive(token, req.body, client, _hmac_key(s), self.p.now())

    # ── builds ────────────────────────────────────────────────────────

    async def _build_callback(self, req: Request) -> Response:
        data = req.json()
        setup = await self.fresh.setup()
        expected = setup.get("build_nonce")
        if not expected or not hmac.compare_digest(str(data.get("nonce", "")), expected):
            return Response.error(403, "bad nonce")
        modal = data.get("modal")
        warnings: list[str] = []
        if isinstance(modal, dict) and modal.get("server_url"):
            generator = {
                "kind": "modal",
                "base_url": modal["server_url"],
                "admin_url": modal.get("admin_url"),
                "headers": {"Modal-Key": modal.get("proxy_token_id", ""), "Modal-Secret": modal.get("proxy_token_secret", "")},
                "cold_start_s": MODAL_COLD_START_S,
            }
            await self.fresh.update_secrets(generator=generator)
            # A deploy resets keep-warm to the app's default, and a fresh install has no models yet.
            admin = modal_admin.for_generator(self.fetch, generator)
            if admin:
                cfg = await self.fresh.config()
                warnings = await self._apply_to_modal(admin, cfg, keep_warm=True)
        return Response.json({"ok": True, "warnings": warnings})

    async def _apply_to_modal(self, admin, cfg: dict, keep_warm: bool) -> list[str]:
        """Best effort: apply keep-warm, start downloads for selected packs. Returns warnings."""
        warnings = []
        if keep_warm:
            try:
                await admin.idle(cfg["keep_warm_minutes"])
            except modal_admin.ModalAdminError as e:
                warnings.append(f"Could not apply keep-warm: {e}")
        return warnings + await modal_admin.seed_missing(admin, self.fresh, selected_packs(cfg))

    # ── settings API ──────────────────────────────────────────────────

    async def _api(self, req: Request, sub: str) -> Response:
        if sub == "/login" and req.method == "POST":
            return await self._login(req)
        s = await self.fresh.secrets()
        if sub == "/logout" and req.method == "POST":
            return Response.json({"ok": True}, headers={"Set-Cookie": auth.cookie_header("", 0)})
        if not auth.session_ok(auth.read_cookie(req.headers.get("cookie")), s["cookie_key"], self.p.now()):
            return Response.error(401, "log in first")

        if sub == "/state" and req.method == "GET":
            return Response.json(await self._state(req, s))
        if sub == "/config" and req.method == "PUT":
            old = await self.fresh.config()
            cfg = await self.fresh.save_config(req.json().get("config"))
            admin = modal_admin.for_generator(self.fetch, s.get("generator"))
            changed = old["keep_warm_minutes"] != cfg["keep_warm_minutes"]
            warnings = await self._apply_to_modal(admin, cfg, keep_warm=changed) if admin else []
            return Response.json({"config": cfg, "warnings": warnings})
        if sub == "/models" and req.method == "GET":
            return await self._models(s)
        if sub == "/models/seed" and req.method == "POST":
            return await self._seed_pack(req, s)
        if sub == "/modal/diagnostics" and req.method == "GET":
            admin = modal_admin.for_generator(self.fetch, s.get("generator"))
            if admin is None:
                return Response.error(400, "the GPU is not on Modal")
            try:
                return Response.json(await admin.diagnostics())
            except modal_admin.ModalAdminError as e:
                return Response.error(502, str(e))
        if sub == "/setup/generator" and req.method == "POST":
            return await self._setup_generator(req)
        if sub == "/setup/build" and req.method == "POST":
            return await self._start_build(req, s)
        if sub == "/setup/build" and req.method == "GET":
            return await self._build_state(req, s)
        if sub == "/setup/rotate-connector" and req.method == "POST":
            await self.fresh.update_secrets(mcp_secret=pysecrets.token_urlsafe(24))
            return Response.json({"ok": True})
        return Response.error(404, "not found")

    async def _state(self, req: Request, s: dict) -> dict:
        gen = s.get("generator") or {}
        setup = await self.fresh.setup()
        return {
            "version": self.version,
            "cloudflare": {k: s.get(f"cf_{k}") for k in ("account_id", "script", "branch")} if s.get("cf_token") else None,
            "generator": {"kind": gen.get("kind"), "base_url": gen.get("base_url")} if gen else None,
            "build": setup.get("build"),
            "connector_url": f"{req.base_url}/mcp/{s['mcp_secret']}",
            "config": await self.fresh.config(),
            "schema": SETTINGS_SCHEMA,
            "packs": PACK_METADATA,
        }

    async def _login(self, req: Request) -> Response:
        """A Cloudflare user token that can see this Worker proves ownership. It is also the token
        the Worker needs for builds and updates, so the latest one is kept."""
        token = str(req.json().get("token", "")).strip()
        if not token:
            return Response.error(400, "paste a token")
        # Under pywrangler dev the host is 127.0.0.1; DEV_WORKER_HOST names a deployed Worker instead.
        host = self.p.env.get("DEV_WORKER_HOST") or req.host
        try:
            await cloudflare.verify_user_token(self.fetch, token)
            found = await cloudflare.discover(self.fetch, token, host)
        except cloudflare.CloudflareError as e:
            return Response.error(401, str(e))
        await self.fresh.update_secrets(
            cf_token=token, cf_account_id=found["account_id"], cf_script=found["script"],
            cf_trigger=found["trigger"], cf_branch=found["branch"],
        )
        session = auth.make_session((await self.fresh.secrets())["cookie_key"], self.p.now())
        return Response.json({"ok": True}, headers={"Set-Cookie": auth.cookie_header(session)})

    async def _models(self, s: dict) -> Response:
        """Download state of the selected packs on Modal, for the pages to poll."""
        admin = modal_admin.for_generator(self.fetch, s.get("generator"))
        if admin is None:
            return Response.json({"packs": []})
        out = []
        for pack in selected_packs(await self.fresh.config()):
            try:
                status = await modal_admin.pack_status(admin, self.fresh, pack)
            except modal_admin.ModalAdminError as e:
                status = {"state": "unknown", "error": str(e)}
            out.append({"name": pack["name"], "display_name": pack.get("display_name", pack["name"]),
                        "tool_name": pack["tool_name"], "size": packs_mod.download_size(pack), **status})
        return Response.json({"packs": out})

    async def _seed_pack(self, req: Request, s: dict) -> Response:
        admin = modal_admin.for_generator(self.fetch, s.get("generator"))
        pack = next((p for p in PACKS if p["name"] == req.json().get("pack")), None)
        if admin is None or pack is None:
            return Response.error(400, "no such pack, or the GPU is not on Modal")
        try:
            return Response.json(await admin.seed(pack))
        except modal_admin.ModalAdminError as e:
            return Response.error(502, str(e))

    async def _setup_generator(self, req: Request) -> Response:
        """A ComfyUI the Worker can reach directly (advanced; Modal is configured by the build)."""
        data = req.json()
        base_url = str(data.get("base_url", "")).strip().rstrip("/")
        headers = data.get("headers") if isinstance(data.get("headers"), dict) else {}
        if not base_url.startswith(("https://", "http://")):
            return Response.error(400, "base_url must be an http(s) URL")
        probe = FetchTransport(self.fetch, base_url, headers)
        resp = await probe.request("GET", "/system_stats")
        if resp.status != 200:
            return Response.error(502, f"ComfyUI did not answer at {base_url}/system_stats (HTTP {resp.status})")
        await self.fresh.update_secrets(generator={"kind": "url", "base_url": base_url, "headers": headers})
        return Response.json({"ok": True, "system": resp.json().get("system", {})})

    async def _start_build(self, req: Request, s: dict) -> Response:
        if not s.get("cf_token"):
            return Response.error(400, "set up the Cloudflare token first")
        data = req.json()
        nonce = pysecrets.token_urlsafe(24)
        await cloudflare.set_build_vars(
            self.fetch, s["cf_token"], s["cf_account_id"], s["cf_trigger"],
            secret={"COMFY_GEN_NONCE": nonce, "MODAL_TOKEN_ID": data.get("modal_token_id"),
                    "MODAL_TOKEN_SECRET": data.get("modal_token_secret")},
            plain={"COMFY_GEN_CALLBACK": f"{req.base_url}/build-callback"},
        )
        build = await cloudflare.start_build(self.fetch, s["cf_token"], s["cf_account_id"], s["cf_trigger"], s.get("cf_branch") or "main")
        await self.fresh.update_setup(build=build, build_nonce=nonce)
        return Response.json({"build": build})

    async def _build_state(self, req: Request, s: dict) -> Response:
        setup = await self.fresh.setup()
        build = setup.get("build")
        if not build or not s.get("cf_token"):
            return Response.json({"build": None})
        status, logs = await asyncio.gather(
            cloudflare.build_status(self.fetch, s["cf_token"], s["cf_account_id"], build),
            cloudflare.build_logs(self.fetch, s["cf_token"], s["cf_account_id"], build, req.query.get("cursor")),
        )
        return Response.json({"build": build, **status, **logs})
