# Comfy-Gen-MCP rewrite: build plan

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

## Repository layout (target)

```
pyproject.toml            uv workspace (requires-python >= 3.12): core, local, mcpb, agent, modal_app
packages/
  core/                   comfy_gen_core  (CPython 3.12+ and Pyodide 3.14)
  worker/                 standalone pywrangler project (Python 3.14), NOT a workspace member;
                          depends on core via { path = "../core", editable = false } (S7)
  modal_app/              comfy_gen_modal (Modal app, admin endpoint, build-time deploy script)
  local/                  comfy_gen_local (ComfyUI lifecycle on a user machine, tray)
  mcpb/                   comfy_gen_mcpb  (stdio shim, local server, manifest.json, build script)
  agent/                  comfy_gen_agent
web/                      Svelte settings/setup app; built web/dist committed (users have no node)
bootstrap/                Deploy-button template
site/                     static landing page on GitHub Pages
scripts/test_pyodide.mjs  runs core's tests under Pyodide via the npm pyodide package
.github/workflows/        ci.yml, release.yml
```

`worker` stays out of the workspace because a workspace takes the intersection of its members'
`requires-python`, which would force every member onto 3.14.

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
  - `/setup`, `/settings` and `/api/*`: password, then an HMAC cookie
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
  - password
  - the token template link, with "narrow to your account"
  - Modal pair
  - build log stream
  - packs
  - connector URL
- settings: packs and keep-warm first, the rest in M4

**`bootstrap/`:**
- `wrangler.jsonc` declares every binding up front: KV, and the Relay Durable Object with its
  migration, so M6 needs no template change.
- `package.json` with the deploy stub, which downloads `releases/latest/download/deploy.sh`.
- `.dev.vars.example` with `SETUP_PASSWORD`.

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

## M4: full cloud settings

- LoRA upload and selection, artists and custom workflows (validated against `inventory.json`) in
  the Worker settings
- `request_upload` and `edit_image` refs end to end
- keep-warm applied live

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

- **Every milestone:** `uv run pytest` (3.12 and 3.14) and `node scripts/test_pyodide.mjs`, both
  green in CI.
- **M2:**
  - `pywrangler dev` plus a CPU ComfyUI here, covering MCP `tools/list`, a generate with a tiny
    workflow, a WebP result, refs, the upload route, and the setup and settings pages in Playwright
  - then a real button deploy, with CPU per `tools/call` read from Workers Logs as in S1b
- **M3:** a real no-GPU setup on the user's account, generating from claude.ai; a tagged release
  rolls out through the cron build.
- **M5/M6:** on the user's Windows PC. The MCPB in Claude Desktop; the agent generating from
  claude.ai mobile.

## Cleanup (user, after S6)

- Delete the `comfy-gen-spike-button` Worker and its repo, and the Modal `comfy-gen-spike` app and
  volume.
- Rotate the Cloudflare and Modal tokens used for the spikes.
