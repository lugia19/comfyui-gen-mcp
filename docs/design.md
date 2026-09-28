# Comfy-Gen-MCP design

Status: design agreed 2026-09-27, spikes written but not yet run (see `spikes/README.md`). This
document is the source of truth for the rewrite.

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
| Worker | Cloudflare, Python Worker, free plan | The brain. MCP endpoint, settings and setup app, image route, config in KV, cron jobs, relay mailbox |
| ComfyUI | Modal, a PC, or localhost | The generator. We ship no handler code: ComfyUI's own HTTP API is the interface |
| Modal app | User's Modal workspace | ComfyUI server on an L4, a Volume, a seed function, a small admin web endpoint |
| Agent | GPU owner's PC, via the Go launcher | ComfyUI install and lifecycle, model downloads, idle stop, relays the Worker's ComfyUI calls to local ComfyUI |
| MCPB | Claude Desktop | Stdio shim plus a local server (small tray icon, browser settings) running the same brain against localhost ComfyUI |
| Static site | GitHub Pages | Prerequisites, the Deploy button, then "open your Worker" |
| QoL extension | Browser (existing, owned) | Renders images from `resource_link` items if claude.ai does not |

Separate existing repos, unchanged in role: the Go launcher (`pygo-bootstrap`) and Claude QoL.

### Modes

| Mode | Brain | Config | Generator | Settings UI |
|---|---|---|---|---|
| MCPB | local server | local JSON file | ComfyUI on localhost | localhost page |
| Worker, no GPU | Worker | KV | ComfyUI on Modal | Worker page |
| Worker, GPU | Worker | KV | ComfyUI on the PC via the agent | Worker page |

Rule: MCPB **or** Worker, never both on one machine. Both read the same config schema so switching
keeps settings.

## 3. Generation path

### One client, three transports

A single async ComfyUI client, in the shape of Visual-Novelist's `ComfyUIClient`:

- submit to `/prompt`, tolerating 502/503/504 while a scale-to-zero host boots (`cold_start_s`)
- poll `/history`, detect a worker replaced mid-job (prompt gone from both history and queue after a 5xx)
- fetch outputs from `/view`, upload inputs to `/upload/image`
- auth headers per transport

It is pure Python over `httpx`, so it runs under CPython and Pyodide. Transports:

| Transport | How the client reaches ComfyUI |
|---|---|
| Modal | Direct HTTPS to the deployed server URL with `Modal-Key` / `Modal-Secret` proxy-token headers |
| PC | Through the Worker's Durable Object, which relays HTTP to the agent, which calls its local ComfyUI |
| MCPB | `http://127.0.0.1:<port>` |

### Brain

Packs (JSON: workflow, prompt node, seed and dimension nodes, model URLs, tool descriptions) are
resolved per tool, prompts injected, seeds randomized, dimensions computed, LoRAs spliced. This is
today's `workflow.py`, `model_pack.py` and `tool_specs.py`, made Pyodide-clean.

### Waiting

`tools/call` blocks up to about 4 minutes, returning the image directly. The MCP client timeout is
5 minutes and a cold local start plus generation stays under 2. The request-token path plus
`fetch_result` remains only as a fallback for pathological cases. No cold/warm status vocabulary.

Jobs are stateless: the request token is ComfyUI's own `prompt_id` (plus a `:lossless` marker when
asked). `fetch_result` just resumes polling `/history`, so nothing is kept between requests, which
suits the Worker and survives an MCPB restart.

### Custom workflows

Allowed in every mode, validated against the generator's node inventory. The Modal image's inventory
is dumped at build time into the release manifest. The agent reports its inventory live. Modal
supports only core ComfyUI plus ComfyUI-GGUF. Anything needing other nodes is a local-generator
feature, and the validation message says so.

## 4. Images, references, uploads, edits

- **The generator is the storage.** Modal: ComfyUI's input and output folders live on the Volume, so
  outputs survive scale-to-zero. PC: the agent's disk. MCPB: local paths. No Cloudflare storage, no R2.
- **References are opaque.** Claude sees an id, the brain maps it to a ComfyUI filename it owns. Never
  paths from the model (path traversal on the PC, cross-reading on a shared volume). An id is the
  ComfyUI location signed with an HMAC under the Worker's secret, so it cannot be forged and needs
  no storage (the free KV plan allows only 1,000 writes a day).
- **Results are inline images.** claude.ai does not support `resource_link` (it shows "Resource links
  are not currently supported" and the model sees only the name and URL), while inline
  `ImageContent` is shown to the user and seen by the model (S2). So every result carries the image
  inline as base64, which the Worker builds itself: it fetches `/view?filename=...&preview=jpeg;85`,
  where ComfyUI converts to JPEG before sending (no image work in the Worker), and base64s it. This
  costs about 10 ms of Worker CPU per MB of JPEG (S2b). If a JPEG comes back over about 700 KB, the
  Worker asks again at a lower quality.
- **Image URLs.** A Worker route behind the secret path resolves a reference and streams the
  full-resolution PNG from `/view` over the right transport. Each result's text block carries the
  image id and this URL for the user. No `resource_link`.
- **Edits** are `LoadImage` by reference inside the generator; a prior output loads directly as
  `"<name> [output]"` (S5). Only results pass image bytes through the Worker.
- **Uploads from claude.ai** use the code-execution sandbox. A `request_upload` tool returns a
  one-time URL plus the snippet to run. The sandbox posts the attached file, the Worker forwards it
  to ComfyUI's `/upload/image`, the tool result carries the reference, and `edit_image` takes it.
  Attached files stay available in the sandbox for the conversation, so the upload happens when the
  edit is requested. The tool description covers the case where code execution is off: ask the user
  to enable it or give a URL.
- `edit_image` accepts an upload reference, a previous output reference, or an https URL.

## 5. Config and settings

- Config lives with the brain: KV for the Worker, a local JSON file for the MCPB.
- One Svelte settings app, rendered from the declarative settings schema, served by the Worker
  (behind the setup password, cookie session) and by the MCPB's local server.
- One idle setting, "keep warm for N minutes", applies to Modal's `scaledown_window` and to the
  agent's idle stop.
- If both the PC and Modal are configured, the PC is used when online and Modal when it is not.

## 6. Setup flows

### No GPU

1. Static site: prerequisites (Cloudflare, GitHub, Modal with a card on file), then the Deploy button.
2. The button copies the bootstrap into the user's GitHub and deploys via Workers Builds. The user
   sets a setup password in the deploy prompt.
3. The user opens the Worker's setup page, logs in, pastes a **user-scoped** Cloudflare API token and
   a Modal token pair. The setup page validates each with a harmless call before accepting it.
   The token comes from a pre-filled template link (below), so the user only picks their account
   and clicks Create.
4. The Worker finds its own tag and build trigger, writes the Modal tokens and a one-time nonce into
   the trigger's build secrets, and starts a build through the Workers Builds API.
5. The build (Python 3.13 and pip in Cloudflare's build image) fetches the latest release, runs
   `modal deploy` with the official SDK, mints a proxy token, posts the server URL and proxy token to
   the Worker with the nonce, then deploys the Worker.
6. The setup page streams the build logs, then shows ready. The user picks packs. The Worker calls
   the Modal admin endpoint to seed models onto the Volume.
7. The user copies the connector URL into claude.ai.

### GPU owner

Steps 1 to 3 without the Modal token. Download the agent through the launcher, paste the pairing
code. The agent auto-starts at boot, starts ComfyUI on the first job, stops it after the idle window.
Modal can be added later as the fallback.

### Claude Desktop only

Install the MCPB. It stays self-updating through the existing bootstrapper. No accounts.

## 7. Updates

- **Hot data:** packs, tool descriptions and workflow templates come from a manifest the Worker
  fetches from the repo, pinned to a major version, cached in KV. No build needed.
- **Code:** the Worker's cron checks releases. On a new one it starts a Workers Build. The build
  script always fetches the release, so the user's copy never goes stale and there is no fork sync.
  One build updates both the Worker and the Modal app.
- **Agent:** through the launcher, as today.
- **MCPB:** through its bootstrapper, as today.
- No token, no updates. There is no fallback path to maintain.

## 8. Secrets and auth

| Secret | Held by | Purpose |
|---|---|---|
| MCP secret path | Worker KV | The connector URL. OAuth is a later upgrade |
| Setup password | Worker secret | Settings and setup pages, cookie session |
| Cloudflare user token | Worker secret | Workers Builds API and deploys (see "Cloudflare token" below) |
| Modal token pair | Build secrets only | `modal deploy` during builds |
| Modal proxy token | Worker KV | Calls to the ComfyUI server and admin endpoint |
| Agent pairing secret | Worker KV, agent | Authenticates the relay |
| Build nonce | Build secrets, Worker KV | One-time callback from the build |

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
  | `workers_kv_storage` | edit | Workers KV Storage |
  | `account_settings` | read | Account Settings |
  | `workers_ci` | edit | Workers Builds Configuration |
  | `workers_observability` | read | Workers Observability |

  The new role-style "Workers: Admin" permission should be added too, for when the legacy ones are
  retired; its template key is not documented yet and still has to be found.
- **Account choice.** The link must use `accountId=*` because the Worker cannot know its account id
  in advance, which pre-fills "All accounts". The setup page tells the user to narrow it to their
  own account (a token on every account they belong to, an employer's included, is needlessly
  broad). The Worker then finds the account it lives in by listing the token's accounts.
- The dashboard's "Entire Account" resource option on the newer account-token page is only a
  resource scope, not "all permissions"; worth a line in the setup page if users end up there.

## 9. Relay (PC generator)

- A Durable Object per Worker is the rendezvous. A Worker has no memory between requests, so the
  waiting `tools/call` and the agent need a shared addressable object to meet in.
- The agent holds an outbound connection and relays ComfyUI HTTP calls to its local instance.
- Preferred: WebSocket with the hibernation API, near-zero cost when idle. Fallback: long-poll, which
  keeps the object active around the clock. At 128 MB that is about 10,800 GB-s a day, close to the
  free allowance, so hibernation decides whether the relay is free.
- If Python Durable Objects cannot hibernate cleanly, the object is a small TypeScript class in the
  same Worker.

## 10. Repository

**One authored repository**, a uv workspace:

| Package | Contents | Must run under |
|---|---|---|
| `core` | packs (as package data), workflow build, tool specs, ComfyUI client, brain, settings schema | CPython and Pyodide |
| `local` | ComfyUI install, launch, stop, downloads, node install, idle stop, tray; shared by `agent` and `mcpb` | CPython |
| `worker` | Worker entry, MCP, KV config, routes, Durable Object, Builds API, setup | Pyodide |
| `modal_app` | Modal app file, admin endpoint, build script | CPython (Modal, build image) |
| `agent` | ComfyUI lifecycle, downloads, idle stop, relay client, tray | CPython |
| `mcpb` | stdio shim, local server | CPython |
| `web` | Svelte settings and setup app | browser |
| `site` | static landing page | browser |
| `bootstrap` | what the Deploy button copies: wrangler config, `.env.example`, build script that fetches the release | Workers Builds |

Tests run `core` under both CPython and Pyodide.

Packs ship inside `core` as package data rather than as a separate directory, so the Worker bundle,
the MCPB checkout and the agent all get them without extra packaging. A hot pack manifest in KV can
override them later.

`local` exists because the MCPB and the agent do the same job on a user's machine (keep a ComfyUI
installed, fed and running only when needed) and must share that code.

The Deploy button points at the `bootstrap` folder. If the button copies the whole repository
rather than the folder, `bootstrap` becomes a tiny second repository. It rarely changes because the
build fetches the release.

Existing installs update from `github.com/lugia19/comfy-dxt.git`, the repository's former name,
which GitHub redirects to `comfy-gen-mcp`. So never create a new repository named `comfy-dxt` or
`comfy-gen-mcp` under this account, and never delete the old one while installs exist. Archiving is
safe: an archived repository still serves pulls.

The current `comfy-gen-mcp` stays in maintenance for existing users until the agent ships, then gets
a final "install the new version" commit and is archived. Its `main` is a live update channel, which
is why the rewrite does not happen in place.

Later: the ComfyUI client and the Modal app can become shared with Visual-Novelist.

## 11. Decisions and rejected alternatives

| Rejected | Why |
|---|---|
| Always-on RunPod CPU pod hosting the server | Bills around the clock |
| TypeScript Worker | Python Workers support the MCP SDK and keep one language |
| RunPod serverless | Superseded by Modal in Visual-Novelist: cheap pools often unstocked, volume pins a datacenter |
| Our own job handler and Docker image | Modal serves ComfyUI's own API; ComfyUI is the worker everywhere |
| R2 or KV for image storage | The generator already holds the files; R2 needs a card on file |
| QoL or settings-page uploads | The model would not know which reference to use; the sandbox upload keeps it in context |
| Fork-sync GitHub Action | More code; the token-driven build covers updates |
| Qt desktop app for cloud modes | Settings moved to the web; the PC side is a daemon |
| Cold/warm status in results | A blocking call fits inside the client timeout |
| Modal Sandboxes over gRPC | Outbound gRPC from Workers is private beta, browsers cannot reach Modal's API (no CORS, no gRPC-web), and Sandboxes would make us own lifecycle and an undocumented protocol |
| Worker uploading over its own script | Replaced by Workers Builds, which also updates Modal |

## 12. Spikes, in order

Each result gets one line with the number observed and the date. The spike code and the run
checklist are in `spikes/`.

1. **Python Worker with the MCP SDK** as a claude.ai connector. CPU time per `tools/call` against the
   10 ms free budget.
2. **Rendering:** `resource_link` only, link plus text URL, link plus small inline image. Web,
   Desktop, mobile, QoL off. Ask Claude to describe the image each time.
3. **Sandbox upload** round trip to ComfyUI `/upload/image` and back as a reference.
4. **Workers Builds:** a button-created Worker finds its own trigger; the build image runs
   `pip install modal` and `modal deploy`; outbound callback from the build; free build minutes;
   whether the button copies only a subdirectory.
5. **Modal:** input and output folders on the Volume survive a cold start; edit a prior output by
   filename after one; admin endpoint spawns the seed and uploads a LoRA; a warm ComfyUI container
   sees a LoRA written by another container (reload, or stop the container); `update_autoscaler`
   callable from inside a Modal function.
6. **Durable Object hibernation** in Python, one idle agent connected for a day, duration read from
   the dashboard.
7. **pywrangler** vendors a uv workspace sibling.
8. **Blocking time:** how long a `tools/call` may block before each client (web, Desktop, mobile)
   gives up. Section 3's "about 4 minutes" rests on this.

### Results

**S1, 2026-09-28: the MCP SDK does not run on the free plan; a hand-rolled handler does.** 20 calls
each through the deployed Worker (Python 3.14, Workers Logs `cpuTimeMs`):

- Hand-rolled stateless JSON-RPC (`initialize`, `tools/list`, `tools/call`, `ping`): all 20 `ok`,
  CPU 3 to 52 ms, typically about 18 ms. The free plan tolerated calls over the nominal 10 ms, but
  the margin is thin: per-call work in the Worker must stay small.
- MCP SDK 2.2.0 (`MCPServer`, stateless, JSON responses): every fresh isolate spent about 2,000 ms
  CPU importing it and building the app, was killed (Error 1102), and left the isolate broken
  (later requests: Error 1101, Pyodide "promising task" and "GIL not held" errors). The SDK was
  imported lazily on its first request; importing it at module level (inside the deploy snapshot)
  was not tried, but the per-isolate app build would remain.
- **Decision:** the Worker serves MCP with its own small stateless handler. No MCP SDK in the Worker.

**S1b, 2026-09-28: where the handler's CPU goes.** SDK removed from the bundle (vendored modules
18.7 MiB to 232 KiB, upload 137 KiB), per-request log line dropped, request-independent JSON
serialized at import (inside the startup snapshot), plus a `/noop` route returning a constant.
90 calls, interleaved, 5 s apart, all `ok`:

| Route | Median CPU | Range | Calls at 10 ms or more |
|---|---|---|---|
| `/noop` (bare Python request) | 3.5 ms | 2 to 18 | 8 of 30 |
| MCP `tools/call` `ping` | 7.5 ms | 2 to 44 | 14 of 30 |
| MCP `tools/call` `image_inline` | 5 ms | 3 to 27 | 11 of 30 |

- The distribution is two clusters: 2 to 6 ms, and 8 to 20 ms. The second cluster appears even for
  `/noop`, so it is the Python runtime (a fresh or re-initialising isolate), not our code. Our
  handler adds about 2 to 5 ms on top of the floor.
- Slimming the bundle lowered the fresh-isolate cost somewhat (S1: 18 to 29 ms, now mostly 10 to
  20) but cannot remove it. Nothing on the Python side gets a fresh isolate under 10 ms.
- Cloudflare did not enforce 10 ms per request: 110 raw-handler calls across S1 and S1b, up to
  52 ms, all succeeded. The SDK's 2,000 ms was killed. So there is a real ceiling well above
  10 ms, but it is not documented; treat it as unknown and keep per-call work small.
- **Decision:** stay on the Python Worker. Rules for the product: nothing request-independent
  computed per request, no heavy imports, minimal logging on the MCP path, and the brain's
  per-call work (pack lookup, workflow build) kept to plain dict work. If CPU enforcement ever
  bites, the fallback is a thin JS front Worker that answers `initialize`, `tools/list` and `ping`
  itself and passes only `tools/call` to Python.

**S4, 2026-09-28: works, with three template lessons.**

- The Deploy button created `lugia19/comfy-gen-spike-button` from the `spikes/bootstrap` folder and
  pre-filled the deploy command from `package.json` (`npm run deploy`).
- Workers Builds runs its own dependency install before the deploy command: it detected `bun` and
  `uv` and ran `bun install` and `uv sync` on whatever `package.json` / `pyproject.toml` the repo
  has. The first build failed there because the template's `pyproject.toml` referenced files the
  deploy script had not fetched yet. `SKIP_DEPENDENCY_INSTALL=1` disables it. **Lesson: the
  template holds no `pyproject.toml`; the project file arrives with the fetched release.**
- **The template's deploy command is a one-line stub that downloads the real deploy script** at
  build time (`curl -fsSL <raw GitHub URL> | bash`). A button copy is a frozen snapshot, so anything
  else in it goes stale. Tested by switching the trigger to the stub via the API (builds 4 and 5).
- From inside the Worker, with a user token: found its own account, tag and trigger from its
  workers.dev hostname (the only runtime clue to its name), wrote build variables (0.7 s), started
  builds. Build logs and status are readable through the API.
- Build image: Python 3.13.3, `pip install uv modal` 12 s, outbound network to GitHub, PyPI, Modal
  (gRPC) and workers.dev all work.
- `modal deploy` from the build: 17 s on the first run, 8 s after (the ComfyUI base image matched
  Visual-Novelist's and was cached by Modal).
- Build durations: 1.5 to 2.4 min for a deploy (pywrangler about 1.5 min of it); 7.2 min with a full
  S5 driver run inside. Five builds used 13.5 of the 3,000 free minutes a month.
- **Callbacks from Python need a custom `User-Agent`.** Cloudflare answers urllib's default
  `Python-urllib/x.y` with Error 1010 (403) on workers.dev before the Worker runs. `wrangler dev`
  does not apply this check, so local tests miss it.

**S5, 2026-09-28: the generator-as-storage design holds on Modal.** Run from inside a Workers Build
(this development container cannot reach Modal's gRPC API):

- Cold start to `/prompt` accepted: 43.8 s and 44.1 s (L4, image with ComfyUI-GGUF). Warm: 0.5 s.
- (a) Outputs written to the Volume-backed output folder survive scale-to-zero (`/view` after a cold
  start: 200). The explicit commit in the server's exit hook was in place; whether Modal's automatic
  commit alone suffices for Servers was not isolated.
- (b) `LoadImage` with `"<name> [output]"` loads a prior output directly after a cold start. Edits
  need no copy step: an output reference feeds an edit as is.
- (c) Files uploaded through `/upload/image` survive scale-to-zero.
- (d) A warm ComfyUI does **not** see a LoRA committed by another container within 90 s. With a
  `volume.reload()` every 10 s in the server container, it sees it after 12.4 s. Caveat: no model was
  loaded in the spike. Modal documents that a reload fails while Volume files are open and that the
  Volume appears empty to the container during a reload, so the product should reload only while
  idle (or restart the container after an upload). Needs one check with a real model loaded.
- (e) `update_autoscaler` works from inside a Modal function (0.5 s), so "keep warm" applies live.
- (f) Admin endpoint behind proxy auth spawns the seed function: 335 MB in 26 s with progress.
- (g) `comfy node registry-install ComfyUI-GGUF` works in the image; `UnetLoaderGGUF` loads.

**S7, 2026-09-27/28: works.** `pywrangler sync` vendors a uv workspace sibling (declared with
`workspace = true, editable = false`) as a normal, non-editable install in `python_modules/`
(local). A path dependency deployed through the button imports in production (Python 3.14.2).

**Tokens, 2026-09-27: see section 8.** User token only; template link verified.

**S2, 2026-09-28 (claude.ai web): only inline images work.** `resource_link` alone, or with a text
block carrying its URL: claude.ai shows "Resource links are not currently supported" and the model
gets only name, URL and mime type. Inline `ImageContent`: shown to the user, described correctly by
the model. Both together: the image comes through, the link is ignored. Section 4 follows from this.

**S2b, 2026-09-28: inline results cost about 10 ms CPU per MB.** `big_image` fetches a JPEG over
HTTP and returns it inline through the MCP handler (the product's result path). 15 calls each,
interleaved, 5 s apart, all `ok`:

| Inline JPEG | Median CPU | Range |
|---|---|---|
| none (`/noop`) | 8 ms | 2 to 38 |
| 243 KB | 15 ms | 7 to 62 |
| 608 KB | 19 ms | 11 to 52 |
| 1.18 MB | 26 ms | 17 to 116 |

Cloudflare let every call through, up to 116 ms. A real 1 MP JPEG at quality 85 is usually well
under the 608 KB noise test image, so a typical result should land around 10 to 20 ms. Decision:
full-size inline JPEG, re-requested at lower quality above about 700 KB.

**S3, 2026-09-28: works.** From a claude.ai chat with code execution on, the model called
`request_upload`, ran the returned snippet, and `show_upload` returned the attached image.

**S8, 2026-09-28: the client timeout is 5 minutes.** A tool call blocks for up to about 4 minutes,
then returns a request token (section 3).

**Still open:** S6 (Durable Object day), running on the user's machine since 2026-09-28; S2 on
Desktop and mobile (web tested).

## 13. Phases

1. New repository skeleton: uv workspace, `core` extracted and tested under both Pythons, MCPB
   rebuilt on it at behavior parity.
2. **First release:** Worker with Modal, settings limited to packs and tokens, setup flow, Deploy
   button, Builds-driven deploy and update, static site.
3. Full settings (LoRAs, artists, custom workflows), sandbox uploads, rendering decision applied.
4. Agent and relay. Retire the old standalone exe and archive the old repository.

## 14. Reference numbers

| Fact | Value | Source, date |
|---|---|---|
| Workers free CPU per request | 10 ms | Cloudflare limits, 2026-09-18 |
| Python Worker cold start with FastAPI, httpx, pydantic | about 1 s | Cloudflare blog |
| Modal cold start / warm portrait, L4 | about 35 s / about 5 s | Visual-Novelist, 2026-09-27 |
| Modal free compute | $30 a month, card required | Visual-Novelist packaging docs |
| MCP `ImageContent` in claude.ai | Shown collapsed in the tool block; model sees it | anthropics issue trackers, April 2026 |
| Builds API token | User-scoped only: an account token with Workers CI Write gets "Invalid token" (12006) | Tested, 2026-09-27 |
| Token template link | Pre-fills all five permissions on the user-token page | Tested, 2026-09-27 |
