# Comfy-Gen-MCP design

Status: design settled 2026-09-28 after the infrastructure spikes (results in the appendix; S6 still
running). This document is the source of truth for the rewrite; `docs/build-plan.md` is the build
order.

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

Separate existing repo, unchanged in role: the Go launcher (`pygo-bootstrap`).

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

The client speaks to ComfyUI through a small `Transport` protocol (one HTTP request in, status,
headers and body out), so the same code runs under CPython and Pyodide and the relay can carry
requests as plain data. Transports:

| Transport | How the client reaches ComfyUI |
|---|---|
| Modal | JS `fetch` from the Worker to the deployed server URL with `Modal-Key` / `Modal-Secret` proxy-token headers |
| PC | Through the Worker's Durable Object, which relays HTTP to the agent, which calls its local ComfyUI |
| MCPB | `httpx` to `http://127.0.0.1:<port>` |

### Brain

Packs (JSON: workflow, prompt node, seed and dimension nodes, model URLs, tool descriptions) are
resolved per tool, prompts injected, seeds randomized, dimensions computed, LoRAs spliced. This is
the old `workflow.py`, `model_pack.py` and `tool_specs.py`, made Pyodide-clean, plus the MCP handler.

### MCP

A hand-rolled, stateless JSON-RPC handler in `core` serves `initialize`, `ping`, `tools/list` and
`tools/call` with one JSON body per POST (no sessions, no SSE). The official MCP SDK costs about
2 s of CPU per fresh Worker isolate and is killed on the free plan (S1). The Worker and the MCPB's
local server both use the handler; only the MCPB's stdio shim, a separate CPython process, uses the
SDK.

### Waiting

`tools/call` blocks up to about 4 minutes, returning the image directly. The MCP client timeout is
5 minutes (S8) and a cold start plus generation stays under 2. The request-token path plus
`fetch_result` remains only as a fallback for pathological cases. No cold/warm status vocabulary.

Jobs are stateless: the request token is ComfyUI's own `prompt_id` (plus a `:lossless` marker when
asked). `fetch_result` just resumes polling `/history`, so nothing is kept between requests, which
suits the Worker and survives an MCPB restart.

### Worker CPU budget

The free plan's nominal limit is 10 ms of CPU per request. A bare Python request costs about 3 ms,
and 10 to 20 ms on a fresh isolate; Cloudflare tolerated calls up to 116 ms in the spikes but the
real ceiling is undocumented (S1b, S2b). Rules for Worker code:

- no heavy imports (no pydantic-based libraries, no MCP SDK)
- anything request-independent is computed or serialized at import, which happens once inside the
  deploy-time snapshot
- no logging on the MCP path
- per-call work is plain dict work; image bytes are only base64'd, never decoded

If enforcement ever tightens, the fallback is a thin JS front Worker that answers `initialize`,
`tools/list` and `ping` itself and passes only `tools/call` to Python.

### Custom workflows

Allowed in every mode, validated against the generator's node inventory. The Modal image's inventory
is dumped at release time into `inventory.json`. The agent reports its inventory live. Modal
supports only core ComfyUI plus ComfyUI-GGUF. Anything needing other nodes is a local-generator
feature, and the validation message says so.

## 4. Images, references, uploads, edits

- **The generator is the storage.** Modal: ComfyUI's input and output folders live on the Volume, so
  outputs survive scale-to-zero (S5). PC: the agent's disk. MCPB: local paths. No Cloudflare
  storage, no R2.
- **References are opaque.** Claude sees an id, the brain maps it to a ComfyUI filename it owns. Never
  paths from the model (path traversal on the PC, cross-reading on a shared volume). An id is the
  ComfyUI location signed with an HMAC under the Worker's secret, so it cannot be forged and needs
  no storage (the free KV plan allows only 1,000 writes a day).
- **Results are inline WebP.** claude.ai does not support `resource_link` (it shows "Resource links
  are not currently supported" and the model sees only the name and URL), while inline
  `ImageContent` is shown to the user and seen by the model, WebP included (S2, S2c). Every result
  carries the image inline as base64. The Worker fetches `/view?filename=...&preview=webp;90`,
  where ComfyUI converts with PIL before sending (about 0.1 s on the generator, nothing in the
  Worker), and base64s it: about 10 ms of Worker CPU per MB (S2b). If the WebP comes back over about
  700 KB, the Worker asks again at quality 75. The MCPB encodes WebP q90 itself with Pillow (PNG
  when `:lossless` is asked).
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

## 5. Config and settings

- Config lives with the brain: KV for the Worker, a local JSON file for the MCPB.
- One Svelte settings app, rendered from the declarative settings schema, served by the Worker
  (behind the setup password, cookie session) and by the MCPB's local server.
- One idle setting, "keep warm for N minutes", applies to Modal's `scaledown_window` (live, through
  `update_autoscaler`, S5) and to the agent's idle stop.
- If both the PC and Modal are configured, the PC is used when online and Modal when it is not.

## 6. Setup flows

### No GPU

1. Static site: prerequisites (Cloudflare, GitHub, Modal with a card on file), then the Deploy button.
2. The button copies the bootstrap into the user's GitHub and deploys via Workers Builds. The user
   sets a setup password in the deploy prompt.
3. The user opens the Worker's setup page, logs in, pastes a **user-scoped** Cloudflare API token and
   a Modal token pair. The setup page validates each with a harmless call before accepting it.
   The token comes from a pre-filled template link (section 8), so the user only narrows it to their
   account and clicks Create.
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

- **Worker and Modal app:** the Worker's cron checks the latest GitHub release against its own
  version. On a new one it starts a Workers Build. The template's deploy command is a stub that
  downloads the release's `deploy.sh`, so the user's copy never goes stale and there is no fork
  sync. One build updates both the Worker and the Modal app. Packs, tool descriptions and workflow
  templates ship with the code: a new pack is a release.
- **Agent:** through the launcher, as today.
- **MCPB:** through its bootstrapper, as today.
- No token, no updates. There is no fallback path to maintain.

## 8. Secrets and auth

| Secret | Held by | Purpose |
|---|---|---|
| MCP secret path | Worker KV | The connector URL. OAuth is a later upgrade |
| Setup password | Worker secret | Settings and setup pages, cookie session |
| Cloudflare user token | Worker KV | Workers Builds API: builds for setup and updates |
| Modal token pair | Build secrets only | `modal deploy` during builds |
| Modal proxy token | Worker KV | Calls to the ComfyUI server and admin endpoint |
| Ref HMAC key | Worker KV | Signs image references and upload tokens |
| Agent pairing secret | Worker KV, agent | Authenticates the relay |
| Build nonce | Build secrets, Worker KV | One-time callback from the build |

Any Python code that calls a Worker (build callbacks, the upload snippet, the agent) sends its own
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
- The agent holds an outbound WebSocket, accepted with the hibernation API; `ping`/`pong` text
  frames are answered by the runtime without waking the object. A `tools/call` sends a request down
  the socket and awaits the reply with the same id. Round trip Worker to agent and back: 19 to 37 ms
  (S6). The day-long cost is being measured (S6).
- The Durable Object and its migration are declared in the bootstrap template from the first
  release, so adding the PC path later needs no template change.

## 10. Repository

**One authored repository**, a uv workspace:

| Package | Contents | Must run under |
|---|---|---|
| `core` | packs (as package data), workflow build, tool specs, ComfyUI client, brain, MCP handler, settings schema | CPython 3.12+ and Pyodide |
| `worker` | Worker entry, KV config, routes, render, Durable Object, Builds API, setup, updates | Pyodide (Python 3.14) |
| `modal_app` | Modal app file, admin endpoint, build-time deploy script | CPython (Modal, build image) |
| `local` | ComfyUI install, launch, stop, downloads, node install, idle stop, tray; shared by `agent` and `mcpb` | CPython |
| `mcpb` | stdio shim, local server | CPython |
| `agent` | `local` plus the relay client | CPython |
| `web` | Svelte settings and setup app | browser |
| `site` | static landing page | browser |
| `bootstrap` | what the Deploy button copies: wrangler config, `package.json` with the deploy stub, `.dev.vars.example` | Workers Builds |

`worker` is a standalone pywrangler project outside the uv workspace, depending on `core` by path
(`editable = false`, S7): a workspace takes the intersection of its members' `requires-python`,
and the Worker needs 3.14 while the MCPB's runtime is 3.12.

Tests run `core` under both CPython and Pyodide.

Packs ship inside `core` as package data, so the Worker bundle, the MCPB checkout and the agent all
get them without extra packaging.

`local` exists because the MCPB and the agent do the same job on a user's machine (keep a ComfyUI
installed, fed and running only when needed) and must share that code.

The Deploy button points at the `bootstrap` folder; the button copies only that folder (S4). The
template holds no `pyproject.toml`, because Workers Builds runs `uv sync` on any it finds before the
deploy command (S4); the project file comes with the fetched release.

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
| TypeScript Worker | One language across Worker, MCPB and agent; the Python Worker fits the CPU budget once the MCP SDK is out (S1b) |
| MCP SDK in the Worker | About 2 s CPU per fresh isolate, killed on the free plan (S1) |
| `resource_link` results | Not supported by claude.ai; the model sees only a name and URL (S2) |
| RunPod serverless | Superseded by Modal in Visual-Novelist: cheap pools often unstocked, volume pins a datacenter |
| Our own job handler and Docker image | Modal serves ComfyUI's own API; ComfyUI is the worker everywhere |
| R2 or KV for image storage | The generator already holds the files; R2 needs a card on file |
| QoL or settings-page uploads | The model would not know which reference to use; the sandbox upload keeps it in context |
| Hot pack manifest in KV | A second update path; a release build takes about 2 minutes and runs automatically |
| Fork-sync GitHub Action | More code; the token-driven build covers updates |
| Qt desktop app | Settings moved to the web; the PC side is a daemon with a small tray |
| Cold/warm status in results | A blocking call fits inside the client timeout |
| Modal Sandboxes over gRPC | Outbound gRPC from Workers is private beta, browsers cannot reach Modal's API (no CORS, no gRPC-web), and Sandboxes would make us own lifecycle and an undocumented protocol |
| Worker uploading over its own script | Replaced by Workers Builds, which also updates Modal |

## 12. Phases

The order puts first what can be built and tested without Modal, Windows or a GPU (see
`docs/build-plan.md`):

1. `core`, tested under CPython and Pyodide.
2. Worker, web app, bootstrap, release pipeline: the cloud path, tested against any reachable
   ComfyUI.
3. Modal app and the **first release** (no-GPU users).
4. Full cloud settings: LoRAs, artists, custom workflows, sandbox uploads.
5. `local` and the MCPB at parity with the old extension.
6. Agent and relay. Then retire the old repository.

## 13. Reference numbers

| Fact | Value | Source, date |
|---|---|---|
| Workers free CPU per request | 10 ms nominal; up to 116 ms tolerated in tests | Cloudflare limits; S1b/S2b, 2026-09-28 |
| Python Worker request, bare | about 3 ms; 10 to 20 ms on a fresh isolate | S1b, 2026-09-28 |
| Inline image cost in the Worker | about 10 ms CPU per MB | S2b, 2026-09-28 |
| Modal cold start / warm, L4 | about 44 s / 0.5 s to accept a prompt | S5, 2026-09-28 |
| Modal free compute | $30 a month, card required | Modal pricing and billing docs |
| Workers Builds | 3,000 free minutes a month, 1 concurrent; a deploy takes 1.5 to 2.4 min | S4, 2026-09-28 |
| MCP client timeout | 5 minutes | S8, 2026-09-28 |
| Builds API token | User-scoped only: an account token with Workers CI Write gets "Invalid token" (12006) | Tested, 2026-09-27 |
| Token template link | Pre-fills all five permissions on the user-token page | Tested, 2026-09-27 |

## Appendix: spike results

The spike code lives in `spikes/` until S6 is recorded, then it is deleted.

**S1, 2026-09-28: the MCP SDK does not run on the free plan; a hand-rolled handler does.** 20 calls
each through the deployed Worker (Python 3.14, Workers Logs `cpuTimeMs`):

- Hand-rolled stateless JSON-RPC: all 20 `ok`, CPU 3 to 52 ms, typically about 18 ms.
- MCP SDK 2.2.0 (`MCPServer`, stateless, JSON responses): every fresh isolate spent about 2,000 ms
  CPU importing it and building the app, was killed (Error 1102), and left the isolate broken
  (later requests: Error 1101, Pyodide "promising task" and "GIL not held" errors). The SDK was
  imported lazily on its first request; importing it inside the deploy snapshot was not tried, but
  the per-isolate app build would remain.

**S1b, 2026-09-28: where the handler's CPU goes.** SDK removed from the bundle (vendored modules
18.7 MiB to 232 KiB), per-request log line dropped, request-independent JSON serialized at import,
plus a `/noop` route returning a constant. 90 calls, interleaved, 5 s apart, all `ok`:

| Route | Median CPU | Range | Calls at 10 ms or more |
|---|---|---|---|
| `/noop` (bare Python request) | 3.5 ms | 2 to 18 | 8 of 30 |
| MCP `tools/call` `ping` | 7.5 ms | 2 to 44 | 14 of 30 |
| MCP `tools/call` `image_inline` | 5 ms | 3 to 27 | 11 of 30 |

The distribution has two clusters, 2 to 6 ms and 8 to 20 ms; the second appears even for `/noop`,
so it is the Python runtime (a fresh or re-initialising isolate), not our code. The handler adds
about 2 to 5 ms. 110 raw-handler calls across S1 and S1b, up to 52 ms, all succeeded.

**S2, 2026-09-28 (claude.ai web): only inline images work.** `resource_link` alone, or with a text
block carrying its URL: claude.ai shows "Resource links are not currently supported" and the model
gets only name, URL and mime type. Inline `ImageContent`: shown to the user, described correctly by
the model. Both together: the image comes through, the link is ignored. Desktop and mobile not yet
checked.

**S2b, 2026-09-28: inline results cost about 10 ms CPU per MB.** A tool fetches a JPEG over HTTP
and returns it inline through the MCP handler (the product's result path). 15 calls each,
interleaved, 5 s apart, all `ok`:

| Inline image | Median CPU | Range |
|---|---|---|
| none (`/noop`) | 8 ms | 2 to 38 |
| 243 KB | 15 ms | 7 to 62 |
| 608 KB | 19 ms | 11 to 52 |
| 1.18 MB | 26 ms | 17 to 116 |

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

**S6, running since 2026-09-28 11:20 UTC.** A stand-in agent on the user's PC holds the WebSocket.
Relay round trip Worker to agent and back: 19 to 37 ms. Day-long Durable Object duration: pending.

**S7, 2026-09-27/28: works.** `pywrangler sync` vendors a uv workspace sibling (declared with
`workspace = true, editable = false`) as a normal install in `python_modules/`; a path dependency
deployed through the button imports in production (Python 3.14.2).

**S8, 2026-09-28: the client timeout is 5 minutes.**
