# Comfy-Gen-MCP: build plan

What is built, how it ships, and what comes next. `docs/design.md` holds the design and the measured
results behind it; this file only tracks the work.

**Status (2026-09-29):** M0–M4 are built. v1.0.0 (M3) and v1.1.0 (M4) are released, and the test
install `comfy-gen.yuri-f92.workers.dev` runs v1.1.0. Next: M5.

## Built

| Milestone | What | Where it is described |
|---|---|---|
| M0 | Design consolidated, workspace, CI | design §10 |
| M1 | `core`: workflows, packs, config, ComfyUI client, image refs, tool specs, MCP handler, brain | design §3 |
| M2 | Worker, settings app, bootstrap template, `deploy.sh`, release workflow, daily update check | design §5–8 |
| M3 | Modal app: ComfyUI server, model downloads, admin API, idle-time Volume reload; first release | design §2–4, appendix "M3 live" |
| — | `core` and the Worker ported from Python to TypeScript (CPU budget) | design §3, §11, appendix |
| — | Held waits (`/comfy-gen/wait`) and native base64 (CPU) | design §3 "Waiting", appendix |
| M4 | LoRAs on the Modal Volume: chunked browser upload, per-pack settings | design §4 "LoRAs on the Modal Volume" |

Decided along the way, recorded in the design doc:
- custom workflows only on generators with the user's own nodes (MCPB, PC), not on Modal
- no general model-file uploads, and no `inventory.json`
- keep `max_containers=1` on the Modal server (appendix, "Redeploying under load")

## Shipping

- **Release:** push a tag `vX.Y.Z` on `main`. `release.yml` publishes the release with `deploy.sh`,
  its tag filled in. Tag pushes are refused from Claude Code sessions, so the user pushes the tag.
- **Installs update themselves:** the Worker's daily cron (`17 4 * * *`) reads the latest tag from
  the `github.com/<repo>/releases/latest` redirect. If it is newer than `VERSION`, the cron starts
  a Workers Build.
  - v1.0.0 installs cannot see new releases (it used the rate-limited REST API; design appendix,
    "First cron update"). They need one build started from the settings page.
- **The build:** the user's repository (a copy of `bootstrap/`) has a one-line deploy command that
  downloads `deploy.sh`. `deploy.sh` fetches the tagged source and hands over to
  `packages/worker/deploy/deploy.py`. That script:
  - deploys the Modal app when a Modal token is set
  - merges the user's Worker name into the release's `wrangler.jsonc`
  - runs `npm ci` and `wrangler deploy`
  - reports to `/build-callback`
- **Testing a branch on an install:** set the build variables `COMFY_GEN_REF` (the branch) and
  `COMFY_GEN_DEPLOY_URL` (that branch's raw `deploy.sh`), then start a build from the settings page.
  Remove both afterwards, or the install stays on the branch.
- `bash deploy.sh --dry-run` builds without deploying.

## M5: the MCPB, at parity with the old extension (Node)

The Claude Desktop extension, running a ComfyUI on the user's machine. It shares `core` with the
Worker, and shares a machine-side package with the agent (M6), so the lifecycle code is written once.

- **Machine side, ported from the old `server/` without Qt:**
  - installing ComfyUI with comfy-cli, including its environment fixes
  - GPU detection and the port-binding probe
  - starting ComfyUI, and stopping it along with its whole process tree
  - `extra_model_paths` and custom-node installs through ComfyUI-Manager
  - a download queue with state the settings page can read
  - single-instance guard, idle stop, and a tray icon
  - installing the `/comfy-gen/wait` extension (`packages/modal_app/.../comfy_node`) into the
    local ComfyUI, so waits are held there too
- **The MCPB:**
  - a stdio shim, as in the old extension: it spawns the server when `/alive` fails and keeps it
    alive
  - a local HTTP server with the `core` MCP handler at a secret path, `/alive`, the settings app,
    and `/api/*`
  - results as WebP through ComfyUI's `/view?preview=webp;90` (as the Worker does), plus the saved
    file's path
  - `Hooks`: ensure the ComfyUI process and the models are ready; resolve images by local path
  - custom workflows back on, checked against the local ComfyUI's `/object_info` (`Brain`'s
    `inventory`, `missingNodesMessage`)
  - image mode "paths"
- **Settings app:** local pages for first-run GPU choice and ComfyUI install, download progress,
  reinstall, the extra models folder, a custom workflow, and a LoRA folder.
- **Packaging:** `manifest.json`, a build script, and the launcher pointed at this repository.
- **Where:** the scaffold, and whatever can be tested against a CPU ComfyUI, is done here. The
  Windows, GPU and Claude Desktop finishing is done on the user's PC.

## M6: agent and relay, then retirement

- **Worker side, done here:** the Relay Durable Object (hibernating WebSocket, measured in S6)
  carrying `Response`-shaped messages, a `RelayTransport` for `core`, and pairing. Tested against a
  stand-in agent through `wrangler dev`.
  - The agent reconnects at once after a drop.
  - The Worker waits a few seconds for it before failing a call (S6: drops every few minutes to few
    hours).
- **Agent, done locally:** the M5 machine side, plus the relay client (WebSocket, pairing secret,
  its own User-Agent), plus the tray. It starts at boot.
  - It reports its node inventory live, for custom workflows.
- **Choosing a generator:** if both the PC and Modal are configured, the PC is used when it is
  online and Modal otherwise.
- **Last:** a final "install the new version" commit to the old repository, then archive it (never
  delete it).

## Verification

- **Every change:** `npm run typecheck`, `npm test` and `uv run pytest` (CI also runs Python 3.14,
  the web dist check and the pack-model check).
- **Worker changes:** a build on the test install through the branch variables; Worker CPU read
  from Workers Logs (`cpuTimeMs`) when a change could move it.
- **M5:** on the user's Windows PC, with the MCPB in Claude Desktop.
- **M6:** on the same PC, with the agent generating from claude.ai mobile.

## Left for the user

- Rotate the Cloudflare and Modal tokens used during development.
