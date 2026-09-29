# Comfy-Gen-MCP rewrite: build plan

> **Status (2026-09-29):** M0–M4 are built and verified live on the test install
> `comfy-gen.yuri-f92.workers.dev`; v1.0.0 (M3) is released. `core` and the Worker are TypeScript
> (design doc §3 "Worker CPU budget", §11, appendix), which leaves the Modal app as the only Python.
> M4 shipped as LoRAs only (below); it goes out in the next release. M5 and M6 (MCPB, agent) are
> Node. Module names below are from the Python era; the TypeScript files keep the same split. The
> rest of this file is the overall plan.
>
> As built, the build step is `packages/worker/deploy/deploy.sh` (the release asset, tag filled in
> by `release.yml`), which hands over to `deploy.py` in the downloaded source. `deploy.py` runs
> `packages/modal_app/deploy.py --out <json>` when a Modal token is set and that file exists; M3
> only has to provide it. Build variables: `COMFY_GEN_REF` (tag or branch), `COMFY_GEN_DEPLOY_URL`
> (where the stub gets `deploy.sh`). `bash deploy.sh --dry-run` builds without deploying.

## M2 in detail: Worker, web app, bootstrap, release pipeline

### Structure: the logic is testable without Cloudflare

```
packages/worker/
  pyproject.toml          standalone pywrangler project, Python 3.14; deps: comfy-gen-core (path, editable=false)
  wrangler.jsonc          dev config (name comfy-gen, KV, Relay DO + migration, assets, cron)
  src/entry.py            the ONLY workers-specific file: WorkerEntrypoint adapter (Request → app.Request,
                          app.Response → Response), scheduled(), and the KV/fetch adapters
  src/comfy_gen_worker/   plain Python, importable under CPython for tests:
    app.py                router: (method, path, headers, body) → Response; auth checks
    store.py              KV-backed state behind a tiny async KV protocol: config, secrets, setup
    auth.py               HMAC cookie session (login is a Cloudflare token, app._login)
    render.py             Brain outcome → MCP content (WebP inline + text; Pending/Failed text)
    hooks.py              WorkerHooks.resolve_image: ref → load value; https URL → fetch + upload
    uploads.py            request_upload snippet, POST /upload/<token> → ComfyUI /upload/image
    setup.py              Cloudflare-token step (verify, discover account/tag/trigger), build start/status/logs
    builds.py             Workers Builds API client (from the spike, over an injected fetch)
    updates.py            cron: latest GitHub release against VERSION → start a build
  tests/                  CPython tests with a fake KV, a fake fetch and FakeComfy; run from the root pytest
```

- `entry.py` provides `FetchTransport`, which implements `core.Transport` over `workers.fetch`,
  plus a KV adapter and a clock. `app.py` receives them injected, so every route is tested under
  CPython. Only `entry.py` needs Pyodide, and it's exercised by the `pywrangler dev` end-to-end run.
- Root `pyproject` testpaths gain `packages/worker/tests`. Worker modules stay 3.12-compatible so
  CI covers them on both versions.

### Routes

| Route | Auth | Does |
|---|---|---|
| `POST /mcp/<mcp_secret>` | secret path | `core.McpHandler`; `request_upload` is handled here, everything else goes to `Brain` (image_mode "refs") and then `render` |
| `GET /img/<ref>` | HMAC ref | streams the full PNG from `/view` |
| `POST /upload/<token>` | HMAC upload token | body is the raw image; uploads it to ComfyUI input `comfy-gen-uploads/`; returns `{"image_id": ref}` |
| `POST /api/login`, `/api/logout` | Cloudflare token that can see this Worker | sets or clears the session cookie (HMAC(cookie_key, expiry), `HttpOnly; Secure; SameSite=Strict`) |
| `GET /api/state` | cookie | setup step, config, pack metadata (names, sizes, descriptions), `SETTINGS_SCHEMA`, connector URL once ready |
| `PUT /api/config` | cookie | `config.normalize` → KV |
| `POST /api/setup/cloudflare` | cookie | verify it's a user token, discover account/tag/trigger, store |
| `POST /api/setup/generator` | cookie | advanced/dev: a direct ComfyUI URL plus optional headers (M3 adds Modal) |
| `POST /api/setup/build`, `GET /api/setup/build` | cookie | start a build; status plus a log cursor (M3 uses it for Modal) |
| `POST /build-callback` | nonce | stores what the build reports (M3: Modal URLs and proxy token) |
| everything else | none | Workers Static Assets serves `web/dist` (SPA fallback), with `run_worker_first` set for the routes above |

- No setup password: login is a Cloudflare user token that can see this Worker (design §8, "Login").
- The MCP secret, HMAC key and cookie key are generated on the first request and stored in KV.
- Config and secrets are cached per isolate for 30 s, so an MCP call costs zero KV reads when warm.

### Subrequest budget (verified 2026-09-28)

The free plan allows **50 external subrequests per invocation** (`fetch()`), plus **1,000 to
Cloudflare services** (KV, and by the docs' wording Durable Object calls). There's no reset over
time: polling `/history` every second for 240 s would be 240 requests. A 250 s blocking tool call
through a deployed Worker does work (HTTP 200 after 251.7 s, tested today), so blocking itself is
fine. Only the request count needs managing:

- `core.ComfyUIClient` gains an optional `request_budget`, counting every transport call.
  - `wait` polls on a backoff (1, 1, 2, 2, 3, 5, 5, 8 s, then every 10 s). Queue checks drop to
    every 5th poll.
  - Cold-start retries in `submit` use 5 s steps, so Modal's roughly 44 s boot costs about 9
    requests.
  - It stops early when only the reserve for `/view` is left (2: the WebP, plus one lower-quality
    retry). `wait` then returns `None`, which becomes `Pending` and a `fetch_result` token.
    `fetch_result` runs as a new invocation with a fresh budget.
- A worst case of cold start, a long generation and the view comes to about 42 requests, inside
  a Worker budget of 46. The MCPB passes no budget, so it has no limit.
- The relay path goes Worker → Durable Object, which counts against the 1,000 limit. The Durable
  Object's WebSocket messages to the agent aren't subrequests. So the PC path isn't squeezed.
- Record in `docs/design.md` §3 (Waiting) and §13.

### Web app (`web/`, Svelte 5 + Vite, built `web/dist` committed)

- Pages:
  - Login.
  - Setup:
    - Cloudflare token: the template link, the "narrow to your account" note, then paste.
    - Generator: Modal in M3; a direct URL for now.
    - Packs.
    - Connector URL with claude.ai instructions.
  - Settings: pack choice with download sizes, max megapixels, keep-warm, all rendered from
    `SETTINGS_SCHEMA` and pack metadata.
- Plain handwritten CSS with light and dark themes, no UI framework. Everything goes through `/api`.
- CI builds it and fails if `web/dist` differs from the committed copy.

### Bootstrap template (`bootstrap/`) and `deploy.sh`

- `wrangler.jsonc`:
  - **name `comfy-gen`**. The button names the new repo after the Worker, so it must never be
    `comfy-gen-mcp` or `comfy-dxt`.
  - bindings: KV, the Relay DO with its migration, assets, a daily cron.
- `package.json`: the deploy stub
  `curl -fsSL "${COMFY_GEN_DEPLOY_URL:-https://github.com/lugia19/comfyui-gen-mcp/releases/latest/download/deploy.sh}" | bash`.
  A build variable can point it at a branch's script, for testing before a release exists.
- No `.dev.vars.example` (the button asks for nothing) and no `pyproject.toml`.
- `deploy.sh`, released as an asset:
  - resolve the tag (latest, or `COMFY_GEN_REF`) and download its tarball
  - lay out `packages/{core,worker}` plus `web/dist`
  - merge the template's `name` and provisioned KV id into the release's `wrangler.jsonc`, using a
    tolerant JSONC reader
  - set `vars.VERSION`
  - `uv run pywrangler deploy`
  - M3 adds the Modal step and the callback. Every HTTP call sends a custom `User-Agent`.

### Release pipeline and site

- `.github/workflows/release.yml`: on a `v*` tag, create the GitHub release with `deploy.sh` as an
  asset. `inventory.json` comes in M4.
- `site/index.html`: prerequisites and the Deploy button. It's published through a Pages workflow
  once the user enables Pages.

### Cron updates

`scheduled()` runs daily:
- asks GitHub's API for the latest release (with a `User-Agent`, as GitHub requires)
- if its tag is newer than `VERSION`, a token is stored, and that tag wasn't already tried: start a
  build and record the tag in KV

### Verification (M2)

- CPython tests for every route, auth, render, uploads, setup, builds and updates, using fakes.
  Core gains tests for the request budget.
- **End to end here:**
  - `pywrangler dev` in front of a CPU ComfyUI installed with comfy-cli in this container
  - a custom workflow of core nodes only: EmptyImage as the titled prompt node, then SaveImage
  - MCP driven with curl: `initialize`, `tools/list`, `generate_custom_image` → inline WebP,
    `/img/<ref>`, `request_upload` + upload, `edit`-by-URL resolution, and a `fetch_result` timeout
    path
  - the web pages driven with Playwright Chromium (login, setup steps, settings save)
- **Real deploy** (with the user's go-ahead): a Deploy-button deploy of `bootstrap/` with
  `COMFY_GEN_DEPLOY_URL` pointed at the branch, then setup through the pages. CPU per call is read
  from Workers Logs as in S1b.

---

## Context

`lugia19/comfyui-gen-mcp` is the rewrite of Comfy-Gen-MCP. There is one "brain" (packs,
workflow building, tool list, ComfyUI client, MCP handler) and it runs in two places:

- a **Cloudflare Python Worker**, which drives ComfyUI on Modal or on the user's PC
- a local server behind the **Claude Desktop MCPB**, which drives ComfyUI on localhost

The design is in `docs/design.md`. The infrastructure spikes (S1–S8) have settled every open
question except S6's one-day cost, which is running now. This plan replaces the spike-era plan and
covers the product from here to retiring the old repo.

**Ordering principle.** This cloud container has limits:
- no gRPC, so no direct Modal
- no outbound WebSocket
- no Windows, GPU or Claude Desktop

So everything that can be built and tested here comes first. The Modal, Windows and GPU-bound parts
come last, finished on the user's machine or through Cloudflare builds. Old users are unaffected
meanwhile, since the old repo keeps serving the Desktop mode.

The work goes on branch `claude/upbeat-dijkstra-d03v19` (currently the repo's default).

## Decisions this plan builds on (from the spikes and Q&A)

- **MCP: a hand-rolled stateless JSON-RPC handler in `core`**, handling initialize, ping,
  tools/list and tools/call. The MCP SDK blows the Worker's CPU budget (S1). Only the MCPB's stdio
  shim, which runs under CPython, keeps the SDK.
- **Worker CPU rules** (S1b/S2b):
  - no heavy imports
  - anything request-independent is serialized at import (inside the startup snapshot)
  - no logging on the MCP path
  - plain dict work per call
  - Python's floor is about 3 ms typical and 10–20 ms on a fresh isolate. Cloudflare tolerated up to
    116 ms.
- **Results are inline WebP q90**, fetched as `/view?…&preview=webp;90` so ComfyUI does the
  conversion. The Worker re-requests at q75 if the result is over about 700 KB. Alongside it goes a
  text block with the image id and a full-resolution PNG link. There is no `resource_link`, since
  claude.ai doesn't support it (S2, S2c).
- **Edits** load earlier outputs as `"<name> [output]"`. Uploads go through the code-execution
  sandbox via `request_upload` (S3, S5).
- **Jobs are stateless.** The request token is ComfyUI's `prompt_id`. A call blocks for up to about
  240 s, within the client's 5-minute timeout (S8).
- **Refs** are HMAC-signed ComfyUI locations, so they need no storage.
- **Python clients that call a Worker send a custom `User-Agent`**, because Cloudflare
  1010-blocks `Python-urllib` (S4).
- **Deploy template:** config only, no `pyproject.toml`. The deploy command is a stub that
  downloads the release's `deploy.sh`. The Builds API needs a user token, which comes from the
  template link (S4, §8).
- **Modal:**
  - input, output and models all live on the Volume
  - explicit commit on exit
  - LoRAs become visible through a reload while idle (S5)
  - GGUF is installed with `comfy node registry-install`
- **No hot-pack layer.** Packs ship in `core`. A new pack means a release, and the cron build rolls
  it out.
- **The MCPB keeps its shim, server and tray architecture.** Qt goes, replaced by a small pystray
  tray plus the browser settings app.

## Repository layout (as built)

```
package.json              npm workspaces: packages/core, packages/worker
pyproject.toml            uv workspace: packages/modal_app (the only Python besides the build step)
packages/
  core/                   @comfy-gen/core, TypeScript, Web-platform APIs only; packs/ holds the pack JSON
  worker/                 the Cloudflare Worker (wrangler); deploy/ is the build step (deploy.sh, deploy.py)
  modal_app/              comfy_gen_modal: the Modal app, admin API, seed, the /comfy-gen/wait extension
  (M5, M6: the Node MCPB and agent, sharing one machine-side package)
web/                      Svelte settings/setup app; built web/dist committed
bootstrap/                Deploy-button template
scripts/                  check_pack_models.py
.github/workflows/        ci.yml, release.yml
```

## M0: housekeeping (small, first)

- **Consolidate `docs/design.md`:**
  - Status line.
  - §3: the client sits on a `Transport` protocol.
  - §4: WebP q90.
  - §7: drop hot data.
  - §11: fix the "Python Workers support the MCP SDK" row, add "MCP SDK in the Worker" as rejected,
    and remove the QoL component row.
  - §13: phases in this plan's order.
  - Move the spike results into an appendix and record S2c (WebP).
- **CLAUDE.md:** the Worker CPU rules, the User-Agent rule, the worker-outside-the-workspace note,
  test commands.
- **Commit this plan** as `docs/build-plan.md`, so a local Claude Code can pick up the later
  milestones.
- **Workspace:** a root `pyproject.toml` for the product packages. The spikes leave the workspace
  (their worker switches to a `path` dependency).
- **CI** (`ci.yml`): pytest on 3.12 and 3.14, and the Pyodide job for `core`. The check that
  `web/dist` matches its source is added in M2.
- `spikes/` stays until S6 is recorded, then it's deleted in one commit.

## M1: `core`

| Module | Contents | Source |
|---|---|---|
| `workflow.py` | aspect ratios, `split_lossless`, `calc_dimensions`, `build_prompt(…, rng)`, `inject_loras`, `parse_custom_workflow(dict, title)`, `class_types` | old `server/workflow.py` |
| `packs.py` + `packs/*.json` | `builtin_packs()` (importlib.resources), `validate`, `group_by_tool`, `select`, `prepare(pack, cfg)` (LoRAs, `max_pixels`), `required_nodes` | old `model_pack.py`, `main._apply_*` |
| `config.py` | shared config shape + `normalize` (keeps unknown keys) + global `SETTINGS_SCHEMA` | old `settings.py`, `config.py` |
| `images.py` | `sniff_mime`, `image_size` from headers | new |
| `comfyui.py` | `Transport` protocol, `Response`, `HttpxTransport`, `OutputImage`, `encode_multipart`, `ComfyUIClient` (`submit` with cold-start retry, `wait` with worker-replaced detection, `status_message`, `view(image, preview=None)`, `upload`, `node_classes`), `ComfyUIError` | Visual-Novelist `comfy.py` plus old `comfy_job.py` |
| `tools.py` | schemas, descriptions, `tool_specs(packs, cfg, image_mode="paths"\|"refs")` | old `tool_specs.py` |
| `brain.py` | `Brain(packs, cfg, client, image_mode, hooks, inventory=None, wait_s=240)`, `call(name, args) → Done \| Pending \| Failed`, edit assembly (`edit_scale` sizing, `EDIT_BUDGET_TOLERANCE`), custom-workflow pack, inventory check | old `main.register_tools`, `edit_image`, `wait_for_job` |
| `refs.py` | `sign`/`verify` for image refs; `mint_upload`/`check_upload` tokens | new |
| `mcp.py` | the stateless JSON-RPC handler: `McpHandler(specs_json, call)` → `handle(body) → (status, bytes)` | `spikes/worker/src/mcp_raw.py` |

- **Hooks** are the per-machine seam:
  - `ensure(pack)`: models, launch, nodes in the MCPB and agent; nothing on Modal
  - `resolve_image(arg) → (comfy_name, size)`: a ref or URL in the Worker; a path or URL in the
    MCPB
- **Tests:**
  - A `FakeComfy` `Transport` covering booting 503s, history sequences, the queue, `/view` and
    `/upload`.
  - Workflow and LoRA behaviour carried over from the old code.
  - Pack selection, both tool modes, edit sizing, lossless tokens, ref tampering, image headers, and
    MCP handler framing.
  - The same suite under Pyodide (`scripts/test_pyodide.mjs`), minus the httpx tests.

## M2: Worker, web app, bootstrap, release pipeline (the cloud path, generator-agnostic)

**`worker`:**
- `entry.py` router:
  - `/mcp/<secret>`
  - `/img/<ref>`: streams the full PNG
  - `/upload/<token>`
  - `/setup`, `/settings` and `/api/*`: Cloudflare-token login, then an HMAC cookie
  - static `web/dist` through Workers Static Assets, with no Python CPU cost (to verify)
  - `/build-callback`: nonce-checked
  - `scheduled()`: daily update check
- Modules:
  - `kv.py`: config, secrets, setup state
  - `render.py`: `Done` → WebP inline plus text
  - `fetch_transport.py`: JS fetch plus optional Modal proxy headers
  - `builds.py`: from the spike
  - `setup.py`: tokens → build → callback → packs
  - `updates.py`: latest GitHub release against the deployed version → start a build
- The MCP secret and the HMAC key are generated on first request and stored in KV (one write).
- The generator URL and headers are config, so any reachable ComfyUI works. That's how it's tested
  before Modal exists.

**`web`** (Svelte), rendered from `SETTINGS_SCHEMA` and pack metadata, so the MCPB reuses it later:
- setup wizard:
  - login: the token template link, with "narrow to your account"
  - Modal pair
  - build log stream
  - packs
  - connector URL
- settings: packs and keep-warm first, the rest in M4

**`bootstrap/`:**
- `wrangler.jsonc` declares every binding up front: KV, and the Relay Durable Object with its
  migration, so M6 needs no template change.
- `package.json` with the deploy stub, which downloads `releases/latest/download/deploy.sh`.
- No secrets to fill in: login is a Cloudflare token.

The release's `deploy.sh`:
- fetches that release's source
- merges the template's provisioned IDs into the release's wrangler config
- runs `modal deploy` when Modal tokens are present
- runs `pywrangler deploy`
- calls back

**`release.yml`:** runs on a tag. It attaches `deploy.sh` and dumps `inventory.json` from a CPU
ComfyUI plus GGUF (the node inventory for custom-workflow validation).

**`site/`:** prerequisites plus the Deploy button.

**Testable here, end to end:** `pywrangler dev` against a CPU ComfyUI running in this container,
with tiny test workflows. Then a real deploy through the Deploy button to the user's account,
pointed at any reachable ComfyUI.

## M3: `modal_app` and the first cloud release (no-GPU path)

- `app.py`:
  - image: comfy-cli 1.21.0, ComfyUI 0.37.0, GGUF
  - the Volume holds `models`, `input` and `output`; commit on exit
  - `seed(pack manifest)` with progress in a `modal.Dict`
  - admin ASGI endpoint (proxy auth): seed/progress, LoRA put/list, idle (`update_autoscaler`),
    reload-request
  - server watcher: when a reload is requested and the queue is empty, `POST /free`, then
    `volume.reload()`. This closes S5(d) with a real model loaded.
- `deploy.py` runs in the build: `modal deploy`, mint a proxy token if missing, then POST the
  server URL, admin URL and token with the nonce to the Worker (custom UA).
- The Worker's `modal_admin.py` handles seeding packs from the setup page, and keep-warm through
  `idle`.
- **Where:** written here. It's iterated either through Cloudflare builds, as in the spikes
  (2–5 minutes each), or faster by the user or a local Claude Code with the `modal` CLI.
- **Release:** tag v1.0.0. The user goes through the button, then setup, then generates from
  claude.ai.

## M4: full cloud settings (as built: LoRAs)

- Artists, `request_upload`/`edit_image` refs and live keep-warm had already landed in M2 and M3.
- LoRAs for the Anima family: chunked browser upload straight to the Modal app (upload sessions
  through the admin API, a no-proxy-auth `upload` endpoint, `assemble`), list and delete, per-pack
  rows (file, strength, trigger, hidden), and a save-time warning for LoRAs not uploaded
  (design §4 "LoRAs on the Modal Volume").
- Dropped after discussion: custom workflows on Modal (only the packs' files and nodes are there;
  the tool is not offered for a Modal generator) and general model-file uploads. So no
  `inventory.json`; node inventories are for the PC path (M6).

## M5: `local` and the MCPB, at parity with the old extension (on the user's machine)

**`local`**, ported from the old `server/` with Qt removed:
- `install.py`, `process.py` and `nodes.py`, from `comfyui.py`:
  - the comfy-cli environment fixes
  - GPU detection and the bind probe
  - killing the process tree, `remove_comfyui_dir`
  - `extra_model_paths`, ComfyUI-Manager and node installs
- `downloader.py` (a sequential queue whose state the UI can read)
- `registry.py`
- `singleton.py`
- `lifecycle.LocalGenerator`: `ensure`, `touch`, idle stop, `status`
- `tray.py` (pystray)

**`mcpb`:**
- `shim.py`, ported as it is: spawn on a failed `/alive`, 15 s keepalive, bootstrapper sync; its
  tool list comes from `core.tools`
- `server.py`: Starlette + uvicorn with:
  - `core.mcp` at the secret `mcp_path`, and `/alive`
  - `/settings` (serves `web/dist`) and `/api/*`
  - managed shutdown, the runtime lock, restart
- Results: Pillow WebP q90 (PNG with `:lossless`) plus `saved_path`.
- `web` gains the local pages: first-run GPU choice and ComfyUI install, download progress,
  reinstall, and the extra-models dir.
- `manifest.json` and a build script. The launcher's `repo.json` points at
  `github.com/lugia19/comfyui-gen-mcp.git`.

**Where:** the scaffold and the parts testable against a CPU ComfyUI are done here. The Windows,
GPU and Claude Desktop finishing is done locally.

## M6: agent and relay, then retirement

- Worker side, done here: the Relay Durable Object from the spike, carrying `Response`-shaped
  messages, plus `RelayTransport` and pairing. It's tested against a local stand-in agent through
  `wrangler dev` (localhost WebSockets work here).
- `agent`, done locally: `local` plus the relay client (WebSocket, pairing secret, custom UA) plus
  the tray. It starts at boot through the launcher.
- If both are configured, the PC is used when it's online and Modal otherwise.
- Last step: a final "install the new version" commit to the old repo, then archive it (never
  delete).

## Open items, closed inside the milestones

- S6 day cost: record it in M0 when it's in.
- The Workers Admin template key: probe it with test links in M2.
- Static Assets alongside a Python Worker: M2.
- S5(d) with a loaded model: M3.

## Verification

- **Every milestone:** `npm run typecheck`, `npm test` and `uv run pytest` (3.12 and 3.14), green
  in CI.
- **M2:**
  - `pywrangler dev` plus a CPU ComfyUI here, covering MCP `tools/list`, a generate with a tiny
    workflow, a WebP result, refs, the upload route, and the setup and settings pages in Playwright
  - then a real button deploy, with CPU per `tools/call` read from Workers Logs as in S1b
- **M3:** a real no-GPU setup on the user's account, generating from claude.ai; a tagged release
  rolls out through the cron build.
- **M5/M6:** on the user's Windows PC. The MCPB in Claude Desktop; the agent generating from
  claude.ai mobile.

## Cleanup

- Done 2026-09-29: `spikes/` deleted; the `comfy-gen-spike-button` Worker and the Modal
  `comfy-gen-spike` app, volume and dict removed.
- Left for the user: the GitHub repository the spike's Deploy button created; rotating the
  Cloudflare and Modal tokens used during development, once M4 no longer needs them.
