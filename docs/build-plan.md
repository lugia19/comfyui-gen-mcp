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

## M5: the MCPB for Claude Desktop (Node)

The Claude Desktop extension, running a ComfyUI on the user's machine; design §2, "The MCPB
process". It shares `core` with the Worker, and the machine side (`packages/local`) with the agent
(M6), so the lifecycle code is written once. Remote use is not its job: that is the Worker's.

1. **`packages/local`**, ported from the old `server/` without Qt:
   - paths (`~/.comfy-gen-mcp`), the config file with the old keys migrated
   - GPU detection; ComfyUI installed with a pinned uv, no comfy-cli (design §11); reuse of an old
     install
   - starting ComfyUI on a probed port, stopping it with its process tree, idle stop
   - the `/comfy-gen/wait` extension written into `custom_nodes`, pack nodes from the Comfy Registry
   - `extra_model_paths.yaml` and the `~/.comfy-registry` shared with Visual-Novelist
   - the model download queue, with state the settings page reads
2. **The server** (`packages/mcpb/src/server`), in the process that owns the port:
   - the `core` MCP handler in image mode "paths", with `LocalHooks` (ComfyUI running, nodes and
     models present; images by path or URL)
   - results as WebP through `/view?preview=webp;90`, plus the saved file's path for edits
   - custom workflows, checked against the local `/object_info` (`Brain`'s `inventory`)
   - `/alive`; the settings app and `/api/*`, loopback only
3. **The settings app** in local mode: GPU choice and install, ComfyUI status, restart and
   reinstall, the extra models folder, download progress, a custom workflow, LoRAs from the local
   folder.
4. **The shim** (the `.mcpb`): bind or relay, takeover when the owner exits, the daily bundle
   update; the tray icon. `release.yml` builds the server bundle and the `.mcpb`.

**Where:** everything that can be tested against a CPU ComfyUI is done here. Windows, the GPU and
Claude Desktop are checked on the user's PC.

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
