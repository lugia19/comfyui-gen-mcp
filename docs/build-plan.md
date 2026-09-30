# Comfy-Gen-MCP: build plan

What is built, how it ships, and what comes next. `docs/design.md` holds the design and the measured
results behind it; this file only tracks the work.

**Status (2026-09-30):** M0–M5 are built. v1.0.0 (M3) and v1.1.0 (M4) are released; M5 passed the
user's Windows test and goes out as v1.2.0. M6 (agent, relay, launcher) is built and tested here
and on the test install; a release and the user's PC test are left.

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

- **Release:** push a tag `vX.Y.Z` on `main`. `release.yml` publishes the release: `deploy.sh`
  with its tag filled in, `comfy-gen.mjs`, the `.mcpb` and the three launchers. Tag pushes are refused from Claude Code sessions, so the user pushes the tag.
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
   - paths (`~/.comfy-gen-mcp`), the config file (not migrated from the old extension)
   - GPU detection; ComfyUI installed with a pinned uv, no comfy-cli (design §11); reuse of an old
     install
   - starting ComfyUI on a probed port, stopping it with its process tree, idle stop
   - the `/comfy-gen/wait` extension written into `custom_nodes`, pack nodes from the Comfy Registry
   - other ComfyUI installs' model folders found and shared through `extra_model_paths.yaml`, and
     the `~/.comfy-registry` shared with Visual-Novelist
   - the model download queue, started for the selected packs at once, with state the settings
     page reads
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
   update; the tray icon. `release.yml` builds the bundle and the `.mcpb`.

**Checked here:** a fresh install and a reinstall through `local` and through the settings page;
generations, edits by path and missing nodes through the MCP route; several extension processes
relaying to one owner, takeover after a SIGKILL, ComfyUI exiting with its owner, the shim's
background update from a fake release server.

**Checked on the user's PC (Windows 10, NVIDIA, Claude Desktop, 2026-09-30), v1.1.2:** install and
startup, the tray, loopback-only settings (403 from every LAN, VPN and Tailscale address), model
discovery, every tool (cold illustrated 37 s, warm 16 s), edits by path, file, URL and two images,
keep-warm, restart and stop, custom workflows, relays, takeover (150 to 180 ms), quitting Claude
Desktop (ComfyUI, tray and port gone in under a second), the watchdog after a hard kill (6 s), a
foreign port owner. Claude Desktop runs the shim in its own Node (a `claude.exe` utility process),
not `node.exe`. Fixed after it: a blank settings page with a multi-section extra_model_paths.yaml,
the newer Comfy Desktop's installs, junction duplicates, the watchdog's missing log line, and
smaller points in the report.

**Left for M5:**
- **Fresh install on the user's PC (todo):** move `~/.comfy-gen-mcp` aside, then from Claude
  Desktop: red tray, install for NVIDIA from the settings page (time it, note the CUDA wheels),
  shared model folders found again, a pack variant that is nowhere on disk downloads at once with
  progress, the first generation installs ComfyUI-GGUF from the Comfy Registry. The shared model
  folders stay untouched: they are what discovery is for.
- **Release:** a Worker build of the branch on the test install first (the Worker's render moved
  into core), then the tag (the user pushes it). The release carries the bundle and the
  `.mcpb`; installed extensions pick the bundle up within a day.

## M6: agent and relay, then retirement

Built (design §2 "The agent's launcher", §6 "GPU owner", §9 "As built"):

- **Worker:** the Relay Durable Object, `RelayTransport`, `GET /agent` with the pairing secret,
  pairing and unpairing, the generator chosen per call (PC, then Modal), `PcHooks.ensure` over the
  relay, custom workflows checked against the PC's inventory, `/api/pc/*` for the settings page.
- **Machine side in `local`:** the settings API routes, pack readiness and the tray, shared by the
  MCPB and the agent.
- **Agent** (`packages/agent`): relay client, control operations, `agent.json`, its settings page
  (machine setup plus pairing), restart into a downloaded update when idle.
- **Launcher** (`packages/launcher`, Go): installs itself and the login entry, fetches the pinned
  Node, runs the shim in agent mode and supervises it. `release.yml` publishes six files: `deploy.sh`,
  the one bundle (`comfy-gen.mjs`, both programs), the `.mcpb` and three launchers, under a
  download table.

Tested here: `wrangler dev` plus the agent plus a CPU ComfyUI (pairing; relayed generation, 11 s
cold and 0.3 s warm; a 3 MB image both ways; the agent killed mid-call, then restarted; offline
after 10 s), the settings pages in Chromium, and the Linux launcher (Node download and checksum,
agent start, update from a stand-in release server and restart into it).

Then live on the test install through a branch build (design appendix, "M6 live"): relayed
generation, 3 MB both ways, Worker CPU as on the Modal path, offline answer, Durable Object cost.

Left:
- A release (the launcher binaries exist only in releases).
- **On the user's PC**, from a release: the launcher (SmartScreen, install, start at login after a
  reboot), pairing, generation from claude.ai mobile, the PC off (Modal answers), the PC back.
- **Last:** a final "install the new version" commit to the old repository, then archive it (never
  delete it).

## Next: setup guides

Decided 2026-09-30: the install stays the Deploy button with GitHub and Workers Builds. Its update
path, a full redeploy by wrangler in a fresh build that also redeploys Modal, is worth the one-time
friction. A hosted setup service was weighed and set aside; the reasoning is below. The friction gets
guides instead, after the user's from-scratch test, whose screenshots they illustrate:

- **Landing page, below the Deploy button:** the button opens Cloudflare in a new tab. Clicking it
  reveals a guide, with screenshots, to finding the Worker's address once the deploy finishes: the
  banner at the end of the build log, or the Worker's page in the dashboard.
- **Landing page:** a guide to linking GitHub with Cloudflare, which happens inside the Deploy
  page.
- **Worker page, the Modal step:** a guide to setting up a Modal account (sign-up, a card on file,
  creating the token).

Built 2026-09-30: the three guides are in place (`site/index.html`, the Modal step in
`web/src/lib/Setup.svelte`), with screenshots in `site/guide/`: `github-connect`, `deploy-form`,
`build-log`, `build-done`, `worker-visit`, `cf-token-form`, `cf-token-summary` (the login step),
`modal-signup`, `modal-billing`, `modal-tokens`,
`modal-token-created` (PNG, redacted). The Worker page loads its Modal images from the published
site, so they appear once `main` has them. The GitHub app install got no screenshot: it is one
Install click. Names checked against the real screens the same day (Cloudflare's button is
**Deploy**, the list entry **New GitHub connection**; Modal's menus are **Usage & billing** and **API
tokens & service users**). Modal shows a new token only inside a `modal token set` command, so the
token ID box also accepts that whole command and splits it.

**Hosted setup, set aside.** A service that takes the user's tokens and does the whole setup
(Cloudflare's API from a server, since the API refuses browser calls; Cloudflare OAuth exists since
2026-06, Modal's is not open to third parties) would drop GitHub and fit on one page. But without
Workers Builds, which only builds from a GitHub, GitLab or Cursor Origin repository connected
through the user's own app install, updates would need a new mechanism: the Worker uploading
itself, and a Modal updater in the user's workspace (which could run deploy.sh itself), plus a third
path for PC-only users. Revisit if users get stuck at the GitHub step specifically.

## Verification

- **Every change:** `npm run typecheck`, `npm test` and `uv run pytest` (CI also runs Python 3.14,
  the web dist check and the pack-model check).
- **Worker changes:** a build on the test install through the branch variables; Worker CPU read
  from Workers Logs (`cpuTimeMs`) when a change could move it.
- **M5:** on the user's Windows PC, with the MCPB in Claude Desktop.
- **M6:** on the same PC, with the agent generating from claude.ai mobile.

## Left for the user

- Rotate the Cloudflare and Modal tokens used during development.
