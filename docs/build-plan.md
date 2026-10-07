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
`web/src/lib/Setup.svelte`), with screenshots in `site/guide/`; since replaced by the walkthroughs
(below). Names checked against the real screens the same day (Cloudflare's button is
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
- **Password login.** Done 2026-10-01 (design §8): required right after the first token login;
  then the login screen asks for it, with the token as the fallback; 10 wrong in an hour pause it.
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
- **A cold first call timed out in Claude Code.** Done 2026-10-01 (design §3, "Waiting"): the 240 s
  wait counted from after a cold-start submit, which can itself take minutes, so the call passed
  the client's 300 s. Now one budget per call covers the cold-start retries and the wait; the call
  returns a `fetch_result` token or "still starting" in time.
- **The extension, before its first test since v1.2.0.** Done 2026-10-01: LoRAs configured before
  "one way in" are adopted (they showed as missing, and every save warned falsely); with "Your own
  ComfyUI" LoRAs are added by name; start-up answers within the call's budget; keep-warm no longer
  stops ComfyUI under a queued generation. A v1.2.0 extension can't update itself (the release
  assets were renamed): it is reinstalled by hand once.
- **Shorter image ids.** Done 2026-10-01 (design §4): a model mistyped a 70-character id. Images
  this app names get the id `m7.Ab3d` (a 4-character check, so a shared connector doesn't expose the
  owner's images by number; `p7.…` on the PC, `mupAbCd1234.…` for an upload); the public `/img/`
  link carries 12. JSON ids still verify.

## R2 and a list of GPUs (decided 2026-10-01; built, awaiting a live check)

One milestone, as the two need each other (design §2 "GPUs", §4, §9):
- **Spike** (appendix): streaming through the R2 binding costs the Worker 0 to 1 ms of CPU, so
  every transfer streams through it with Worker-signed links (`/store/<token>`); no S3 keys.
  `wrangler deploy` creates a missing bucket; `deploy.py` sets the expiry rules.
- **Images in R2:** outputs stored as WebP (`img/<id>`, an id of 8 random base62 characters,
  expiring after a year), uploads the same; links and edits work with every GPU off. `:lossless`
  is gone.
- **LoRAs in R2:** uploaded in 8 MiB multipart chunks checked by MD5, copied to Modal
  (`/loras/fetch`) and to each PC (the agent's sync plan); deleted everywhere with a tombstone for
  PCs that were offline.
- **The GPU list:** `secrets.gpus` in priority order, any number of PCs (each its own secret and
  relay object), Modal added by its deploy, a ComfyUI by URL; routing by availability and pack
  readiness, with a hand-off when a GPU is downloading; `fetch_result` tokens name their GPU;
  keep-warm per GPU. The Setup page lists the GPUs (order, rename, enable, keep-warm, pause, new
  link, remove); Models and LoRAs show a column per GPU.
- **No upgrade path:** only two installs exist; both enable R2 by hand before updating. Old image
  ids stop resolving.

Done on the test install (2026-10-01): a branch build created the bucket inside Workers Builds and
set both rules; `/img/`, `/store/` and `/agent` answer as designed.

Still to do:
- ~~the live run~~ done 2026-10-01 (design appendix): fixed from its report: untriggered LoRAs
  leave the workflow, a deleted LoRA leaves the settings, a call's budget is 150 s (a connector
  from Claude Code gives up at about 183 s), `HEAD /img/`, no self-update on a branch build, Anima
  asks for prompts of at least 10 tags, and wording
- ~~itemize the warm generation's CPU~~ done (design appendix): no regression, the sum of image,
  relay calls and State reads; one State read cut
- ~~what the Deploy button does with the binding on a fresh install~~ done 2026-10-02: a fresh
  account's Deploy-button run with another tester worked
- **The Worker reports what the user must do on another site** (decided 2026-10-01): card
  steps (R2's checkout, Modal's billing) cannot be automated, OAuth or not. So the site lists them
  first, with direct links, and the Worker recognises each when it fails and says which step is
  missing, with its link: a build that fails because R2 is not enabled says "R2 isn't enabled
  yet" on the setup page instead of a raw build error, and likewise for Modal billing.
- **Setup guidance on the site** (noted 2026-10-02, for later):
  - connecting GitHub to Cloudflare: clearer steps, ideally a direct button to Cloudflare's
    GitHub connection page
  - enabling R2 on the account: a collapsible section walking through it (the checkout step
    included)
  - avoiding charges: Modal's workspace spending limit; Cloudflare has no hard cap, so say what
    it costs (on the free Workers plan, R2's reads and writes stay inside the free allowance, as
    every one goes through the Worker's 100,000 requests a day; only storage past 10 GB bills, at
    cents) and suggest a billing notification. A cap enforced by the Worker was judged not worth it
- **Cancelling images** (looked into 2026-10-03, not doing): a cancelled call still renders. The
  MCP spec's cancel (`notifications/cancelled`) is optional. claude.ai sent none in a test (the
  cancelled request ran to completion in the Worker's logs), and honouring one would mean issuing
  `MCP-Session-Id`s to tell sessions apart. Revisit if a client starts sending cancels: the Worker
  would map the request to its ComfyUI prompt, then drop it from the queue (`POST /queue
  {"delete": […]}`) or `/interrupt` it.

## macOS test (2026-10-02, v1.6.3 on an 8 GB M1)

Everything ran; images work on MPS but swap on 8 GB (51 min for a 30-step Anima image). Fixed:
- **The launcher on macOS hands the agent to launchd** (design §2): no Terminal window to close by
  mistake, and the LaunchAgent re-registered at each manual start, so launchd takes an updated
  binary (it refused one with `OS_REASON_CODESIGNING`). Confirmed working on the Mac (v1.6.4 recheck: all nine steps pass,
  and the updated binary starts at login). From the recheck: the agent's first update check, at
  login, often runs before the network is up, so it retries once a minute later.
- **The tray helper is started again** when it ends by itself (at most five times an hour); a write
  to a gone helper no longer crashes the agent (EPIPE).
- **No privacy prompts at login:** the Mac's model search skips Desktop, Documents, Downloads and
  the media folders.
- **The extension:** models download at first use or when chosen, not all up front (22 GB); it
  listens on 127.0.0.1 unless the user lets other computers in (Connect Claude → Advanced).
- **A new PC goes after the other PCs**, not first. The agent logs to `agent.log`. A Mac under 16 GB
  gets a memory warning on the page. Gatekeeper's way through (Open Anyway) is in the release notes
  and the pairing steps. Wording and the folder example fixed.

Not changed: the extension's several start-up processes (harmless now that none downloads at
start), the two identical menu bar icons, the shared ComfyUI database when the agent and the
extension both run (discouraged), and the Worker flagging models larger than a PC's memory (later).

## Linux test (2026-10-02, v1.6.5 in WSL2 with an RTX 4080)

Everything Linux-specific passed: the launcher, Node, ComfyUI on CUDA, pairing, generating, Ctrl+C
and a hard kill, and a newer launcher taking over; the extension too, in Claude Desktop for Linux.
Fixed:
- The launcher prints its progress (setting up Node) and the page's address in its terminal; a
  browser that can't be opened (no `xdg-open`) is logged with the address.
- Clearer second-run log lines, and a clearer "turned away" state on the agent's page, now logged.
- The agent's Models list shows models by their names, not their ids.
- "Never both": the Worker's, the agent's and the extension's pages say not to run the agent and
  the extension on one PC (two ComfyUIs filled a 16 GB GPU).
- A cut model download starts over, and its `.part` file goes; no resuming.
- ComfyUI checks for its parent every second, not every 5 s: on Linux, Claude Desktop ends the
  extension without a signal it can catch, so that is how its ComfyUI stops.

Open: no tray on stock Ubuntu 24.04 (systray2's helper needs `libappindicator3.so.1`): fixed by
our own tray helper (below). The claude.ai calls the tester saw end in "The operation timed out." at about 60 s (the
Worker answered them all, 76 to 151 s) were a transient error on claude.ai's side: retested,
claude.ai waits well past 60 s.

## Pack cleanup and LoRA groups (2026-10-02/03)

Making a model easier to add, and LoRAs a group of models' own. Each step its own commit:
- **Tools described once** (`packs/tools.json`: title, routing line, default guide) and a short
  `prompt_guide` per pack; `family` replaces `config_key`.
- **LoRA groups:** a LoRA belongs to one group (`lora_group` on packs; Anima's is `anima`, the
  stored key), with an on/off flag; one without a group joins the default switched off; the
  settings page has a tab per group, uploads into the open tab, and Move to. Checked in Chromium
  with a throwaway second group.
- **Nodes by title** (`cg:prompt`, `cg:seed`, `cg:size`, `cg:width`/`cg:height`, `cg:model`,
  `cg:image…`) in place of node-id fields; the two-image edit built in code (`withImages`) in
  place of `workflow_multi`. Every rendered workflow is the same graph as before (21 scenarios).
- **Models stay explicit**: a test that every file a workflow names is listed, and
  `scripts/fill_pack_models.py` for sizes and hashes. `docs/adding-a-model.md` has the steps.

To check live before the release: one image per tool, and a two-image edit, on a PC and on Modal.

## Our own tray helper (2026-10-03)

systray2's helpers were a dead end: Linux's links `libappindicator3` (gone from Ubuntu 24.04), and
the Mac's is Intel-only (Rosetta, which Apple cuts back from macOS 28). `packages/tray` replaces
them on all three platforms: Go on fyne.io/systray, speaking the JSON lines `tray.ts` already spoke.
Linux and Windows cross-compile with the launchers; a `macos-latest` release job builds the Mac's
(cgo). All three go in one release asset, `comfy-gen-tray.tgz` (7 files, not 9); the bundle
downloads its own release's archive and extracts its helper, each checked against a hash built into
it.
Checked here on a private D-Bus session with a stub watcher (the menu, greyed items, the separator,
updates and clicks), then in a real xfce4-panel on Xvfb, with screenshots: the icon, the menu, and
Pause agent through it. Plain GNOME shows no tray without the AppIndicator extension (release
notes).

v1.8.1: the xfce run showed the login race (the agent up before the panel's tray), where v1.8.0's
helper gave up at once and left no icon until a restart. It now waits for a tray (fyne registers
when one appears) and ends only without a D-Bus session; checked with the agent started 6 s before
the panel.

To check live: the tray on Windows and the Mac, and on a Linux desktop (KDE or Ubuntu).

## Guided setup: one stepper, storage as a step (2026-10-03)

The setup site was a wall of instructions with a trap ("turn R2 on before the deploy"); the
Worker's page started from a generic GPU list. Now (design §6):
- **The site** asks how you'll use it (claude.ai, recommended; Claude Desktop only), then where
  images are made (the cloud, recommended for most; my PC; both), and shows only that answer's
  steps. Connecting GitHub to Cloudflare gets GitHub's install page as a button, with the deploy
  page's way as the fallback. A What it costs section, with Cloudflare's budget alert and Modal's
  Workspace budget.
- **The answer reaches the Worker** through `bootstrap-<answer>/`: the template with
  `SETUP_MODE`, which the build carries over. No question twice.
- **Storage is a Worker step.** The build checks R2 and deploys without the bucket when it's off;
  the Worker runs without storage and its page has the step, whose Check again rebuilds.
- **The Worker's page:** Log in → Turn on storage → Where should images be made? → that answer's
  steps → Connect Claude. Existing installs infer their answer from their GPUs.

Checked here: pytest and vitest (no storage, the answer's order, Check again), the pages in
Chromium (both, with every path, phone width and no JavaScript).

To check live:
- the test install: a branch build stays as is; with `COMFY_GEN_TEST_NO_STORAGE=1` the storage step
  shows; Check again without it brings storage back, images and LoRAs intact
- a fresh account: the whole flow, including how the deploy form shows `SETUP_MODE` (if hidden or
  awkward, the fallback is pasting the Worker's address into the site, which opens it with
  `?setup=`), the GitHub install button, and R2's checkout
- the screenshots in `site/guide/README.md`, with highlights

## Verification

- **Every change:** `npm run typecheck`, `npm test` and `uv run pytest` (CI also runs Python 3.14,
  the web dist check and the pack-model check).
- **Worker changes:** a build on the test install through the branch variables; Worker CPU read
  from Workers Logs (`cpuTimeMs`) when a change could move it.
- **M5:** on the user's Windows PC, with the MCPB in Claude Desktop.
- **M6:** on the same PC, with the agent generating from claude.ai mobile.

## Left for the user

- Rotate the Cloudflare and Modal tokens used during development.

## The v1.9.0 dry run (2026-10-03)

A local Claude Code walked the whole setup on a new Cloudflare account (claude.ai, Both), to a first
image from the PC: everything worked end to end. Fixed after it:
- **Connecting GitHub:** the site's GitHub-side install never linked the Cloudflare account. The
  Deploy step now does it the way that worked (design §6), with the uninstall fallback.
- **The build log** in Cloudflare's dashboard stops early: the site says reload and **Visit**.
- **Moved or renamed elsewhere:** claude.ai's connectors (Customize → Connectors, Add custom
  connector, No sign-in, Connect, Always allow; Disconnect/Connect if tools go missing); Modal's
  Workspace budget is now Usage limit → Spend limit; R2's button is **Add R2 subscription to my
  account**; Cloudflare makes a $10 budget alert by itself.
- **The agent** restarts into an update at once when ComfyUI hasn't been used since it started
  (it showed the old version for 11 minutes after a newer launcher started it).
- **Smaller:** a paused PC says so in its step; tab titles tell the three pages apart (Comfy-Gen
  setup / Worker / agent / extension); real wait times on the build logs; a line that pairing copies
  the PC's LoRAs into storage; no costs on the Desktop-only path; the Worker's state field is
  `setup_mode` (`mode` already tells the agent and extension pages apart).

Its screenshots (71) are the source for the walkthroughs, after blurring.

## Walkthroughs (2026-10-03)

The external steps are step-by-step guides: a screenshot with numbered markers, Next showing one
step at a time (earlier ones grey, the current one red) and moving on to the next screenshot, Back
going back. Twelve, from the dry run's screenshots: on the site, `deploy` and `open-worker`; on the
Worker's page, `cf-token` (log in), `r2` and `cf-budget` (storage), `modal-billing`, `modal-token`
and `modal-limit`, `claude-connector` and `claude-chat`, `agent-pair` and `agent-run` (the PC). The
macOS views of `agent-run` are placeholders until a Mac's screenshots exist; Windows SmartScreen
stays one line of text. Format and upkeep: `site/guide/README.md`. Account sign-ups stay plain links.


## Later: spill-over between GPUs (parked 2026-10-04)

Today a call goes to the first GPU that is online, not paused and has the model ready (`App.pick`);
how busy it is never counts. A second call waits in that ComfyUI's queue and, past 150 s, comes
back Pending. The idea: busy GPUs hand new calls on, from the PC to Modal, then to more Modal.

- **Spill-over:** per GPU, "pass new images on when more than N are waiting" (default off). `pick`
  reads the candidate's `GET /queue` (`queue_running` + `queue_pending`): through the relay for a
  PC. A cold Modal server answers 503 at once, which counts as an empty queue: the call goes there.
- **More Modal as separate Modal apps,** each `max_containers=1` and each one more GPU entry with
  its own URL, routed as above. One container per app keeps every request of a job on the
  container that runs it (the 2026-09-29 failure, design appendix "Redeploying under load"). The
  apps share the `comfy-gen-data` Volume, so models are stored once; an update deploys each.
- **Sticky sessions (Modal, seen 2026-10-07), the better route for more Modal:** the Worker starts
  a session per job (`POST <server>/_modal/sessions/start` with the proxy token returns a session
  token), sends every request of that job with `Modal-Authorization: Bearer <token>`, which keeps
  them on one container, then ends it (`/_modal/sessions/terminate`). On an `@app.server` with
  `@modal.sessioned()`, `max_concurrency` / `target_concurrency` count sessions, so one job per
  session spreads jobs over containers up to `max_containers`, and a session start waits up to
  5 min for capacity instead of a 503. Shape (decided 2026-10-07): app 0 itself becomes the
  sessioned app, with up to N containers; no second app. The extra containers idle for the same
  keep-warm as the first (keep-warm is per app), which is cheap: two extra L4s after a burst cost
  about $0.10–0.15 at the default 5 minutes. This replaces the separate apps and their short
  keep-warm above. To check first: `modal.sessioned` in our pinned Modal (1.5.5); the session start's auth
  (the docs show `Authorization: Bearer`, we use `Modal-Key`/`Modal-Secret`); ending sessions
  reliably (a container stays up while it hosts one; `idle_timeout` 600 s by default); a Pending
  result's `fetch_result` carrying the session token; sessions across a redeploy (undocumented);
  non-session traffic is rejected. The per-call `filename_prefix` is still needed.
- **Keep-warm:** app 0 keeps the user's time. The overflow apps exist only for going over, so they
  default to a much shorter one (1 minute, the shortest `POST /idle` takes now): a spill bills little
  more than its own job. GPU entries already have their own `keep_warm_minutes`. The Spend limit
  caps them all.
- **Output names:** two ComfyUIs writing one output folder overwrite each other's
  `comfy-gen_000NN_` files. The Worker sets the save node's `filename_prefix` per call
  (`comfy-gen/<call id>`; nodes are found by title); images go to R2 at once, so unique is enough.
- **Limits:** a PC's queue check is a relay (Durable Object) call, outside the free plan's 50
  external subrequests. A Modal app's check is one of them. A warm Modal call spends about 6–8 of
  its 44 (`REQUEST_BUDGET`), so a few checks fit. Time isn't a limit either: past 150 s a call
  returns Pending and `fetch_result` picks it up, with a fresh budget. Spilling is about getting the
  image sooner. Spilling to a cold app pays only when the line is longer than a cold start (about
  44 s plus the model load).

## Later: encrypt new images in R2 (jotted 2026-10-06)

A setting that stores new images encrypted, so they aren't kept in R2 in a readable form
(automated scanning and the like). Not secrecy from the account's owner: the key sits in the same
account.

- **Where:** every image read and write is in `packages/worker/src/images.ts` (`putImage`,
  `getImage`, `serveImage`).
- **Key:** one random AES-256 key, made the first time the setting is turned on and kept in the
  State DO under a new key (a compatibility surface). Never rotated or deleted: losing it loses the
  encrypted images.
- **Write:** with the setting on, `putImage` encrypts with AES-GCM through `crypto.subtle` (native,
  no JS loop over image bytes) and stores `application/octet-stream`, with `customMetadata` holding
  a version mark, the IV and the real content type.
- **Read:** `getImage` and `serveImage` decrypt when the mark is there; unmarked images read as
  today. So the setting applies to new images only, and turning it off keeps old ones readable.
  `/img/<id>` buffers instead of streaming (fine at a few hundred KB). `/img` answers are already
  `Cache-Control: private`, so Cloudflare's cache keeps no decrypted copy.
- **Scope:** images only (outputs and edit uploads under `img/`). LoRAs stay plain: Modal and the
  agent download them from R2 through signed URLs. ComfyUI's own output and input folders, on
  Modal's Volume and on the PC, are outside it.
- **Check:** CPU per call from Workers Logs (`cpuTimeMs`) with the setting on.
