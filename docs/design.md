# Comfy-Gen-MCP design

Status: design settled 2026-09-28 after the infrastructure spikes (results in the appendix). `core` and the Worker moved from Python to TypeScript the same day, after the Worker's CPU
was measured (appendix, "CPU of a Python Worker"). This document is the source of truth for the
rewrite; `docs/build-plan.md` is the build order.

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
| Worker | Cloudflare, Python Worker, free plan | The brain. MCP endpoint, settings and setup app, image route, config in a Durable Object, cron jobs, relay mailbox |
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
| Worker, no GPU | Worker | State Durable Object | ComfyUI on Modal | Worker page |
| Worker, GPU | Worker | State Durable Object | ComfyUI on the PC via the agent | Worker page |

Rule: MCPB **or** Worker, never both on one machine. Both read the same config schema so switching
keeps settings.

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
5 minutes (S8) and a cold start plus generation stays under 2. The request-token path plus
`fetch_result` remains only as a fallback for pathological cases. No cold/warm status vocabulary.

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

If generations ever need to come under 10 ms, the next step is a long-poll endpoint in front of
ComfyUI on Modal, so a generation makes about 3 fetches instead of about 20.

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
  no storage.
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

- Config lives with the brain: the `State` Durable Object for the Worker (Workers KV caches reads
  at the edge for up to a minute, which gave stale reads and lost updates live; see §11), a local
  JSON file for the MCPB.
- One Svelte settings app, rendered from the declarative settings schema, served by the Worker
  (behind a Cloudflare-token login and a cookie session) and by the MCPB's local server.
- One idle setting, "keep warm for N minutes", applies to Modal's `scaledown_window` (live, through
  `update_autoscaler`, S5) and to the agent's idle stop.
- If both the PC and Modal are configured, the PC is used when online and Modal when it is not.

## 6. Setup flows

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
| MCP secret path | Worker state | The connector URL. OAuth is a later upgrade |
| Cloudflare user token | Worker state | Login to the settings pages; Workers Builds API for setup and updates |
| Session cookie key | Worker state | Signs the settings pages' session cookie (a year) |
| Modal token pair | Build secrets only | `modal deploy` during builds |
| Modal proxy token | Worker state, Modal Dict | Calls to the ComfyUI server and admin endpoint |
| Ref HMAC key | Worker state | Signs image references and upload tokens |
| Agent pairing secret | Worker state, agent | Authenticates the relay |
| Build nonce | Build secrets, Worker state | One-time callback from the build |

**Login.** There is no setup password. A fresh install's URL is not secret: the Worker name is the
template's `comfy-gen` for nearly everyone, and each account's workers.dev subdomain is public in
Certificate Transparency logs (its wildcard certificate). So "the first visitor claims it" would let
anyone scanning those logs claim installs before their owners. The Deploy button takes only the
template URL (no name, secret or variable parameters), so nothing random can reach the deploy
either. Instead, logging in means pasting a Cloudflare user token that can see this Worker
(`scripts-search` on its name finds it in the token's accounts), which only the account's owner can
make. Setup needs that token anyway; the latest one replaces the stored one. The session cookie
lasts a year; a new browser logs in with a fresh token from the same link. Under `pywrangler dev`,
`DEV_WORKER_HOST` names the deployed Worker to prove ownership of.

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
  (S6). An idle connection costs nothing measurable; drops come every few minutes to few hours, so
  the agent reconnects at once and the Worker waits briefly for it (S6).
- The Durable Object and its migration are declared in the bootstrap template from the first
  release, so adding the PC path later needs no template change.

## 10. Repository

**One authored repository.** TypeScript in npm workspaces, plus the Python that runs on Modal:

| Package | Contents | Runs in |
|---|---|---|
| `core` | packs (JSON), workflow build, tool specs, ComfyUI client, refs, brain, MCP handler, settings schema | Workers and Node (Web-platform APIs only) |
| `worker` | Worker entry, State and Relay Durable Objects, routes, render, Builds API, setup, updates; the build step `deploy/deploy.{sh,py}` | Workers (the build step: Workers Builds) |
| `modal_app` | Modal app, admin endpoint, build-time deploy script | Python (Modal, build image) |
| `local` | ComfyUI install, launch, stop, downloads, node install, idle stop, tray; shared by `agent` and `mcpb` | Node |
| `mcpb` | stdio shim, local server | Node (Claude Desktop's bundled runtime) |
| `agent` | `local` plus the relay client | Node |
| `web` | Svelte settings and setup app | browser |
| `site` | static landing page | browser |
| `bootstrap` | what the Deploy button copies: wrangler config and `package.json` with the deploy stub | Workers Builds |

`core` exports its TypeScript source directly (no build step): wrangler bundles it into the Worker,
and the MCPB and agent will bundle it too. `web` stays outside the workspaces with its own lockfile,
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

## 12. Phases

The order puts first what can be built and tested without Modal, Windows or a GPU (see
`docs/build-plan.md`):

1. `core` (Python first, ported to TypeScript after M3's CPU measurements).
2. Worker, web app, bootstrap, release pipeline: the cloud path, tested against any reachable
   ComfyUI.
3. Modal app and the **first release** (no-GPU users).
4. Full cloud settings: LoRAs, artists, custom workflows, sandbox uploads.
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

**M2 live, 2026-09-28: the product Worker, measured the S1b way.** Deploy-button install
(`comfy-gen`), no generator, 30 MCP calls 5 s apart: median 19.5 ms CPU, max 58, all `ok`. Probe
routes deployed to the same Worker, interleaved with the spike's unchanged `/noop`:

| Route | Median CPU |
|---|---|
| spike `/noop` (3.5 ms in S1b) | 15.5 ms |
| product bare route | 9 to 10.5 ms |
| each glue step alone (URL parse, request headers, body, bytes response) | +1 to 2 ms |
| store reads + Brain + McpHandler + handle, without the glue | about the bare route |
| full `/mcp` | 22 to 24 ms |

The platform floor moved between runs (the spike's untouched `/noop` went from 3.5 to 15.5 ms), so
compare within one interleaved run only. The app's own Python costs about 0.13 ms per MCP request
(Pyodide under Node). The gap between `/mcp` and a bare route is the JS-to-Python glue, spread over
several steps; `entry.py` now copies only the `cookie` request header and no fetched response
headers across the boundary. Nothing failed at any CPU level measured.

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

**CPU of a Python Worker, 2026-09-28: waiting is free, crossing into JavaScript is not.** A
local CPU profile (wrangler dev DevTools) of a generate put 90% of the time in one or two samples
per await, stretched over gaps where Python resumes after a JS promise (`onFulfilled`); counting
only real samples gave about 8 ms of work. Probe routes on the deployed Worker, 12 calls each,
billed `cpuTimeMs`:

| Route | Median CPU |
|---|---|
| no awaits | 10 ms |
| 100 awaits of a resolved JS promise | 33.5 ms (about 0.24 ms each) |
| 15 fetches with their bodies | 37.5 ms (about 1.8 ms each) |
| `asyncio.sleep` 0.5 s / 3 s | 6.5 / 13 ms (waiting is not billed) |

So a generation's CPU is set by how many times it calls out (polls, each a fetch plus a body read,
and a sleep between) plus a floor of about 10 ms that no Python Worker request avoids. A cold
generation on Modal makes about 20 fetches: the 59 to 164 ms measured in M3.

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

**S7, 2026-09-27/28: works.** `pywrangler sync` vendors a uv workspace sibling (declared with
`workspace = true, editable = false`) as a normal install in `python_modules/`; a path dependency
deployed through the button imports in production (Python 3.14.2).

**S8, 2026-09-28: the client timeout is 5 minutes.**
