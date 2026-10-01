# Comfy-Gen-MCP design

Status (2026-09-30): v1.1.0 released (cloud path with LoRAs). The MCPB (M5) is tested and waits
for v1.2.0; the agent and relay (M6) are built and in testing. This document is the source of truth for the design; the appendix holds the measurements
behind it. `docs/build-plan.md` tracks the work.

Product name: Comfy-Gen-MCP. Repository: `lugia19/comfyui-gen-mcp`. The previous implementation lives
in `lugia19/comfy-gen-mcp`, in maintenance.

## 1. Goals

The current design ties reachability to the GPU box: the machine that generates is also the machine
exposed to the internet, so every mode other than "Claude Desktop, local" needs a tunnel or reverse
proxy, and the Cloudflare quick-tunnel URL changes on every restart.

The redesign moves reachability to an always-on, free host and lets the generator be wherever the
GPU is. Targets:

- **No GPU:** works from a browser only. Click a button, paste tokens, add a connector.
- **GPU owner on claude.ai or mobile:** stable URL, PC reached without a tunnel, ComfyUI only runs
  when needed.
- **Claude Desktop, local only:** no accounts, simpler than today.

## 2. Components

| Component | Runs on | Job |
|---|---|---|
| Worker | Cloudflare Worker (TypeScript), free plan | The brain. MCP endpoint, settings and setup app, image route, config in a Durable Object, cron jobs, relay mailbox |
| ComfyUI | Modal, a PC, or localhost | The generator. We ship no handler code: ComfyUI's own HTTP API is the interface |
| Modal app | User's Modal workspace | ComfyUI server on an L4, a Volume, a seed function, a small admin web endpoint |
| Agent | GPU owner's PC: a Go launcher running a Node bundle | ComfyUI install and lifecycle, model downloads, idle stop, tray, a loopback settings page; relays the Worker's ComfyUI calls to local ComfyUI (§9) |
| MCPB | Claude Desktop | A stdio shim that loads the latest bundle; one Claude Desktop process runs the local server (MCP, settings page, tray, ComfyUI lifecycle), the others relay to it |
| Static site | GitHub Pages | Prerequisites, the Deploy button, then "open your Worker" |

The agent's launcher (`packages/launcher`, Go) is the one native program: a 6 MB download per
platform (Windows x64, macOS on Apple silicon, zipped so it keeps its executable bit, and Linux x64;
an Intel Mac has no GPU worth using), unsigned (SmartScreen and Gatekeeper warn once). On each
start it:

- copies itself into `~/.comfy-gen-mcp/bin/` and registers that copy to start at login (the HKCU
  `Run` key on Windows, a LaunchAgent on macOS, an XDG autostart entry on Linux); `--uninstall`
  removes the entry
- fetches Node (an LTS pinned in `node.go`, checked against the release's SHA-256 pinned beside
  it) into `~/.comfy-gen-mcp/node/<version>/`, once
- runs the MCPB's shim, embedded, as `node shim.mjs --app agent`, hidden, and restarts it: at once
  on exit code 75 (the agent restarting into a downloaded update), after a backoff on a crash, not
  on 0 (another agent already runs; the second one opened the first one's page)
- tells the agent whether to open its settings page (started by hand: yes; at login or on a
  restart: only while unpaired)

The shim loads the same bundle as for the MCPB (`comfy-gen.mjs` holds both programs) and starts
the agent. The agent runs for days, so the shim repeats the daily check while it runs and hands a newer bundle to
the agent, which restarts into it once nothing has used ComfyUI for 10 minutes. A new launcher (a
new Node) is a new download; running it installs it over the old one.

### Modes

| Mode | Brain | Config | Generator | Settings UI |
|---|---|---|---|---|
| MCPB | local server | local JSON file | ComfyUI on localhost | localhost page |
| Worker, no GPU | Worker | State Durable Object | ComfyUI on Modal | Worker page |
| Worker, GPU | Worker | State Durable Object | ComfyUI on the PC via the agent | Worker page |

Rule: an MCPB install and a Worker install are separate; a machine uses one or the other. The MCPB
is for Claude Desktop only: it has no tunnel and no remote route, and remote use (claude.ai, mobile)
goes through a Worker, with the PC agent when the GPU is at home. The agent uses the same folder
(ComfyUI, models, uv) with its own `agent.json`; like the MCPB, one or the other per machine.

### The MCPB process

There is no separate server process. Claude Desktop may start the extension more than once (one
process per window or reload); each process tries to bind the port (9247, as in the old extension):

- The one that binds it **owns** the server, in-process: the MCP route, `/alive`, the settings page
  and `/api`, the tray icon, and the ComfyUI it starts and stops.
- The others **relay**: they forward their stdio JSON-RPC to the owner's MCP route over HTTP.
- When the owner exits, its ComfyUI is stopped with it, and the next relay to find the port free
  binds it and becomes the owner. ComfyUI starts again on the next job.
- An owner killed outright (on Windows a killed process leaves its children running) takes its
  ComfyUI down anyway: our ComfyUI extension (`comfy_node`) exits ComfyUI once the process named in
  `COMFY_GEN_PARENT_PID` is gone. Tested: ComfyUI gone within 4 s of a SIGKILL, the next message
  to a relay made it the owner.

The server binds `0.0.0.0`. The MCP route answers any client behind its secret path; the settings
page and `/api` answer loopback clients only, because they install software and change files.

The `.mcpb` holds the shim (`server/shim.mjs`) and its own release's bundle. The shim
`import()`s the newest bundle it has, shipped or cached in `~/.comfy-gen-mcp/app/<tag>/`, falling
back to an older one if it fails to load. At most once a day, in the background, it reads the latest
tag from the `github.com/<repo>/releases/latest` redirect (as the Worker's cron does) and downloads
that release's `comfy-gen.mjs` for the next start (HTTPS guards it; a length check catches a
cut-off download, and a bundle that fails to load falls back to the older one). Two
cached bundles are kept. The shim changes only when users reinstall the `.mcpb`, so everything else
lives in the bundle. The tray icon is systray2's helper binary, downloaded once, pinned by SHA-256;
where it cannot run, there is no tray and the settings URL is in the tool answers. The icon's
color is the state: green running, yellow stopped or starting, red when something needs the user
(ComfyUI failed or is not installed, a download failed).

Everything else lives in `~/.comfy-gen-mcp`, the old extension's folder: the config file
(`config.json`; the old `local_config.json` is not read, there being two users to move), the
managed ComfyUI (ours only: an install without our marker file is replaced by the next install,
which keeps its models, outputs and inputs) and its models.

**Models already on the machine are used where they are** (`local/discover.ts`), since they are
many GB. The managed ComfyUI reads, through the `extra_model_paths.yaml` written at each start:
- the user's extra models folder
- ComfyUI installs found through comfy-cli's config, the ComfyUI Desktop app's config, the newer
  Comfy Desktop app's `installations.json`, `settings.json` and `shared_model_paths.yaml`, the
  `~/.comfy-registry` entries (Visual-Novelist's too), and a shallow scan of home, Desktop,
  Documents, Downloads and each Windows drive root for folders named like ComfyUI (and installs one
  level inside them, as `ComfyUI-Installs\<name>\ComfyUI`)
- for each install found, the folders its own `extra_model_paths.yaml` names (often a big model
  drive), with ComfyUI's folder aliases (`unet` is `diffusion_models`, `clip` is `text_encoders`)

Each folder counts once, by its real path (one model drive reached through three junctions was
seen on the user's PC), and folders holding nothing but ComfyUI's placeholder files are left out.
Only what is in none of them is downloaded, into ours. The selected packs download as soon as
there is a managed ComfyUI (at start, after an install, when the selection changes), as the Worker
seeds Modal after setup; a tool whose models are still coming says how much is left. The settings
page lists the sources found.

## 3. Generation path

### One client, three transports

A single async ComfyUI client, in the shape of Visual-Novelist's `ComfyUIClient`:

- submit to `/prompt`, tolerating 502/503/504 while a scale-to-zero host boots (`cold_start_s`)
- wait for completion: one held request to `/comfy-gen/wait/<prompt_id>` where the generator has
  our ComfyUI extension (the Modal image, `packages/modal_app/.../comfy_node`), otherwise poll
  `/history` (a 404 on the wait route switches to polling); either way, detect a worker replaced
  mid-job (prompt gone from both history and queue after a 5xx)
- fetch outputs from `/view`, upload inputs to `/upload/image`
- auth headers per transport

The client speaks to ComfyUI through a small `Transport` interface (one HTTP request in, status and
body out), so the same code runs in the Worker and in Node, and the relay can carry requests as
plain data. Transports:

| Transport | How the client reaches ComfyUI |
|---|---|
| Modal | JS `fetch` from the Worker to the deployed server URL with `Modal-Key` / `Modal-Secret` proxy-token headers |
| PC | Through the Worker's Durable Object, which relays HTTP to the agent, which calls its local ComfyUI |
| MCPB | `fetch` to `http://127.0.0.1:<port>` (the same `FetchTransport` as the Worker's) |

### Brain

Packs (JSON: workflow, prompt node, seed and dimension nodes, model URLs, tool descriptions) are
resolved per tool, prompts injected, seeds randomized, dimensions computed, LoRAs spliced. This is
the old `workflow.py`, `model_pack.py` and `tool_specs.py`, ported to TypeScript with Web-platform APIs
only, plus the MCP handler.

### MCP

A hand-rolled, stateless JSON-RPC handler in `core` serves `initialize`, `ping`, `tools/list` and
`tools/call` with one JSON body per POST (no sessions, no SSE). It was written when the Worker was
Python, where the official MCP SDK cost about 2 s of CPU per fresh isolate (S1); it stays because it
is small, proven with claude.ai, and costs nothing. The Worker and the MCPB's local server both use
it; the MCPB's stdio shim may use the official TypeScript SDK.

### Waiting

`tools/call` blocks up to about 4 minutes, returning the image directly. The MCP client timeout is
5 minutes (S8; Claude Code's idle timeout for HTTP servers is the same) and a cold start plus
generation usually stays under 2. The request-token path plus `fetch_result` is the fallback. No
cold/warm status vocabulary.

The 4 minutes (`DEFAULT_WAIT_S` = 240 s) are **one budget per tool call, counted from its start**:
the client's `stopBy`. The cold-start retries of submit, uploads and `/view` stop at it as well as
at their own limit (`MODAL_COLD_START_S`), and the wait gets what is left. So a call answers within
240 s with the image, a `fetch_result` token (submitted, still running), or "The GPU is still
starting up; call the tool again in a minute" (never got to submit). Until 2026-10-01 the 240 s
counted from after the submit, so a slow cold start plus the wait passed 300 s and a tester's
Claude Code gave up with "operation timed out".

Jobs are stateless: the request token is ComfyUI's own `prompt_id` (plus a `:lossless` marker when
asked). `fetch_result` just resumes polling `/history`, so nothing is kept between requests, which
suits the Worker and survives an MCPB restart.

Our one addition to ComfyUI's API is `GET /comfy-gen/wait/<prompt_id>?timeout=S` (up to 120 s):
it holds the request until the prompt is done or S passes, and answers `done` (status and outputs,
as in `/history`), `running`, `pending` with a position, or `unknown`. It reads the queue before the
history; ComfyUI moves a finished job between the two under one lock, so no finished job reads as
unknown. The client holds each wait for 50 s (Modal's proxy held a 50 s request, tested
2026-09-28; Cloudflare may drop a response slower than 100 s). The PC agent (M6) serves the same
route from its side of the relay.

A 250 s blocking call through a deployed Worker works (tested 2026-09-28). What limits the wait is
the free plan's **50 external subrequests per invocation** (plus 1,000 to Cloudflare services such
as KV and Durable Objects), with no reset over time. So the client waits with held requests
where it can and otherwise polls on a backoff (1, 1, 2, 2, 3, 5, 5, 8 s, then every 10 s), retries
a cold start every 5 s (a Modal server with no container answers 503 at once: requests don't
queue), and carries a request budget: when
only the requests needed for the result image are left, it stops and returns a `fetch_result` token,
and the next call starts with a fresh budget. A cold Modal start plus a long generation fits in
about 42 requests. The relay path (Worker to Durable Object) counts against the 1,000 limit.

### Worker CPU budget

The free plan's limit is 10 ms of CPU per request, with some tolerance for occasional overruns
("if your Worker starts hitting the limit consistently, its execution will be terminated").
Waiting on the network is not billed.

The Worker was Python first, and that failed this budget: a Python Worker bills about 10 ms per
request before any of our code runs, plus about 0.24 ms per JS await and 1.8 ms per fetch, so every
request sat at the limit and a generation cost 60 to 160 ms (appendix). In TypeScript a fetch costs about
0.25 ms and a Durable Object call about 0.4 ms; what cost most was base64 in JavaScript, 55 ms per
MB, replaced by the native `Uint8Array.toBase64` at about 3 ms per MB (appendix, "Where a TypeScript
generation's CPU went"). Measured on the test install: ping, tools/list and the settings API cost 1
to 2 ms. A warm generation is about 5 to 6 ms of work (itemized in the appendix, "Itemizing a warm
generation"), billed anywhere from 5 to 18 ms per call, median 7 to 11 depending on the run; a cold
one 17 to 19 ms, an edit 9 ms. Generations are the rare, tolerated overrun. Rules for Worker code:

- base64 with `toBase64` from `bytes.ts` (native where the runtime has it); no per-byte JS loops
  over images
- keep fetches per request low: cheap each, but a generation's polls added up
- no heavy dependencies on the request path; request-independent data is built at module scope
- plain data only at module scope (stubs, `env` and I/O objects are bound to their request)
- image bytes are only base64'd, never decoded

Generations wait through the held `/comfy-gen/wait` request (§3 "Waiting"), so a warm one makes
about three fetches.

### Custom workflows (removed)

A `generate_custom_image` tool ran a workflow the user pasted in (API format), on the MCPB and the
PC. Removed 2026-09-30: barely used, untestable beyond a few graphs (it takes any graph with any
nodes), and it threaded through every layer (config, a prompt-node guesser, a node-inventory check
over the relay, its own tool and settings editor, a Modal exclusion). People with their own
workflows already run ComfyUI and can point the MCPB or the agent at it ("Your own ComfyUI"). A
stored `custom_workflow` setting is dropped on read.

## 4. Images, references, uploads, edits

- **The generator is the storage.** Modal: ComfyUI's input and output folders live on the Volume, so
  outputs survive scale-to-zero (S5). PC: the agent's disk. MCPB: local paths. No Cloudflare
  storage, no R2.
- **References are opaque.** Claude sees an id, the brain maps it to a ComfyUI filename it owns. Never
  paths from the model (path traversal on the PC, cross-reading on a shared volume). An id is the
  ComfyUI location signed with an HMAC under the Worker's secret, so it cannot be forged and needs
  no storage. It also names its backend, since each ComfyUI numbers its outputs from
  `comfy-gen_00001_`: the main generator's ids are `[type, subfolder, filename]`, the format of
  every id before the PC path, and the PC's add `"pc"`. So ids issued before the PC resolve to the
  main generator, `/img/` serves each id from its own backend, and an edit of the other backend's
  image copies it into the answering ComfyUI's inputs first. (Found in the from-scratch test: the
  PC's first image had exactly the id of Modal's first image.)
- **Compact ids** (2026-10-01): models mistyped the 70-character JSON ids. An image this app named
  gets `<payload>.<mac>` with a plain payload: `m7` (the main generator's `comfy-gen_00007_.png`),
  `p7` (the PC's), or `mupAbC…` for an upload (`m`/`p`, `u`, the extension as a letter
  `p`/`j`/`w`/`g`, the nonce). The MAC is HMAC-SHA256 over `"c:" + payload`, cut to 9 bytes (12
  characters); an id is only checked online, one guess per request. A generated image's id is 15
  characters (`m7.Ab3dE9fGh1Jk`), an upload's about 32. `sign` uses the compact form only when the
  name rebuilds exactly (`%05d` numbering), else the JSON form; `verify` takes both, so ids in
  existing chats keep working. `golden.json` pins both (`refs`, `refs_pc`, `refs_compact`).
- **Results are inline WebP.** claude.ai does not support `resource_link` (it shows "Resource links
  are not currently supported" and the model sees only the name and URL), while inline
  `ImageContent` is shown to the user and seen by the model, WebP included (S2, S2c). Every result
  carries the image inline as base64. The Worker fetches `/view?filename=...&preview=webp;90`,
  where ComfyUI converts with PIL before sending (about 0.1 s on the generator, nothing in the
  Worker), and base64s it with the runtime's native encoder (about 3 ms of Worker CPU per MB,
  appendix). If the WebP comes back over about 700 KB, the Worker asks again at quality 75. The
  MCPB does the same against its local ComfyUI (PNG when `:lossless` is asked).
- **Image URLs.** A Worker route resolves a reference and streams the full-resolution PNG from
  `/view` over the right transport. Each result's text block carries the image id and this URL for
  the user. No `resource_link`.
- **Edits** are `LoadImage` by reference inside the generator; a prior output loads directly as
  `"<name> [output]"` (S5). Only results pass image bytes through the Worker.
- **Uploads from claude.ai** use the code-execution sandbox (S3). A `request_upload` tool returns a
  one-time URL plus the snippet to run. The sandbox posts the attached file, the Worker forwards it
  to ComfyUI's `/upload/image`, the tool result carries the reference, and `edit_image` takes it.
  Attached files stay available in the sandbox for the conversation, so the upload happens when the
  edit is requested. The tool description covers the case where code execution is off: ask the user
  to enable it or give a URL. The snippet sets its own `User-Agent` (see section 8).
- `edit_image` accepts an upload reference, a previous output reference, or an https URL.

### LoRAs on the Modal Volume

**One way in** (decided 2026-09-30): every LoRA comes through **Upload LoRA** on a settings page,
and only LoRAs that came in that way exist for the app. A PC may hold hundreds of LoRAs in its
ComfyUI's folders, many not for our models; they are never listed, synced or configured. On Modal
that is every file on the Volume (it only ever held uploads). On a machine it is a registry,
`loras.json` in the app's home, of the names uploaded or copied there (`packages/local`
`lora-uploads.ts`); the folder alone would not do, since with "Your own ComfyUI" it is the user's.
Where an upload goes:
- a Worker with Modal: the Volume, as below; the agent then copies it to the PC (§9, "LoRA sync"),
  a round trip for a file the PC had, worth it for LoRAs of about 90 MB and one way in
- a Worker with a PC and no Modal: the agent, in 4 MiB chunks through the Worker, each a control
  call over the relay with the chunk as its body (the browser cannot reach the PC: it may be a
  phone, and browsers keep public pages off localhost)
- the extension: its own local server
All three speak the same chunked protocol (`web/src/lib/upload.js`). Delete removes a LoRA from
every backend that has it.

LoRAs (Anima family only, as in the old extension: `supportsLoras` in `packs.ts`) are uploaded from
the settings page and configured per pack family: file, strength, trigger (it applies only when the
prompt contains the trigger; no trigger means always), hidden (the trigger is not listed in the tool
description).

- **Upload path, browser straight to Modal.** The bytes never pass through the Worker (its CPU
  budget) and must survive Modal's 150 s web-request limit, so the page sends 16 MiB chunks to the
  Modal app's `upload` endpoint, the one endpoint without proxy auth. The Worker asks the admin API
  for an upload session; the session's random 32-byte id is the capability (that one file's
  chunks, its declared size, 24 h), and the endpoint's CORS allows only the settings page's origin.
- **Chunks are separate files.** Each chunk is checked (length, SHA-256 from the page), written to
  `uploads/<id>/<index>` and committed on its own, because requests may land on different
  containers, which see each other's writes only after a commit and a reload. `assemble` (a CPU
  function) reloads once, joins them into `models/loras/`, commits, then marks the session done
  and requests the idle-time reload, so a warm ComfyUI sees the file (§3, S5(d)).
- Saving settings warns about configured LoRAs that no backend has (the Volume, or the paired PC).
  LoRAs are listed and deleted through the admin API.
- **Copies to and from the PC** (§9, "LoRA sync") use the same endpoint: the agent sends chunks to
  an upload session and finishes it with `POST /u/<id>/finish` (the session id is already the
  capability to write that file), and downloads from `GET /d/<id>`, a download session the admin
  API creates (a random id that reads one LoRA for an hour). Downloads answer `Range`, so one cut
  off at 150 s resumes.

## 5. Config and settings

- Config lives with the brain: the `State` Durable Object for the Worker (Workers KV caches reads
  at the edge for up to a minute, which gave stale reads and lost updates live; see §11), a local
  JSON file for the MCPB.
- One Svelte settings app, rendered from the declarative settings schema, served by the Worker
  (behind a Cloudflare-token login and a cookie session) and by the MCPB's local server.
- Keep-warm is the one setting per backend: `keep_warm_minutes` applies to Modal's
  `scaledown_window` (live, through `update_autoscaler`, S5) and to the extension's idle stop;
  `pc_keep_warm_minutes` to the agent's idle stop (idle time on the PC costs nothing).
- If both the PC and Modal are configured, the PC is used when online and Modal when it is not.
- **One config for every backend** (decided 2026-09-30, after trying one per backend): Claude sees
  one tool list, and its descriptions (styles, LoRA triggers, packs) cannot change with which
  backend is online, so separate settings needed a "keep these the same by hand" warning. What
  really differs per backend is its files, so the one Settings page shows those per backend:
  - **Models:** a row per selected pack, with a mark per backend (PC, Modal: ready, downloading,
    missing with a Download button). Saving starts the downloads on every backend
    (`GET /api/models` returns `{backends, packs: [{…, on: {backend: status}}]}`).
  - **LoRAs:** a row per file, with where it is (PC, Modal, or copying) and its setup beside it
    (which packs, strength, trigger, hidden); upload and delete on Modal. Packs sharing a settings
    key share their LoRAs (Anima and Anima Turbo). A new trigger is the file name, with the `@` that
    Anima's artist tags use for packs whose styles are @tags. A LoRA some pack uses is copied to
    whichever of the PC and Modal lacks it (§9, "LoRA sync").
- The extension's page is the same, for its one computer. `#settings` opens the page directly.

## 6. Setup flows

The static site (`site/`, published to GitHub Pages by `.github/workflows/pages.yml`) has the
prerequisites and the Deploy button, then hands over to the Worker's page. That page is a stepper:
log in; choose where images are made (Modal, the PC, the PC with Modal while it is off, or, under
Advanced, a ComfyUI URL); that path's steps; connect Claude. A fourth choice, "only from Claude
Desktop", leads to the extension instead, which needs no Worker. Each step ticks itself from the Worker's state:
the generator set, the models on the Volume, the PC connected, and Claude having connected (the
first `tools/list` on the connector URL sets `claude_seen` in the `setup` key; a new URL clears
it). Done steps fold to one line; until Claude has connected, the page opens on Setup rather than
Settings. The agent's and the extension's own pages carry a short checklist on top (pair, install
ComfyUI) above their usual sections.

### No GPU

1. Static site: prerequisites (Cloudflare, GitHub, Modal with a card on file), then the Deploy button.
2. The button copies the bootstrap into the user's GitHub and deploys via Workers Builds. It asks
   for nothing.
3. The user opens the Worker's page and logs in by pasting a **user-scoped** Cloudflare API token,
   then a Modal token pair. The token comes from a pre-filled template link (section 8), so the user
   only narrows it to their account and clicks Create. It is both the login and the token the Worker
   keeps for builds (see "Login" in section 8).
4. The Worker finds its own tag and build trigger, writes the Modal tokens and a one-time nonce into
   the trigger's build secrets, and starts a build through the Workers Builds API.
5. The build (Python 3.13 in Cloudflare's build image) fetches the release and runs
   `comfy_gen_modal.deploy`: `modal deploy` with the official SDK, and a proxy token minted once and
   kept in the app's `comfy-gen-state` Dict, so update builds reuse it. It then deploys the Worker
   and posts the server URL, admin URL and proxy token to it with the nonce (about 90 s in all once
   Modal has the image cached).
6. The callback stores the generator, re-applies keep-warm (a deploy resets it) and starts a seed
   for each selected pack. The setup page streams the build logs, then the downloads (about 20 GB
   for the defaults, about 3 minutes). A tool whose models are not on the Volume yet answers with
   the download's progress instead of failing inside ComfyUI.
   If `modal deploy` fails, the build still deploys the Worker, and the callback carries Modal's
   own reason (the text of its Error panel, such as "Please add a payment method to use L4 GPU
   functions." on an account with no card, seen in the from-scratch test). The setup page shows it
   in the Modal step, with the fix for a missing card, and **Try again** starts a build without
   token fields: the build secrets keep the stored token, which Modal would not show again.
7. The user copies the connector URL into claude.ai.

### GPU owner

1. Steps 1 to 3 of "No GPU", choosing "On my PC" instead of pasting a Modal token.
2. The step "Run the agent on your PC" makes a pairing link, `https://<worker>/agent#<secret>`, and
   links the launcher downloads.
3. The user downloads the launcher for their OS from the release and runs it. It installs itself,
   fetches Node, starts the agent and opens the agent's page on `127.0.0.1:9248`.
4. There they paste the pairing link, then install ComfyUI as in the MCPB (GPU choice; other
   installs' model folders are found and used). The agent connects to the Worker and keeps the
   connection; the Worker's page shows it connected, with its GPU and ComfyUI state.
5. From then on the agent starts at login, starts ComfyUI on the first job, downloads a pack's
   missing models when a tool needs them, and stops ComfyUI after the idle window.

Modal can be added (or kept) as the fallback: each call uses the PC when it is connected and Modal
otherwise. A new pairing link replaces the old secret (the connected agent is dropped); "Unpair"
removes it.

### Claude Desktop only

Install the `.mcpb` in Claude Desktop, open the settings page from the tray or the first tool
result, pick the GPU and install ComfyUI (or keep the old extension's). No accounts.

## 7. Updates

- **Worker and Modal app:** the Worker's cron checks the latest GitHub release against its own
  version. On a new one it starts a Workers Build. The template's deploy command is a stub that
  downloads the release's `deploy.sh`, so the user's copy never goes stale and there is no fork
  sync. One build updates both the Worker and the Modal app. Packs, tool descriptions and workflow
  templates ship with the code: a new pack is a release.
- **Update now:** the setup page's Updates section shows the running and the latest release, and
  starts the same build at once (`POST /api/update`), without waiting for the daily check, then
  shows its log.
- **Agent:** the launcher's shim loads the latest release's bundle, checking daily while
  the agent runs, and the agent restarts into a new one when idle (§2). The launcher changes only
  with a new Node; it is downloaded again by hand.
- **MCPB:** the shim loads the latest release's bundle (§2, "The MCPB process"); the
  `.mcpb` itself changes rarely.
- No token, no updates. There is no fallback path to maintain.

## 8. Secrets and auth

| Secret | Held by | Purpose |
|---|---|---|
| MCP secret path | Worker state | The connector URL. OAuth is a later upgrade |
| Cloudflare user token | Worker state | Login to the settings pages; Workers Builds API for setup and updates |
| Session cookie key | Worker state | Signs the settings pages' session cookie (a year) |
| Modal token pair | Build secrets only | `modal deploy` during builds |
| Modal proxy token | Worker state, Modal Dict | Calls to the ComfyUI server and admin endpoint |
| Ref HMAC key | Worker state | Signs image references and upload tokens |
| Agent pairing secret | Worker state, `agent.json` | Authenticates the relay: the agent's `Authorization: Bearer`, checked before the WebSocket upgrade. It travels in the pairing link's fragment, which browsers do not send |
| Build nonce | Build secrets, Worker state | One-time callback from the build |
| LoRA upload session id | Modal Dict, the settings page or the agent | Writes one LoRA's chunks to the upload endpoint, and finishes it (24 h) |
| LoRA download session id | Modal Dict, the agent | Reads one LoRA from the upload endpoint (1 h) |
| PC LoRA upload session id | The agent's memory, the settings page | Writes one LoRA's chunks through the Worker's relay (24 h; lost on an agent restart) |

**Login.** There is no setup password: the first login is a Cloudflare token. A fresh install's URL is not secret: the Worker name is the
template's `comfy-gen` for nearly everyone, and each account's workers.dev subdomain is public in
Certificate Transparency logs (its wildcard certificate). So "the first visitor claims it" would let
anyone scanning those logs claim installs before their owners. The Deploy button takes only the
template URL (no name, secret or variable parameters), so nothing random can reach the deploy
either. Instead, logging in means pasting a Cloudflare user token that can see this Worker
(`scripts-search` on its name finds it in the token's accounts), which only the account's owner can
make. Setup needs that token anyway; the latest one replaces the stored one. The session cookie
lasts a year. Under `wrangler dev`, `DEV_WORKER_HOST` names the deployed Worker to prove ownership of.

**Password** (decided 2026-10-01: making a new token for each browser was tedious). Right after the
first token login the page requires a password (at least 8 characters), and later logins use it;
the token stays the way back in when it is forgotten. It can only be set by a logged-in session, so
the first claim still goes through Cloudflare. The secrets hold `password: {salt, hash, iterations}`,
PBKDF2-SHA256 with 20,000 iterations (few for a password hash, for the free plan's CPU budget). The
guard against guessing is a lockout: 10 wrong passwords within an hour pause password logins for
the rest of it (`setup.login_fails`), while the token login stays open.

Any code that calls a Worker from outside (build callbacks, the upload snippet, the agent) sends its own
`User-Agent`: Cloudflare answers urllib's default `Python-urllib/x.y` with Error 1010 before the
Worker runs (S4).

### Cloudflare token

- **User token, not account token.** The Builds API rejects account tokens ("Invalid token",
  code 12006), even with the Workers CI permissions (tested 2026-09-27). User tokens live at
  `dash.cloudflare.com/profile/api-tokens`.
- **Template link.** The setup page links to
  `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=<url-encoded JSON>&accountId=*&zoneId=all&name=Comfy-Gen-MCP`
  with these keys, all verified to pre-fill (the page shows the legacy names on the right):

  | Key | Type | Shown as |
  |---|---|---|
  | `workers_scripts` | edit | Workers Scripts |
  | `account_settings` | read | Account Settings |
  | `workers_ci` | edit | Workers Builds Configuration |
  | `workers_observability` | read | Workers Observability |

  The new role-style "Workers: Admin" permission should be added too, for when the legacy ones are
  retired; its template key is not documented yet and still has to be found.
- **Account choice.** The link must use `accountId=*` because the Worker cannot know its account id
  in advance, which pre-fills "All accounts". The Worker finds the account it lives in by listing
  the token's accounts, so "All accounts" works; most users have only their own. The setup page
  offers narrowing as an optional note for those who also belong to others (an employer's, say),
  where a token on every account would be needlessly broad.
- The dashboard's "Entire Account" resource option on the newer account-token page is only a
  resource scope, not "all permissions"; worth a line in the setup page if users end up there.

## 9. Relay (PC generator)

- A Durable Object per Worker is the rendezvous. A Worker has no memory between requests, so the
  waiting `tools/call` and the agent need a shared addressable object to meet in.
- The agent holds an outbound WebSocket, accepted with the hibernation API; `ping`/`pong` text
  frames are answered by the runtime without waking the object. A `tools/call` sends a request down
  the socket and awaits the reply with the same id. Round trip Worker to agent and back: 19 to 37 ms
  (S6). An idle connection costs nothing measurable; drops come every few minutes to few hours, so
  the agent reconnects at once and the Worker waits briefly for it (S6).
- The Durable Object and its migration are declared in the bootstrap template from the first
  release, so adding the PC path later needs no template change.

**As built (M6).** `GET /agent` checks the pairing secret (401 without it, so the agent can tell
"unpaired" from "not a WebSocket", 426), then forwards the upgrade to the one `Relay` object. A new
connection replaces the old (close 4000: "another agent connected"); unpairing or a new pairing
link closes it with 4001. After either, or a 401, the agent retries only every 5 minutes, and at
once when it is given a new link.

The protocol (`core/relay.ts`, shared by both ends): a message is a JSON header in a text frame,
followed by its body in binary frames of at most 1 MiB, the header saying how many. Each side sends
a header and its chunks in one synchronous run, so messages never interleave.

| Message | Direction | Carries |
|---|---|---|
| `http` | Worker → agent | One ComfyUI request (method, path, params, headers, body); the agent calls its ComfyUI inside a job, so the idle stop waits |
| `control` | Worker → agent | An agent operation: `pause` (`{paused}`, from the Setup page), `ensure` (start ComfyUI, install the pack's nodes, check or start its model downloads), `loras` (its files and the LoRA copies in progress), `models`, `download`, `sync` (start a LoRA sync), `upload_start`, `upload_chunk` (the chunk as the message body), `upload_finish`, `upload_status`, `lora_delete`, `status` |
| `reply` | agent → Worker | `{id, status}` and the body |
| `hello` | agent → Worker | On connecting, and again when paused or resumed: version, platform, GPU, ComfyUI state, `paused`; the latest is kept with the socket for the settings page |

On the Worker, `RelayTransport` is core's `Transport` over the object's `request()`, so the
ComfyUI client, held waits and the brain are unchanged. A call with no agent connected waits 10 s
for a reconnect, then fails with "your PC is offline"; one whose agent drops mid-call fails with
"the connection to your PC dropped". Timeouts: 120 s for a ComfyUI request (a held wait is 50 s),
30 s for control, 240 s for `ensure`. The generator is chosen per call: the PC when paired and
connected, else Modal, else the offline message. An `image_id` names the backend that made it
(§4): editing a Modal image while the PC answers copies it to the PC first, and the reverse copies
from the PC, which fails with a clear message while the PC is off.

Measured on the test install (appendix, "M6 live"): a warm relayed generation costs the Worker a
median 10 ms of CPU (8 to 19, as on the Modal path) and the Relay object 0 to 3 ms; a 3 MB image
crosses in 1 s each way. Durable Object duration cannot outgrow the free plan: one object billed at
128 MB, active around the clock, is 10,800 GB-s a day of the 13,000 allowed, and a hibernating
socket is not active. Requests: about 10 per generation, against 100,000 a day.

**Images while ComfyUI is stopped.** The idle stop ends ComfyUI after keep-warm, but a PC image's
link and edits by `image_id` read it back through `/view`. The agent answers such a `/view` from
ComfyUI's output, input or temp folder on disk (confined to them) without starting ComfyUI; the
`preview` parameter is ignored and the original sent.

**Ending with the launcher.** On Windows, ending a process leaves its children running, so ending
the launcher left Node, the tray and ComfyUI behind. The launcher passes its pid
(`COMFY_GEN_LAUNCHER_PID`; older launchers are the parent process, which is the same), and the
agent checks it every 5 s: once it is gone, the agent stops ComfyUI and exits.

**Pause.** The agent's tray has "Stop taking image requests", and the Worker's Setup page has
Pause and Resume in the PC step's header (usable while it is folded, from a phone), sent to the agent
as a `pause` control op over its connection: the agent has no inbound port. Both set the same flag
in the agent, which then sends a hello with `paused: true`; the tray re-reads the flag every 2 s and
the page reads the hello, so they agree whichever changed it. The Worker then treats the PC as not
there: Modal answers, or, with no other generator, the tools say the PC is paused. The pause is not
saved, and both places say so: a restart takes requests again, so a forgotten pause cannot send
every image to Modal for days.

The agent (`packages/agent`) reconnects at once after a drop, then backs off (1 s to 60 s),
resetting after a connection that lasted a minute; it pings every 20 s, answered by the runtime.
Its settings page (loopback only) is the MCPB's machine setup plus the pairing section; pack
settings stay on the Worker, whose settings page lists the PC's LoRAs and model status beside
Modal's (`/api/loras`, `/api/models`).

**LoRA sync.** A LoRA should be on every backend that may answer. The agent posts its LoRA files
(`{name: size}`, ours only) to `POST /agent/sync` (the pairing secret, as for `/agent`); the Worker
answers with a plan: every Volume LoRA the PC lacks is **pulled** (a download session per file),
and one of the PC's that some pack uses and the Volume lacks (uploaded before Modal was set up) is
**pushed** (an upload session per file, the agent sending the chunks as the settings page would). The bytes go between the PC and Modal directly, never through the
Worker, which spends one admin call per file (at most 20 per plan; the agent asks again after a
round that copied something). The agent syncs on each connection and when the Worker sends
`sync` (after a settings save, and after an upload to Modal); copies in progress show on the
settings page, which re-checks while they run. Sync never deletes; Delete on the settings page
removes a LoRA from every backend, and turns it off, so it is not copied back.

## 10. Repository

**One authored repository.** TypeScript in npm workspaces, plus the Python that runs on Modal:

| Package | Contents | Runs in |
|---|---|---|
| `core` | packs (JSON), workflow build, tool specs, ComfyUI client, refs, brain, MCP handler, settings schema | Workers and Node (Web-platform APIs only) |
| `worker` | Worker entry, State and Relay Durable Objects, routes, render, Builds API, setup, updates; the build step `deploy/deploy.{sh,py}` | Workers (the build step: Workers Builds) |
| `modal_app` | Modal app, admin endpoint, build-time deploy script | Python (Modal, build image) |
| `local` | ComfyUI install, launch, stop, downloads, node install, idle stop, tray; shared by `agent` and `mcpb` | Node |
| `mcpb` | the shim (the `.mcpb`, and embedded in the launcher), the extension's server, and the entry of the bundle both programs load (`comfy-gen.mjs`, a release asset); single process, §2 | Node (Claude Desktop's bundled runtime) |
| `agent` | `local` plus the relay client and the agent's settings routes; in the same bundle | Node, started by the launcher |
| `launcher` | the agent's launcher: installs itself, Node and the login entry, supervises the agent | Go, one binary per platform |
| `web` | Svelte settings and setup app | browser |
| `site` | static landing page | browser |
| `bootstrap` | what the Deploy button copies: wrangler config and `package.json` with the deploy stub | Workers Builds |

`core` exports its TypeScript source directly (no build step): wrangler bundles it into the Worker,
and the MCPB and agent bundle it with esbuild (`packages/mcpb/build.mjs` builds the one bundle and
the shim the launcher embeds).

A release is six files: `deploy.sh` and `comfy-gen.mjs`, which installs download on their own,
and the `.mcpb` and three launchers, which people download; the notes open with a download table
(`.github/release-notes.md`). `web` stays outside the workspaces with its own lockfile,
and its built `dist` is committed so deploys need no web build.

Packs ship inside `core` as JSON modules, so the Worker bundle, the MCPB and the agent all get them
without extra packaging.

`local` exists because the MCPB and the agent do the same job on a user's machine (keep a ComfyUI
installed, fed and running only when needed) and must share that code.

The Deploy button points at the `bootstrap` folder; the button copies only that folder (S4). The
template holds no project files with dependencies, because Workers Builds installs them before the
deploy command (S4); the Worker's `package.json` and lockfile come with the fetched release, and
the build step runs `npm ci` for the Worker's workspace, then `wrangler deploy`.

Existing installs update from `github.com/lugia19/comfy-dxt.git`, the repository's former name,
which GitHub redirects to `comfy-gen-mcp`. So never create a new repository named `comfy-dxt` or
`comfy-gen-mcp` under this account, and never delete the old one while installs exist. Archiving is
safe: an archived repository still serves pulls.

The current `comfy-gen-mcp` stays in maintenance for existing users until the new MCPB and agent
ship, then gets a final "install the new version" commit and is archived. Its `main` is a live
update channel, which is why the rewrite does not happen in place.

Later: the ComfyUI client and the Modal app can become shared with Visual-Novelist.

## 11. Decisions and rejected alternatives

| Rejected | Why |
|---|---|
| Always-on RunPod CPU pod hosting the server | Bills around the clock |
| Python Worker (Pyodide) | Chosen first, so one Python brain could serve the Worker and the MCPB. Measured: about 10 ms CPU per request before our code, 0.24 ms per JS await, 1.8 ms per fetch; every request at the free plan's limit, generations 60 to 160 ms. The TypeScript port bills 1 to 2 ms per request. |
| MCP SDK in the Worker | About 2 s CPU per fresh isolate, killed on the free plan (S1) |
| `resource_link` results | Not supported by claude.ai; the model sees only a name and URL (S2) |
| RunPod serverless | Superseded by Modal in Visual-Novelist: cheap pools often unstocked, volume pins a datacenter |
| Our own job handler and Docker image | Modal serves ComfyUI's own API; ComfyUI is the worker everywhere |
| R2 or KV for image storage | The generator already holds the files; R2 needs a card on file |
| QoL or settings-page uploads | The model would not know which reference to use; the sandbox upload keeps it in context |
| Workers KV for the Worker's state | Reads are cached at the edge for up to a minute: after a save, reads alternated between old and new values for about 60 s, and a read-modify-write could undo a recent write. A SQLite Durable Object is consistent and on the free plan |
| Hot pack manifest in KV | A second update path; a release build takes about 2 minutes and runs automatically |
| Fork-sync GitHub Action | More code; the token-driven build covers updates |
| Qt desktop app | Settings moved to the web; the PC side is a daemon with a small tray |
| Cold/warm status in results | A blocking call fits inside the client timeout |
| Modal Sandboxes over gRPC | Outbound gRPC from Workers is private beta, browsers cannot reach Modal's API (no CORS, no gRPC-web), and Sandboxes would make us own lifecycle and an undocumented protocol |
| Worker uploading over its own script | Replaced by Workers Builds, which also updates Modal |
| An automatic upload route for images pasted into Claude Desktop (MCPB) | The sandbox trick needs a public endpoint, and the extension is on `127.0.0.1`. A clipboard route (the model asks the user to copy the image, then passes `"clipboard"`) was built and removed: too much machinery for the gain. What remains is opt-in, and costs no code: the `edit_image` description offers a file path, or an upload to Litterbox (catbox's temporary host) for one hour, only after the user agrees to the image being public for that hour; the returned URL goes to `edit_image` like any URL. It needs code execution with network access to `litterbox.catbox.moe`. Tested 2026-09-30: one POST, the URL serves the same bytes to the extension's fetch |
| comfy-cli for the local ComfyUI install | Needs git (a hard failure without it) and a second Python env just to run it, and caused the old extension's Windows bugs (spaces in `override.txt`, cp1252 crashes, a leaked `VIRTUAL_ENV`). What it abstracts, uv does: `--torch-backend auto` picks the CUDA wheels from the driver on every OS and the ROCm build by GPU architecture on Linux. The one gap, Intel Arc on Windows, is an explicit "intel" choice (`xpu`). AMD on Windows gets CPU wheels either way (comfy-cli installed DirectML but never launched with `--directml`). `local` downloads the pinned ComfyUI release, makes the venv with uv, installs node packages from the Comfy Registry API. Installs the old extension made with comfy-cli run as they are |

## 12. Phases

The order puts first what can be built and tested without Modal, Windows or a GPU (see
`docs/build-plan.md`):

1. `core` (Python first, ported to TypeScript after M3's CPU measurements).
2. Worker, web app, bootstrap, release pipeline: the cloud path, tested against any reachable
   ComfyUI.
3. Modal app and the **first release** (no-GPU users).
4. Full cloud settings: LoRA uploads and per-pack LoRA settings (artists and sandbox uploads came
   earlier; custom workflows, left to the local and PC generators then, were later removed).
5. `local` and the MCPB (Node) at parity with the old extension.
6. Agent and relay. Then retire the old repository.

## 13. Reference numbers

| Fact | Value | Source, date |
|---|---|---|
| Workers free CPU per request | 10 ms, occasional overruns tolerated; up to 164 ms seen without a failure | Cloudflare limits; M3 live, 2026-09-28 |
| TypeScript Worker request | 1 to 2 ms (MCP ping, tools/list, settings API); a generation 30 to 60 ms | TS port, 2026-09-28 |
| Python Worker request (retired) | about 10 ms floor, + 0.24 ms per JS await, + 1.8 ms per fetch | Probes, 2026-09-28 |
| Modal cold start / warm, L4 | about 44 s / 0.5 s to accept a prompt | S5, 2026-09-28 |
| Modal free compute | $30 a month, card required | Modal pricing and billing docs |
| Workers Builds | 3,000 free minutes a month, 1 concurrent; a deploy takes 1.5 to 2.4 min | S4, 2026-09-28 |
| MCP client timeout | 5 minutes | S8, 2026-09-28 |
| Blocking tool call through a Worker | 250 s works | Tested, 2026-09-28 |
| Workers free subrequests | 50 external + 1,000 to Cloudflare services, per invocation | Cloudflare limits, 2026-09-05 |
| Builds API token | User-scoped only: an account token with Workers CI Write gets "Invalid token" (12006) | Tested, 2026-09-27 |
| Token template link | Pre-fills all five permissions on the user-token page | Tested, 2026-09-27 |

## Appendix: spike results

The spike code lived in `spikes/`; it was deleted on 2026-09-29, after S6 was recorded.

**The Python Worker, 2026-09-27/28 (retired).** v0 of the Worker was Python (Pyodide), so one
Python brain could serve the Worker and the MCPB. Measured on the deployed Worker (Workers Logs
`cpuTimeMs`):

- The official MCP SDK cost about 2,000 ms of CPU per fresh isolate (import and app build), was
  killed (Error 1102) and left the isolate broken; the hand-rolled stateless handler in `core` comes
  from this.
- Every request billed about 10 ms before our code ran (the Python runtime; our own Python was about
  0.1 ms), plus about 0.24 ms per JavaScript await and 1.8 ms per fetch (probe routes, 12 to 30
  calls each; waiting was not billed). So every request sat at the free plan's limit, and a
  generation cost 60 to 160 ms, set by how many times it called out.
- `pywrangler` vendored a workspace sibling fine (S7), so packaging was not the problem.

That led to the TypeScript port (below): 1 to 2 ms per request.

**M3 live, 2026-09-28: ComfyUI on Modal through the product.** The test install, set up entirely
through its own setup API and Workers Builds:

- Setup build: Modal deploy 6 s (the image was already cached from S5), whole build about 90 s. The
  three default packs (19.6 GB of distinct files) downloaded in parallel in about 3 minutes.
- Generations through MCP: 86 to 90 s from cold (container start, ComfyUI start, first model load
  from the Volume); 30 to 60 s warm when the pack's model is not yet in memory. `edit_image` on an
  earlier output's id works. The full-resolution PNG serves through `/img/<ref>`.
- **S5(d), answered:** `volume.reload()` fails even after `/free` ("open files preventing the
  operation": ComfyUI keeps model files open). The watcher now commits, tries a reload, and on open
  files restarts the ComfyUI process around it. Measured: a 15.8 GB pack seeded while the GPU was
  warm with another model loaded, the watcher reported "restarted ComfyUI", and a generation with
  the new pack succeeded without a container cold start (131 s, mostly loading 16 GB). Outputs
  written before the restart were still served afterwards, since the watcher commits first.
- Four pack sizes from the old repo were wrong (GiB/GB mix-ups; hashes right). The seed trusts
  sizes, so it re-fetched those files every time. Fixed from Hugging Face's `x-linked-size`;
  `scripts/check_pack_models.py` checks every pack in CI.
- Workers KV caches reads at the edge for up to a minute, so reads right after a save alternated
  between old and new values. State moved to a SQLite Durable Object (§11).
- A deploy resets Durable Objects, and the build callback arrives seconds after one; State calls
  retry on "reset because its code was updated", and the build retries the callback once.
- CPU per `tools/call` carrying an image: 59 to 164 ms, median 122 (7 calls), all `ok`. Base64 of
  the 160 to 540 KB results explains only a few ms of that, and CPU does not track wall time or
  poll count. **Open risk:** well above the free plan's nominal 10 ms; nothing has failed, and the
  S1 SDK failure was at about 2,000 ms. To investigate with probes, as for the M2 figures.

**First cron update, 2026-09-29: "no release found".** With v1.0.0 published and the test install's
branch variables removed, the 04:17 check logged `update check: no release found`. A probe Worker
showed why: GitHub's REST API allows 60 unauthenticated requests an hour per IP, and Workers share
their outgoing IPs, so `api.github.com/.../releases/latest` answered 403 "API rate limit exceeded"
(`x-ratelimit-remaining: 0`), and on later requests from other IPs 200 with 2 and 56 left. The
redirect `github.com/<repo>/releases/latest` → `/releases/tag/<tag>` answered every time.
`updates.latestRelease` now reads that redirect. v1.0.0's Worker still has the old check, so an
install on v1.0.0 needs one build started by hand to reach a release with the fix.

**M4 live, 2026-09-29: LoRA uploads.** On the test install, through normal builds:

- a 305 MB Anima LoRA (19 chunks) and a 46 MB one uploaded from the settings page; both assembled,
  the 305 MB copy byte-identical on the Volume (SHA-256 read back)
- found live: the session was marked done before the Volume commit, so the list the page loads next
  lacked the new file for a few seconds; now marked after the commit (re-checked live), and the
  page retries finish and status through dropped connections
- a 46 MB style LoRA with trigger `tstyle`: the tool description lists it; the same prompt without
  the trigger renders in Anima's default look, with it in the LoRA's flat anime style (cold start,
  so the new container mounted the file)
- a chunk sent after the upload finished gets 409; saving a LoRA that is not uploaded warns
- Worker CPU: the LoRA routes 2 to 4 ms (median), a settings save that checks LoRAs 7 to 10 ms
- upload speed from this environment's network: 1 to 2.5 MB/s, limited by the environment

**Redeploying under load, 2026-09-29: keep `max_containers=1`.** Modal's docs suggest leaving it
unset for a singleton Server, so that a redeploy can start the replacement before the old container
goes. Tried with five jobs queued and a redeploy of the same app:

- with `max_containers=1`: the running container was stopped at once; every request answered 503
  for about 25 s while the replacement booted, and all five jobs were lost (`unknown` afterwards)
- without it: the old container kept serving next to the new one for about a minute and finished
  four jobs; the fifth was lost. Four jobs submitted at once during a cold start still started one
  container (a Server without `target_concurrency` does not autoscale).

But during that minute two ComfyUIs share the Volume without seeing each other's files: a generate
right after a setup build finished on one container and its `/view` landed on the other (404), and
`Modal-Session-ID` (sticky routing) did not prevent it. Worse, each ComfyUI numbers its outputs from
the files it saw at start, so both write the same `comfy-gen_000NN_.png` names and the later commit
replaces the earlier file: two redeploys under load, 26 generations after `comfy-gen_00088_`, left
19 files on the Volume (00089 to 00107, no gaps), so 7 were overwritten. An image id could then show another image. So the limit stays: a redeploy
(setup and update builds only) loses the jobs in flight, which the client reports as an unknown
request, and never mixes outputs.

**Itemizing a warm generation, 2026-09-28: about 6 ms of work, the rest is platform variance.**
A throwaway Worker (`comfy-gen-cpuprobe`, deleted after) bundled the real `App` and ran the MCP
generate path with pieces swapped out, 12 to 20 calls per variant, billed `cpuTimeMs` medians:

| Variant | Median CPU |
|---|---|
| MCP `ping` through `App` | 1 ms |
| generate, canned ComfyUI answers, 2 KB image | 1 to 2 ms |
| generate, canned answers, the real 419 KB WebP | 5 ms (4 if the response body is discarded) |
| same, plus Durable Object reads and a real fetch of a 314 KB image | 5 to 6.5 ms |
| same, with the wait held 2 / 5 / 15 s | 5 / 6 / 6 ms |
| same, 15 s holds, four requests overlapping in one isolate | 11 ms |
| the real `App` against the real Modal GPU (memory state) | 6 to 7 ms |
| a real Modal `/view` of 419 KB alone / GitHub 314 KB alone | 1 / 1 ms |
| a 15 s sleep / a 10 s pending fetch | 0 / 0 ms |

So a warm generation costs about 1 ms of request plumbing, 1 ms of state and fetches, and 3 to 4 ms
that scale with the image (reading the body, one `JSON.stringify` pass, sending 560 KB). Run live
and in the probe, alternating, with the same prompt on the same GPU: the live Worker 5 to 15 ms
(median 8.5), the live `index.ts` in the probe with its own State DO median 8, the probe with memory
state median 7; an earlier alternating run had the live Worker at median 11 against 6. The
per-call spread (5 to 18 ms for identical work) and overlapping requests, not our code, set the
tail. What is left to cut is small: skipping the stringify pass over the base64 (under 1 ms), or
smaller inline images.

**Where a TypeScript generation's CPU went, 2026-09-28: base64, not fetches.** A throwaway probe
Worker (`comfy-gen-cpuprobe`, deleted after), 10 calls per route, billed `cpuTimeMs` medians:

| Route | Median CPU |
|---|---|
| no work | 0 ms |
| 1 / 10 / 20 sequential fetches (small body) | 1 / 3 / 5.5 ms (about 0.25 ms each) |
| 10 fetches in parallel | 1.5 ms |
| 1 / 5 fetches of a 314 KB body | 1 / 4 ms |
| 1 / 10 Durable Object RPC calls | 1 / 4 ms |
| 1 MB of random bytes (the baseline for the rows below) | 2 ms |
| base64 of 1 MB, chunked `String.fromCharCode(...)` + `btoa` (what `bytes.ts` did) | 55.5 ms |
| same with `String.fromCharCode.apply` | 11.5 ms |
| `Uint8Array.prototype.toBase64` (native), plus `JSON.stringify` | 5 ms |
| `JSON.stringify` of a 1.33 MB string alone | 7.5 ms |
| a 3 s sleep | 0 ms |

So fetches were never the TypeScript Worker's problem (the 1.8 ms per fetch was Pyodide's), and the
spread-argument base64 was. `bytes.ts` now uses the native encoder, keeping the chunked one for
Node 22. Polling was replaced anyway, since a generation made 10 to 25 requests: ComfyUI in the
Modal image gets `/comfy-gen/wait` (§3). Against a local ComfyUI 0.37.0, a 21.7 s job took two
requests (submit, one wait) instead of about eleven, and the result arrives when it is saved rather
than at the next poll. Live, after both changes (7 warm and 2 cold generations, one edit):
warm generations 7 to 20 ms, median 11 (were about 30); cold 17 and 19 ms (was 31); an edit
returning a 268 KB image 9 ms (was 59). The rest is itemized in the next entry.

**TypeScript port, 2026-09-28: switched live without losing state.** `core` and the Worker were
ported line for line; golden vectors generated from the Python code pinned image ids, upload tokens,
session cookies, workflows, the tool list and the MCP bodies, and all matched. Deployed over the
Python Worker on the test install through a normal build:

- the Python-issued session cookie still logged in; the connector URL, config, generator and
  downloaded-pack list carried over (same Durable Object, same JSON strings)
- image ids issued by the Python Worker loaded and edited
- the build callback landed on the new code; a generate on Modal worked (65 s from cold)
- billed CPU, same method as before: MCP ping, tools/list and initialize median 2 ms (max 8, 18
  calls); settings API median 1 ms (max 3); a cold generate 31 ms; an edit returning a 640 KB image
  59 ms; the build callback 48 ms. The Worker bundle is 132 KiB (Python: 256 KiB plus Pyodide).
- found on the way: `/img` on a GPU scaled to zero answered 502; `/view` now waits out a cold start
  like `/prompt`.

**S2, 2026-09-28 (claude.ai web): only inline images work.** `resource_link` alone, or with a text
block carrying its URL: claude.ai shows "Resource links are not currently supported" and the model
gets only name, URL and mime type. Inline `ImageContent`: shown to the user, described correctly by
the model. Both together: the image comes through, the link is ignored. Desktop and mobile not yet
checked.

**S2c, 2026-09-28: inline WebP renders in claude.ai** and the model describes it correctly
(user-tested). On three real 1 MP photos, PIL WebP q90 came out about the size of JPEG q85
(165 to 373 KB against 175 to 336 KB), with WebP's deblocking giving fewer artifacts around sharp
edges; WebP encoding took 110 to 155 ms against 4 to 12 ms for JPEG, on the generator.

**S3, 2026-09-28: works.** From a claude.ai chat with code execution on, the model called
`request_upload`, ran the returned snippet, and `show_upload` returned the attached image.

**S4, 2026-09-28: works, with three template lessons.**

- The Deploy button created a repository from the `spikes/bootstrap` folder only and pre-filled the
  deploy command from `package.json` (`npm run deploy`).
- Workers Builds runs its own dependency install before the deploy command (`bun install`,
  `uv sync` on whatever `package.json` / `pyproject.toml` it finds). The first build failed there
  because the template's `pyproject.toml` referenced files not fetched yet.
  `SKIP_DEPENDENCY_INSTALL=1` disables it. Lesson: the template holds no `pyproject.toml`.
- A button copy is a frozen snapshot, so the template's deploy command is a one-line stub that
  downloads the real deploy script at build time. Tested by switching the trigger to the stub.
- From inside the Worker, with a user token: found its own account, tag and trigger from its
  workers.dev hostname (the only runtime clue to its name), wrote build variables (0.7 s), started
  builds; logs and status readable through the API.
- Build image: Python 3.13.3, `pip install uv modal` 12 s, outbound network to GitHub, PyPI, Modal
  (gRPC) and workers.dev all work. `modal deploy` from the build: 17 s first, 8 s after.
- Build durations: 1.5 to 2.4 min for a deploy; 7.2 min with a full Modal driver run inside.
- Callbacks from Python need a custom `User-Agent` (Error 1010 otherwise). `wrangler dev` does not
  apply this check, so local tests miss it.

**S5, 2026-09-28: the generator-as-storage design holds on Modal.** Run from inside a Workers Build
(the development container cannot reach Modal's gRPC API):

- Cold start to `/prompt` accepted: 43.8 s and 44.1 s (L4, image with ComfyUI-GGUF). Warm: 0.5 s.
- (a) Outputs in the Volume-backed output folder survive scale-to-zero. The server's exit hook
  commits explicitly; whether Modal's automatic commit alone suffices for Servers was not isolated.
- (b) `LoadImage` with `"<name> [output]"` loads a prior output directly after a cold start.
- (c) Files uploaded through `/upload/image` survive scale-to-zero.
- (d) A warm ComfyUI does not see a LoRA committed by another container within 90 s; with a
  `volume.reload()` every 10 s in the server container it sees it after 12.4 s. No model was loaded
  in the spike; Modal documents that a reload fails while Volume files are open and that the Volume
  appears empty during a reload, so the product reloads only while idle, after ComfyUI's `/free`.
  To verify with a loaded model when the Modal app is built.
- (e) `update_autoscaler` works from inside a Modal function (0.5 s).
- (f) Admin endpoint behind proxy auth spawns the seed function: 335 MB in 26 s with progress.
- (g) `comfy node registry-install ComfyUI-GGUF` works in the image; `UnetLoaderGGUF` loads.

**S6, 2026-09-28/29: a hibernating WebSocket costs next to nothing; expect drops.** A stand-in
agent on the user's PC held a WebSocket to a Durable Object (hibernation API,
`setWebSocketAutoResponse`), with the client's WebSocket protocol pings every 20 s. Relay round trip
Worker to agent and back: 19 to 37 ms.

- Cost, from the GraphQL analytics (`durableObjectsPeriodicGroups`): hours with the socket open and
  no reconnect show no activity at all; an hour with a reconnect shows 10 to 46 ms of active time,
  all of it the reconnect. No inbound messages were counted, so protocol pings are answered without
  waking the object. The invocation's wall time (13.5 h) is the connection's life, not billed time.
- Drops: 8 in 8.4 h (after 4 min to 3.5 h, median about 40 min), all abrupt ("no close frame
  received or sent"), each reconnected on the first try. Where they come from (Cloudflare's edge or
  the home network) was not determined; the agent must reconnect either way.
- For the agent (M6): reconnect at once after a drop and reset the backoff after any connection
  that lasted; the spike's reset only ran on a clean close, so its delay climbed to 60 s. The Worker
  should wait a few seconds for the agent to come back before failing a relayed call.

**M6 live, 2026-09-30: the relay on Cloudflare.** The test install on the M6 branch, the agent in
this container (started by the Linux launcher) with a CPU ComfyUI, a two-node custom workflow.

- Outbound WebSocket from the agent: opens in 0.6 to 0.8 s; `ping` answered by the runtime in
  about 60 ms without waking the object.
- Generation through the relay: 16 s cold (ComfyUI started by the agent), 0.66 to 1.2 s warm.
- Worker CPU (`cpuTimeMs`): `/mcp` warm generation median 10 ms (8 to 19), cold 19; the Relay
  object 0 to 3 ms per invocation, about 10 invocations per generation.
- A 3 MB PNG (random pixels) uploaded through the relay in 1.0 s (Worker 9 ms CPU) and read back in
  0.84 s (7 ms), byte-identical: the 1 MiB chunking passes the platform's message limit.
- The agent stopped (SIGTERM to the launcher): ComfyUI stopped, the Worker's state showed the PC
  disconnected, and a custom workflow answered "your PC is offline" at once (Modal configured, so
  no wait for a reconnect).
- The launcher, same run: Node downloaded and checked, agent v8 started, v9 found on a stand-in
  release server, and the restart into v9 came after exactly the 10 quiet minutes.

**S8, 2026-09-28: the client timeout is 5 minutes.**
