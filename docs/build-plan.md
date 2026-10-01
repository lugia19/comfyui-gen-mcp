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

## Next: from the from-scratch test (2026-09-30)

- **Settings per backend, then back to one.** 2026-09-30: first split into Settings [Local] and
  Settings [Modal] (the test install had three LoRA places and two model lists on one page, and a
  LoRA uploaded to Modal configured for a pack the PC runs without it). Reverted the same day
  (design §5): Claude sees one tool list, so two configs needed a "keep them in sync by hand"
  warning; only the files differ per backend. Now one Settings page and one config, with a models
  list and a LoRA list that show each backend's state, `pc_keep_warm_minutes` as the one
  per-backend setting, and the agent copying LoRAs between the PC and Modal (design §9, "LoRA
  sync"). Kept from the split: one LoRA section by file, and the `@` in pre-filled triggers.
- **v1.3.10 loose ends.** Done 2026-10-01: the Setup tab refreshes when opened, and a PC that has
  connected before shows "Offline … reconnects by itself" with the pairing steps folded away,
  instead of the first-pairing view (`setup.pc_seen`, cleared on unpair or a new link). The site
  has a tab icon.
- **v1.3.9 test report fixes; a blue accent; a Modal command field.** Done 2026-10-01:
  - Ending the agent and starting it again within about 3 s left none running: the new one gave
    up on the taken port while the old one was still stopping. It now waits up to 6 s for the
    port, and the old one notices its launcher is gone within 2 s.
  - One offline note instead of two after a save; a file already on the PC logs "using that
    copy", not "copying"; a failed Modal redeploy no longer shows the step ticked.
  - The accent is blue (#2563eb, #60a5fa dark), on the pages, the site and the favicon.
  - The Modal step has a "Modal command" field that fills the token ID and secret; the ID field
    takes only the ID.
- **v1.3.7 test report: pause from the page, and fixes.** Done 2026-10-01:
  - Pause and Resume on the Worker's Setup page, as a control op to the agent (design §9); the tray
    and the page share one flag; a pause ends with an agent restart, and both say so.
  - Editing a PC image while Modal was cold failed at once ("Upload to ComfyUI failed (HTTP
    503)"): uploads now wait out a cold start, as submit and view do.
  - The LoRA list and the PC's status follow the PC without a reload (every 20 s while paired).
  - The offline note after a save is quiet (`notes`), not a red warning.
  - Uploading a LoRA the PC already had no longer downloads it again (same name and size).
  - The agent logs LoRA deletes; the PC step's summary names the OS; texts fixed.
  - Update now never came back after one update: a finished update build counted as running
    while it was still the latest build. The Worker now asks Cloudflare whether it is still
    running (once; a stopped build is recorded).
- **v1.3.5 test report fixes.** Done 2026-09-30:
  - A PC image's link and edits failed once keep-warm had stopped ComfyUI: `/view` is served from
    disk (design §9).
  - Ending the launcher left the agent running: the agent ends with it (design §9).
  - With the PC offline, the LoRA list showed "PC ?" on every row and a red error contradicting
    the save's note: it shows "offline", with one note.
  - Suggested triggers drop training suffixes (`huke-step00000900` → `@huke`).
  - Delete says "Deleting…"; the Setup page names the GPU and OS (not `nvidia`, `win32`).
  - The agent logs why it stops, uncaught errors, its exit code, and each LoRA copy's end.
- **A failed Modal deploy says why.** Done 2026-09-30: an account with no card made `modal deploy`
  fail ("Please add a payment method to use L4 GPU functions."), while the build carried on and the
  page showed nothing. Now the reason reaches the Modal step, a card is the first instruction, and
  Try again reuses the stored token (design §6).
- **LoRAs: one way in.** Done 2026-09-30 (design §4): every LoRA comes through Upload LoRA; no
  "drop it in the folder and Refresh". With Modal the upload goes to the Volume and the agent copies
  it to the PC; with a PC alone it goes to the agent through the Worker's relay; the extension
  takes it on its own page. Only LoRAs that came in this way are listed or synced (a registry on
  the machine), never others in a PC's ComfyUI folders. Delete removes one everywhere.
- **Agent page: an "Edit settings" button.** Done 2026-09-30: it opens the Worker's
  `#settings`. The agent's page says "Model and style settings
  are on the Worker's page" in small text with a bare link. Make it a prominent **Edit main
  settings** button that opens the Worker's settings.
- **Remove custom workflows.** Done 2026-09-30 (design §3, "Custom workflows (removed)"). Decided 2026-09-30: `generate_custom_image` goes. It is barely
  documented, it threads through every layer (the config field, `parseCustomWorkflow`'s guessing of
  prompt node and samplers, `customPack` in `brain.ts`, the node-inventory check and the relay's
  `inventory` operation, its tool spec, `CustomWorkflow.svelte` and its Worker and MCPB routes, the
  Modal exclusion and the PC-offline answer), and it cannot be tested beyond a few workflows, since
  it takes any graph with any nodes. People with their own workflows already run ComfyUI, and can
  point the agent at it ("Your own ComfyUI"). Removing it first also shrinks the settings split and
  the image-id fix. A `custom_workflow` already stored in the State DO is ignored on read (not
  pinned by `test/golden.json`, so no migration). Do it before those two.
- **Image ids collide between the PC and Modal.** Done 2026-09-30 (design §4): the PC's ids add
  `"pc"`, the main generator's keep the old format, `golden.json` pins both. An id is a signed `[type, subfolder, filename]`
  (`refs.ts`) with no backend in it, and each ComfyUI numbers its outputs from
  `comfy-gen_00001_.png`. On the test install the PC's first image (a fox) got exactly the id of
  Modal's first image (a girl by a window), and that id's `/img/` address then served the fox.
  An edit by `image_id` of an older image can silently edit a different one. The id needs the
  backend in it (or unique output names per backend); ids are a stored format pinned by
  `test/golden.json`, so this needs a migration that keeps old ids resolving to Modal.
- **Tray tooltip shows actions in progress.** Done 2026-09-30 (the status item and tooltip say
  "starting…" or "stopping…" at once). When Start or Stop ComfyUI is requested, the tooltip
  should say "Starting…" or "Stopping…" right away, not keep the old state until the action is done.
- **Agent tray: a Stop option for serving.** Done 2026-09-30 (design §9, "Pause"; not saved across
  restarts). Sometimes the PC should not answer image requests at
  all (gaming, say). The tray menu needs a toggle that stops the agent taking requests without
  quitting it, so Modal answers (or, PC-only, the tools say the PC is paused); the Worker's page
  should show it as paused rather than offline.
- **"Models on your PC" goes stale.** Done 2026-09-30 (both lists back off from 5 s to 5 minutes);
  its `cpuTimeMs` is still to be read on the next live test. `Models.svelte` re-checks only while a pack is queued or
  downloading, and for the PC "Not downloaded" is not busy, so a page opened with every PC model
  missing checks once and stops. Downloads a tool call starts (the first image asks for its model)
  then never show until a reload. Keep checking the PC list while Settings is open, backing off
  as checks go unanswered: each one that finds nothing new or gets no reply from the PC waits
  longer before the next (say 5 s doubling up to a few minutes), and any change resets it to 5 s.
  The Modal list gets the same backoff: it now re-checks every 5 s for as long as a pack is
  missing or unknown. Each check is a Worker round trip (to the PC or to Modal), so read its
  `cpuTimeMs`.
- **`edit_image` output size.** Done 2026-09-30: the description was right, the code was not. An
  input given by `image_id` resolved without a size, so the edit graph's scale node fell back to
  the pack's whole budget (4 MP) and upscaled it. The Worker now reads the size from a quality-1
  WebP of the image (`/view?preview=webp;1`, a few KB). Its description says the result "comes back at the resolution it
  went in at" unless the input is very large. On Modal with Flux 2 Klein 4B (Edit), a 768×768 upload
  came back 2048×2048 and a 1152×896 generation came back 2320×1808: small inputs are scaled up.
  Either keep the input size or change the description.

## Verification

- **Every change:** `npm run typecheck`, `npm test` and `uv run pytest` (CI also runs Python 3.14,
  the web dist check and the pack-model check).
- **Worker changes:** a build on the test install through the branch variables; Worker CPU read
  from Workers Logs (`cpuTimeMs`) when a change could move it.
- **M5:** on the user's Windows PC, with the MCPB in Claude Desktop.
- **M6:** on the same PC, with the agent generating from claude.ai mobile.

## Left for the user

- Rotate the Cloudflare and Modal tokens used during development.
