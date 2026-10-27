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
| Worker | Cloudflare Worker (TypeScript), free plan | The brain. MCP endpoint, settings and setup app, image route, config in a Durable Object, cron jobs, the GPU list, a relay per PC |
| ComfyUI | Modal, PCs, or localhost (the extension), always with our extension | The generator. We ship no handler code: ComfyUI's own HTTP API is the interface |
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
  removes the entry. When it replaces a different copy there (a new launcher, run by hand), it
  first ends the running launchers of that name, and their agents end with them, so the new shim
  and Node take over at once instead of the new agent finding the old one running
- fetches Node (an LTS pinned in `node.go`, checked against the release's SHA-256 pinned beside
  it) into `~/.comfy-gen-mcp/node/<version>/`, once
- runs the MCPB's shim, embedded, as `node shim.mjs --app agent`, hidden, and restarts it: at once
  on exit code 75 (the agent restarting into a downloaded update), after a backoff on a crash, not
  on 0 (another agent already runs; the second one opened the first one's page while unpaired)
- tells the agent whether it was started by hand; the agent opens its settings page only while
  unpaired (paired, its tray shows it runs, and the settings are on the Worker's page)
- on macOS, started by hand, registers the LaunchAgent again (`launchctl bootout`, then
  `bootstrap`), which starts the agent under launchd, and exits. A program opened from Finder runs
  in a Terminal window, and closing it ended the agent; and after a launcher update, launchd refused
  the replaced binary at login (`OS_REASON_CODESIGNING`, an ad-hoc signature being the file's hash)
  until the job was registered again (macOS test, 2026-10-02). It exits only once the agent's
  settings port answers (30 s at most); if launchd won't take the job, or the agent doesn't come up
  under it, the job is taken back out and the launcher runs the agent itself

macOS: the launcher is not notarized, so Gatekeeper's first-run dialog offers only Done and Move
to Bin (macOS 15 and later); the way through is System Settings → Privacy & Security → Open Anyway,
once. The copy in `bin/` carries no quarantine flag, so login starts don't ask again.

The shim loads the same bundle as for the MCPB (`comfy-gen.mjs` holds both programs) and starts
the agent. For the agent the shim checks at every start, so restarting it by hand updates it, and
hourly while it runs (it runs for days); it hands a newer bundle to the agent, which restarts into
it once nothing has used ComfyUI for 10 minutes and it is not paused (the pause is not saved, so a
restart would take requests again). The shim is embedded in the launcher: a change to it reaches an
agent when its user runs a newer launcher.

**Update now (v1.22.0).** The shim also hands the agent a host, `start(app, host)`: `latest()` (the
same `releases/latest` lookup) and `update()` (its own check, forced, then the newest loadable tag on
disk). So the shim stays the only code that downloads bundles. The agent's `Updater`
(`packages/agent/src/update.ts`) serves `GET/POST /api/update` on its page. The POST answers at
once; the agent then:
- takes the bundle the shim already has (`updateReady`), or asks the host for it;
- restarts with exit code 75 as soon as no install or generation is running and ComfyUI has been
  quiet 15 s, so a finished image is fetched first. It doesn't wait for the 10 quiet minutes, nor
  for model downloads (routing asks the PC again within a minute and they resume), and it restarts
  even when paused, since someone asked.

The button ("Update to vX") is on the agent's page header (`AgentUpdate.svelte`, which also covers
its page on the Worker, `/gpu/<id>`), and on its row in the Worker's GPU list ("Update agent to
vX"). The list uses the Worker's own steady latest tag, and calls the agent through the
`machine` relay (`/api/gpus/<id>/machine/update`).

An agent says `update_now` in its hello when it has a host. A launcher from before v1.22.0 runs the
old shim, which passes none: no button anywhere, and the hourly update works as before. A new launcher (a
new Node) is a new download; running it installs it over the old one.

### Modes

| Mode | Brain | Config | Generator | Settings UI |
|---|---|---|---|---|
| MCPB | local server | local JSON file | ComfyUI on localhost | localhost page |
| Worker | Worker | State Durable Object | The GPU list: PCs through their agents, Modal | Worker page |

Rule: an MCPB install and a Worker install are separate; a machine uses one or the other. The MCPB
is for Claude Desktop only: it has no tunnel and no remote route, and remote use (claude.ai, mobile)
goes through a Worker, with the PC agent when the GPU is at home. The agent uses the same folder
(ComfyUI, models, uv) with its own `agent.json`; like the MCPB, one or the other per machine.

### GPUs

A Worker's GPUs are one list in priority order (`secrets.gpus`, decided 2026-10-01): any number of
PCs and at most one Modal app. Each is plain compute: images and LoRAs live in R2 (§4), so nothing
depends on which GPU made an image. An entry is `{id, kind: "pc"|"modal", name, enabled,
keep_warm_minutes, comfy_args?}` plus, by kind, a PC's pairing secret, or Modal's base URL, headers, admin URL
and cold start. A third kind, a ComfyUI by URL (id `url`), was removed on 2026-10-15 (§11): reading
the list leaves a stored one out, so the next write drops it, and its `fetch_result` tokens answer
"its GPU was removed".

- **Adding:** a PC from the Setup page (`POST /api/gpus/pc`, which returns its pairing link; the
  first PC's id is `pc`, later ones `pc-<random>`; it goes after the other PCs and before Modal, so
  a later, smaller PC doesn't take over from the first: an 8 GB Mac did, 2026-10-02); Modal by its
  deploy's build callback (id `modal`, added at the end).
- **Managing** (`/api/gpus`): `PATCH /<id>` sets name, enabled, keep-warm and ComfyUI flags; `PUT /order` the
  order; `POST /<id>/pair` a new pairing link; `POST /<id>/pause` pauses a PC; `DELETE /<id>`
  removes one (a PC's agent is disconnected). `/api/state` lists them with their live state, never
  their secrets.
- **Routing:** a call goes to the first enabled GPU that is available (a PC: connected and not
  paused) and not known to lack the call's pack; readiness unknown (a PC not asked yet) is worth a
  try. A PC's readiness is kept per pack from its answers (`setup.ready`: true, or the time it
  last said it lacked the pack), Modal's from its seed
  cache (`setup.seeded`). Both that cache and Modal's own record of a finished seed are keyed by
  core `seedKey`: the pack's name plus a hash of its files' names and hashes, so changing a pack's
  files makes it count as not seeded (v1.17.4; name-only keys kept v1.17.3's new background models
  from ever reaching Modal). With none ready, the first available one takes the call and starts
  the download. A GPU that turns out to be downloading hands the call to the next one in the same
  call. A PC's "lacks it" holds a minute (`READY_RECHECK_S`); the next call after that asks it
  again, so its finished download is noticed and a lost one (the agent restarted mid-download)
  starts again. Before v1.21.1 it held until the settings page asked: a PC that once answered
  "downloading" with Modal behind it was skipped for good (found live after v1.21.0). None
  available: the tools say which GPUs are offline or paused.
- **Stored models (2026-10-18):** a model's files stay on every GPU it downloaded to; Settings →
  Models lists the ones no wanted pack uses (`GET /api/models/stored`) and deletes one model from
  every GPU at once (`POST /api/models/delete {pack}`). The Worker picks the files itself, never
  the page: core `removableFiles` leaves out every file a wanted pack (the selected ones and their
  families) or a model set also uses, since packs share text encoders and VAEs, and refuses a
  wanted pack (409). Modal deletes on the Volume (admin `/models/stored`, `/models/delete`, which
  also drops the `seed:` entries); a PC only in our own models folder, never a discovered one
  (agent ops `models_stored`, `models_delete`; a held file gets the LoRA delete's free-and-retry).
  Every pack that lost a file leaves `setup.seeded` and `setup.ready`, so choosing it again
  downloads it again. An offline PC keeps its copy and is named in the answer; an agent from before
  this says "update its agent". The extension has the same two routes for its one machine.
- **Older models:** a pack's `legacy: true` keeps it selectable but lists it last, "(older)"; one
  can't be the default. For replacing a tool's model without taking the old one away.
- **`fetch_result` tokens** are `<gpuId>:<prompt_id>`: only that GPU has the job, so the call goes
  there, or says it is offline.
- **Keep-warm** is per GPU (§5).
- **ComfyUI flags (2026-10-22)** are per GPU too: `comfy_args`, a list of arguments that goes after
  ours, so ours can be overridden (`--cache-ram`: argparse takes the last). It is stored and sent
  as a list, never re-split, so a path with spaces stays one argument. The page edits it as one
  line typed as in a terminal (core `splitArgs`, `joinArgs`), showing the arguments ComfyUI will
  get, one box each, before saving.
  - **Checked** by core `checkComfyArgs` on the Worker, in the extension and in the agent, and
    again in Python by Modal's admin app. It refuses the flags that set where ComfyUI listens and
    keeps its files (`--listen`, `--port`, the directories, `--extra-model-paths-config`, TLS,
    CORS), also abbreviated, since argparse takes `--liste`. `--listen` would open a PC's ComfyUI
    to the network.
  - **Modal:** `PATCH` sends them to admin `POST /comfy-args`, which keeps them in the `state`
    Dict (it survives deploys; the build callback sends them again for a new account). The server
    reads them at start, and the reload watcher restarts a warm ComfyUI with changed ones once it
    is idle (`restart_requested_at`). A ComfyUI that exits by itself with the flags (an unknown
    one: "unrecognized arguments") starts again without them. The reason is kept
    (`comfy_args_error`, `GET /api/gpus/modal/comfy-args`) and shown under the field, so the
    container doesn't wait out its 300 s start-up timeout.
  - **PC:** the flags go with each `ensure`, like keep-warm. An agent keeps them in `agent.json`;
    a Worker from before them sends none, and the PC keeps its own. Shared `LocalComfy` notes the
    flags it started with, and restarts ComfyUI before the next image once they change and its
    queue is empty. A ComfyUI that won't start with them fails that image with ComfyUI's own
    message, naming the flags.
  - **Extension:** its own `comfy_args` in config.json, on its page's ComfyUI section.

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
  `COMFY_GEN_PARENT_PID` is gone, checked every second (every 5 s until 2026-10-02: on Linux, Claude
  Desktop ends the extension without a catchable signal, so this is the usual way it stops there).
  Tested: ComfyUI gone within 4 s of a SIGKILL at the old interval, the next message
  to a relay made it the owner.
- **Windows memory reads (2026-10-22).** On Windows the same extension switches
  `psutil.virtual_memory()` to `GlobalMemoryStatusEx` at load, before any prompt (`winmem.py`).
  - **Why:** psutil (6.x to 7.2.2) builds it from `GetPerformanceInfo`, which counts every handle
    on the system. ComfyUI 0.37.0 calls it at least twice per pinned weight. After a game leaked
    handles (Ace Combat 8: 346k system-wide), each call took about 200 ms until a reboot, so a
    first generation sat at "Model Initializing" for minutes. `GlobalMemoryStatusEx` took 0.00 ms
    and gave the same total and available RAM.
  - **What it replaces:** psutil's platform backend (`psutil._psplatform.virtual_memory`, looked
    up at each call), so every caller gets it, including `comfy_execution/caching.py`'s by-name
    import.
  - **Shape:** psutil's own on Windows (total, available, percent, used, free; free is
    available).
  - **Fail-safe:** a different shape, a failed call or a total more than 1% off leaves psutil as it
    is, with a warning. `COMFY_GEN_FAST_MEMINFO=0` in the environment switches it off.

The server binds `127.0.0.1`, or `0.0.0.0` when the user lets other computers use it (Connect
Claude → Advanced, `mcp_network`, read at start), for a client such as LibreChat on another machine:
the MCP route then answers any client behind its secret path. The settings page and `/api` answer
loopback clients only either way, because they install software and change files. (It bound
`0.0.0.0` always until the macOS test found a Mac with a public address, 2026-10-02.)

The `.mcpb` holds the shim (`server/shim.mjs`) and its own release's bundle. The shim
`import()`s the newest bundle it has, shipped or cached in `~/.comfy-gen-mcp/app/<tag>/`, falling
back to an older one if it fails to load. At most once a day, in the background, it reads the latest
tag from the `github.com/<repo>/releases/latest` redirect (as the Worker's cron does) and downloads
that release's `comfy-gen.mjs` for the next start (HTTPS guards it; a length check catches a
cut-off download, and a bundle that fails to load falls back to the older one). Two
cached bundles are kept. The shim changes only when users reinstall the `.mcpb`, so everything else
lives in the bundle. The tray icon is our tray helper (`packages/tray`, Go on fyne.io/systray:
StatusNotifierItem over D-Bus on Linux, with no GTK or libappindicator; Win32; Cocoa, native on Apple
silicon). The release has all three in one `comfy-gen-tray.tgz`; the bundle downloads it for its
own tag, checks it against the SHA-256 built into it, and extracts its platform's helper with `tar`
(checked against that one's hash); Node talks to it in JSON lines (the protocol is in its
`main.go`). Where it cannot run there is no tray, and the settings URL is in the tool answers. On
Linux the helper ends only without a D-Bus session (a server); a desktop with no StatusNotifierItem
host yet is logged and waited for, since at login the agent can start before the panel, and plain
GNOME gets one with the AppIndicator extension. (It was systray2's helpers until v1.8.0: Linux's needed `libappindicator3`, gone from Ubuntu
24.04, and the Mac's was Intel-only, needing Rosetta.) The icon's
color is the state: green running, yellow stopped or starting, red when something needs the user
(ComfyUI failed or is not installed, a download failed). Its menu: Open settings, Open images folder (ComfyUI's
`output/`, where every generated image stays as a PNG), the status line (greyed, not clickable), Stop ComfyUI, and in the agent Pause agent / Resume agent. There is no
Start or Restart: ComfyUI starts by itself with the first image, and the settings page has both.

Everything else lives in `~/.comfy-gen-mcp`, the old extension's folder: the config file
(`config.json`; the old `local_config.json` is not read, there being two users to move), the
managed ComfyUI (ours only: an install without our marker file is replaced by the next install,
which keeps its models, outputs, inputs and user settings, in place: they used to be moved aside
and back, and on Windows moving `models` failed with EPERM while anything had a file in it open,
2026-10-02) and its models.

**Models already on the machine are used where they are** (`local/discover.ts`), since they are
many GB. The managed ComfyUI reads, through the `extra_model_paths.yaml` written at each start:
- the user's extra models folder
- ComfyUI installs found through comfy-cli's config, the ComfyUI Desktop app's config, the newer
  Comfy Desktop app's `installations.json`, `settings.json` and `shared_model_paths.yaml`, the
  `~/.comfy-registry` entries (Visual-Novelist's too), and a shallow scan of home, Desktop,
  Documents, Downloads and each Windows drive root for folders named like ComfyUI (and installs one
  level inside them, as `ComfyUI-Installs\<name>\ComfyUI`). On a Mac the scan covers home only and
  skips Desktop, Documents, Downloads and the media folders: reading them makes macOS ask the user,
  which a background program did at login (2026-10-02); a path an app's settings name is still read
- for each install found, the folders its own `extra_model_paths.yaml` names (often a big model
  drive), with ComfyUI's folder aliases (`unet` is `diffusion_models`, `clip` is `text_encoders`)

Each folder counts once, by its real path (one model drive reached through three junctions was
seen on the user's PC), and folders holding nothing but ComfyUI's placeholder files are left out.
Only what is in none of them is downloaded, into ours. A pack's models download at its first use,
or at once when it is chosen on the settings page; a tool whose models are still coming says how
much is left. (All the selected packs downloaded up front until the macOS test, 2026-10-02: about
22 GB on a new install before the first image.) The settings
page lists the sources found.

## 3. Generation path

**First run and disk space (2026-10-02, the first hand test).** Nothing told a new user where the
settings page was, so a new install opens it once (a marker file, created exclusively, as Claude
Desktop starts several copies at once), the "not installed" answer and the server's instructions
carry its URL, and the manifest names `http://127.0.0.1:9247/`. Model downloads check the free space
first (keeping 1 GB) and fail with the numbers; a write error (a full disk) fails the download: the
stream once just stopped draining, hung, and filled the system drive to 0 bytes with nothing logged.
A download for a model switched away from carries on and stays listed, "(not selected)".

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

Packs (JSON: a workflow, its model files, a prompting guide) are resolved per tool, prompts
injected, seeds randomized, dimensions computed, LoRAs spliced. The workflow marks the nodes we
fill in by their title (`_meta.title`, set by renaming the node in ComfyUI before exporting):
`cg:prompt`, `cg:seed`, `cg:size` or `cg:width`/`cg:height`, `cg:model` (where LoRAs attach), and
an edit's first-image nodes `cg:image`, `cg:image scale`, `cg:image encode`, `cg:image chain`;
`withImages` (`workflow.ts`) builds a second image by copying those, chaining its reference
latents after the first image's (2026-10-03: titles replaced the node-id fields, and the generated
two-image graph the shipped `workflow_multi`, the same graph); a node with numbered image inputs
outside the copies (Qwen Image 2.1's encoder, `images.image_1`) gets `images.image_2` for the
second. The prompt goes into the `cg:prompt` node's `text`, or its `prompt` where it has one.
`docs/adding-a-model.md` has the steps.

**The models (2026-10-18):** the realistic tool's default is **Qwen Image 2.1 Turbo** (7B, unsloth
GGUF Q6_K, its own Qwen3-VL-8B int8 encoder and RGBA VAE: `SplitImageWithAlpha` makes the decode RGB
before the save and our cleaning nodes), and the edit tool's is the same model (one model does both;
the two packs share every file, ~16.3 GB). **Krea 2 Turbo** (12B, byteshape GGUF Q4_K_M, Qwen3-VL-4B
fp8 encoder, Anima's VAE, ~13.4 GB) is the other realistic choice: a stronger aesthetic, slower,
text-to-image only. Both are 8-step Turbo checkpoints at cfg 1 (base models take 25 to 52 steps),
native in ComfyUI 0.37.0. Text encoders stay Comfy-Org safetensors: the GGUF ones lack the vision
tower ComfyUI keys on. The lineup (the user's call, after side-by-side runs on a 16 GB card,
2026-10-18): realistic Qwen 2.1, Krea 2 ("higher quality") and Flux 2 Klein 4B ("lower quality, low
VRAM": the one that fits 8 GB cards comfortably, but less reliable); edit Qwen 2.1, Klein 9B Edit
and Klein 4B Edit (the same low-VRAM role). Z-Image Turbo and Klein 9B's text-to-image are `legacy`:
still selectable, listed "(older)", deletable from Stored models. The pickers list the default,
then the other current models by size, then the older ones. On Visual Novelist's pose edits
(waist-up Anima sprites, "the free hand" while a prop stays put), Qwen got 14/14 clean cases, Klein
4B 11 and Klein 9B 10: the Kleins moved the hand holding the prop. Resolution (16 GB card, 2026-10-19): Qwen
generates in about 13 s at 1 MP, 22 s at 2 MP and 42 s at 4 MP, Krea in 20, 36–46 and 77–128 s,
both fine at every size, so generation keeps 1 MP by default with the setting up to 4 MP. Qwen edits
took 20 s at 1 MP, 41 s at 2 MP and about 2 minutes at 4 MP (correct each time), so its edit budget
is 2 MP (an input within it keeps its size, a larger one is scaled down); Klein's stays 4 MP. Quants were chosen for a 16 GB card fitting 12 GB:
unsloth's LPIPS for Qwen Turbo against bf16 is 0.153 at Q4_K_M, 0.055 at Q6_K and 0.036 at Q8_0;
ComfyUI unloads the encoder before sampling, so the peak is the larger of the two, not their sum. The
tools themselves are defined once, in `packs/tools.json`: each one's settings-page title, the line
that routes between them (illustration or photo), and a default prompting guide; a tool's
description is that line, the selected pack's `prompt_guide` (else the default), then the part all
generation tools share (aspect ratios, "may not appear inline"). Packs of one `family` (Anima and
Anima Turbo) share their settings, stored under the family's name; a `lora_group` says which
LoRAs a pack takes (2026-10-02/03: these replaced per-pack tool descriptions, `config_key` and the
artist-list test for LoRA support; every pack has one since 2026-10-18, §4). This is
the old `workflow.py`, `model_pack.py` and `tool_specs.py`, ported to TypeScript with Web-platform APIs
only, plus the MCP handler.

### MCP

A hand-rolled, stateless JSON-RPC handler in `core` serves `initialize`, `ping`, `tools/list` and
`tools/call` with one JSON body per POST (no sessions, no SSE). It was written when the Worker was
Python, where the official MCP SDK cost about 2 s of CPU per fresh isolate (S1); it stays because it
is small, proven with claude.ai, and costs nothing. The Worker and the MCPB's local server both use
it; the MCPB's stdio shim may use the official TypeScript SDK.

### Scripted callers

Apps can call the connector URL too: plain JSON-RPC `tools/call` POSTs, as Visual Novelist does
for every image it makes. They get a few things Claude doesn't see, so Claude's tool list and
results stay as they are:

- **Hidden arguments** on the generate tools, absent from the schemas and descriptions:
  - `aspect_ratio` as `"WxH"` is that exact size when it fits the pack's budget (sides of 256 or
    more, rounded to multiples of 64), and otherwise only the shape.
  - `negative` goes into the pack's `cg:negative` node (Anima's). Packs without one ignore it.
    Since v1.20.1 it is added after the pack's `negative_fixed` tags (quality, watermark,
    signature: always wanted), replacing only the rest of the default (`sepia, mask, black face,
    scaled face`). A pack without `negative_fixed` takes the caller's text alone.
  - `model`, a pack name (`anima`, `anima_turbo`), runs that pack in place of the one the
    settings page picked. That lets the owner use Anima in claude.ai and Anima Turbo in Visual
    Novelist at once. It must back the tool called: any other name, or one of another tool, is
    an error result (`retryable: false`) naming the valid ones. Empty means the picked pack.
    `edit_image` and `fetch_result` ignore it. The pack's own settings, LoRA group and negative
    come with it (core `packFor`, in the Brain and, for routing, the Worker). It also works on
    the MCPB.
  - `seed` (2026-10-26), on the generate tools, `edit_image` and `redraw`, makes a run repeatable:
    every seeded node (`cg:seed`) gets it, in place of a random one each. It is a whole number from
    0 to 2^53 - 1 (exact as a JSON number, within ComfyUI's range), or one as a string of digits;
    anything else is an error result, and left out it is random as before (core `callSeed`). The
    same seed, prompt, model, size, LoRAs and input images give the same image, or very nearly
    (some GPU kernels aren't bit-exact; another GPU or ComfyUI version may differ more). Every
    run has one seeded node. The seed a run used is in its image's embedded prompt (`seed` or
    `noise_seed`), also when the image was re-encoded to fit inline (§4, "The prompt travels in
    the file").
  - On `redraw`, `model` names any pack that can redraw, and `negative` works as above. Leave it
    out unless sure which model drew the image: unnamed, redraw reads that from the image's
    embedded prompt (v1.18.0), and a redraw by another model than the image's mixes two styles,
    which doesn't work. Name one only for an image without metadata whose model you know.
- **A hidden `remove_background` tool**, absent from `tools/list` (core `HIDDEN_TOOLS`) but served
  by the Worker and the MCPB. `image` (an id or an https URL; `image_path` on the MCPB) in, a new
  RGBA image id at the same size out: the same cut-out as `remove_background: true` on the other
  tools (core `cutoutWorkflow`), nothing repainted, no prompt or model. On the Worker, every tool taking
  an image reads its own `/img/<id>` links as the id (a Worker can't fetch its own workers.dev
  address; v1.17.5). Visual Novelist cuts out
  its neutral expression's base with it, where a redraw would repaint the face. It needs the
  background models like the option does (retryable "being downloaded") and is routed to a GPU
  that has them; a GPU that can't remove backgrounds answers as the option does.
- **`_meta["comfy-gen/result"]`** on every tool result, beside the unchanged content blocks:
  - `{status: "done", images: [{image_id, url, width, height}]}`
  - `{status: "done", upload_url, expires_in_s}` from `request_upload` (2026-10-27, for Visual
    Novelist's crops): POST the image's bytes to `upload_url` once, within `expires_in_s` (600);
    the answer is `{image_id, bytes, mime}`. A scripted caller may leave out `filename`, which only
    names the file in Claude's Python snippet.
  - `{status: "pending", request_token}`
  - `{status: "error", message, retryable}`

  `retryable` means the same call should work later with no one doing anything (a cold start, a
  model downloading, a GPU restarted mid-image). Offline, paused, unset-up and bad arguments are
  not. A tool that crashed has `isError` and no such value. Both frontends build it the same way
  (core `renderOutcome`); the MCPB's done images carry `saved_path` in place of `image_id`/`url`. It was
  `structuredContent` in v1.12.0, but Claude Code gives that to the model in place of the text
  blocks (seen 2026-10-13), which changed what Claude read. Clients don't show `_meta`.
- **`GET /mcp/<secret>/loras`**, behind the same secret: `{loras: [{name, trigger, strength,
  hidden, strengths}]}`. These are the switched-on LoRAs of the pack a tool uses (`?tool=`, the
  illustrated tool by default: Visual Novelist reads that), or `[]`. `strength` is that pack's;
  `strengths` (v1.19.0) has every pack of its LoRA group, for a caller that names another `model`
  (Anima and Anima Turbo take LoRAs differently).
- **`GET /mcp/<secret>/models`**, behind the same secret: `{models: [{name, display_name,
  selected}]}`. These are the packs backing a tool (`?tool=`, `generate_illustrated_image` by
  default), in pack order; `selected` marks the one the settings page picked.

A family downloads whole: every GPU gets each selected pack and the rest of its family (core
`withFamilies`). Base models are never deleted, so a call naming a family member finds it ready.
If one is still missing (the PC was off, a download failed), the call starts its download and
answers the usual retryable "being downloaded". ComfyUI runs with `--cache-ram 4 6`, so calls
alternating two packs keep both loaded (see Waiting, below).

### Signatures and watermarks (2026-10-15)

Some artist tags make the models paint the artist's signature, stamp, name or Patreon link into
the image (cutesexyrobutts, banishment, tokyogenso, mifuru, gemi, mks). The negative prompt doesn't
stop it, and on Anima Turbo it can't: at CFG 1 the negative is skipped. So a last step cleans
them, on by default (`remove_marks`, §5):

- **Our node.** `ComfyGenRemoveMarks` lives in our own ComfyUI extension (`comfy_node`, the file
  that serves `/comfy-gen/wait`), so Modal, the PC agent and the extension all have it. `prepare`
  (core `packs.ts`) reroutes every SaveImage's images through it, titled `cg:remove marks`; packs
  need nothing for it.
- **Finding.** MimiLens YOLO26l (`mimilens_y26l.pt`) detects marks; only its `watermark` and
  `signature` labels count (it also finds speech bubbles, text and SFX), at a 0.2 threshold, and
  only boxes up to 10% of the image. Marks scored 0.24 to 0.81: 0.3 at first (v1.15.0), until a
  cutesexyrobutts mark cut off by the image's top edge scored 0.24 live. Nothing else in 44 test
  images scored over 0.14, and that one false find was a box over 19% of the image.
- **Filling.** Each mark is filled on its own by LaMa (`big-lama.pt`, through spandrel) at full
  resolution:
  - the hole is the box grown by 8 px or 12% of its longer side, whichever is more, reaching the
    image's edge when within 24 px of it;
  - the crop is the hole plus a margin, padded to a multiple of 8;
  - the result is pasted back with a feathered edge; overlapping boxes are merged first.
- **Never fails an image.** A missing package or model file, or any error, passes the image
  through unchanged and logs a warning.
- **Where it runs.** Only where our extension runs (`BrainOptions.canRemoveMarks`):
  - Modal;
  - a PC whose agent's hello says `remove_marks` (an agent from before the node doesn't);
  - the extension.
- **Models.** The two files (260 MB, folder `comfy_gen`) are their own download set, core
  `MARK_MODELS` (in `packs/tools.json`), fetched in the background and never shown (the user's
  call, 2026-10-15: nothing to decide there). While the setting is on, they are seeded on Modal's
  deploy and every settings save, sent to online PCs on a save, and ensured by the Brain before the
  pack at each call. While they are still downloading, the image goes out uncleaned instead of
  waiting.
- **Package.** The detector needs `ultralytics` (pinned):
  - in Modal's image (with the GL libraries OpenCV loads);
  - in a new PC install;
  - for an existing install, added in the background at launch (`ensureExtensionPackages`). The
    node imports it when first used, so ComfyUI needn't restart.
- **The spike (2026-10-15, scratchpad).** 28 images from the live Worker were cleaned on every mark
  found, with nothing flagged on clean images. On CPU, detection took about 2 s, plus 1 to 2 s per
  mark.

### Background removal (2026-10-15)

`remove_background: true` on the generate tools and `edit_image` returns the image with a
transparent background (stickers, sprites, cut-outs). It is a visible option, off by default: the
description tells Claude to use it only when the user wants transparency, and to ask for a plain
grey or coloured background in the prompt, never white.

- **ComfyUI's own nodes, then ours.** 0.37.0 has background removal built in. `prepare`
  (`withBackgroundRemoval`) routes each SaveImage's image through LoadBackgroundRemovalModel →
  RemoveBackground (the subject's mask) → our `ComfyGenCutout` (v1.17.3), after the watermark step.
  SaveImage keeps the RGBA, and `/view?preview=webp;90` keeps the alpha in the WebP the tools return
  and R2 stores. A PC agent from before the node (no `cutout` in its hello) gets InvertMask →
  JoinImageWithAlpha, the mask as it is.
- **The model: RMBG 2.0** (`rmbg-2.0.safetensors`, 885 MB, BRIA's BiRefNet, folder
  `background_removal`; v1.17.3). briaai's own repository is gated, so it comes from the ungated
  `1038lab/RMBG-2.0` mirror, pinned by commit. Its licence is CC BY-NC 4.0, non-commercial, which
  the user accepted: nothing here is commercial. Its tensors match Lucida's (v1.16.0 to v1.17.2) key
  for key, so ComfyUI's node loads it unchanged. Over Lucida it gives a slightly better subject and
  keeps a white headdress on white solid, where Lucida turned it see-through.
- **The cleanup (`ComfyGenCutout`).** Over a dark scene, every model's cut-out showed a white
  contour (the user's report, 2026-10-16). The spike (7 sprites on white and grey, 2026-10-16) found
  two causes:
  - *A light ring.* The generated images have a 1 px ring lighter than the background just outside
    the lineart, and every model's soft edge keeps a sliver of it; cleaning colours alone turns it
    white. The mask is shrunk by 2 px (the lineart is thick enough not to show it), then each
    partly transparent pixel's colour is freed of the background's, `F = B + (C − B) / α`, against
    the background colour B measured where the mask is clear.
  - *Enclosed background.* BiRefNet models (Lucida, RMBG 2.0) segment "the object" and fill
    background enclosed by the silhouette (the white strips between a maid's twintails and her
    face). isnet-anime (`isnet-anime.onnx`, skytnt/anime-seg, Apache-2.0, 176 MB, run by
    onnxruntime, folder `comfy_gen`) cuts those out. Patches the base keeps and isnet clears are
    labelled; one whose median colour is within 0.12 of the background's takes isnet's alpha, grown
    4 px so its rim goes too (gaps measured 0.01 to 0.05, a cream inner ear 0.25). Per pixel, not
    per patch, it left a ring around each gap.

  A background that isn't plain gets only the shrink. Tried and dropped: per-pixel colour keying
  (it ate white parts), rembg's alpha matting (it filled gaps grey, ~10 s), and isnet as the base
  (fine, but RMBG 2.0's edges looked better to the user). White on white still loses (the user's
  call: pathological); a mid-grey background is safest.
- **Downloaded from the start** (the user's call, 2026-10-15: the option is on every call, so the
  first sticker shouldn't wait for 885 MB). The model set (core `BG_MODELS`, with the watermark
  removal's in `wantedModelSets`) is seeded with Modal's deploy and every save, sent to online PCs on
  a save, and fetched by the agent and the extension once ComfyUI is installed (at start and after
  an install, `Machine.fetchModelSets`); never listed. A call that still finds it missing starts it
  and gets the usual retryable "being downloaded": unlike the watermark removal, a call never goes
  out without the step it asked for.
- **Where.** Modal, the extension, and a PC whose agent's hello says `remove_background` (v1.16.0:
  older agents lack the `background_removal` model folder, so the download would never count as
  done; they get a plain "needs a newer agent").
- **Edits.** LoadImage keeps only the colours of a transparent image (its alpha goes to a mask the
  edit packs don't use), so an edit fills the background back in; the description says to pass
  the option again.
- **Cost:** about 1.7 s per image on Modal's L4 and 1.2 s on the user's PC with Lucida (live, v1.16.1,
  Anima Turbo portraits: 16.8 s against 15.1 s, and 10.4 s against 9.3 s). RMBG 2.0 is the same
  architecture; isnet adds about 1.5 s on CPU. The scratchpad CPU ComfyUI took about 20 s per
  image for the whole v1.17.3 cut-out.

### Redraw (2026-10-15)

`redraw` repaints one part of an illustration and leaves every other pixel as it was: a mangled hand or
face, an expression, a small detail. Visual Novelist makes a sprite's expressions with it, so the
body, outfit and pose stay identical across them. Arguments: the image, a prompt, an optional
`box` (`[left, top, right, bottom]`, fractions of the image; none means the largest face),
and `strength` (0.3 to 1, default 0.9); hidden, `model`, `negative` and `seed` (Scripted callers).

- **The technique.** The pack's own generation graph, with its empty latent replaced by the image:
  VAE-encoded, a soft mask as the latent's noise mask (`SetLatentNoiseMask`), the model through
  `DifferentialDiffusion` so the mask's edge blends, and the sampler's denoise set to the strength
  (core `redrawWorkflow`). Then the result is pasted back through the mask at full resolution, so
  the rest is pixel-identical (the VAE round trip would otherwise shift it), the image keeps its
  size, and a transparent image its alpha (LoadImage's mask, put back). Anima has no inpainting
  model or channels; this needs none.
- **The whole image, the prompt for all of it; only the mask is repainted.** The image is sampled
  at its own size (scaled down to the pack's budget if over), and the prompt describes the whole
  picture: the prompt that made it, with the change written in (Visual Novelist swaps the
  expression tags). About 8 s for a 1536×1024 image on Modal's L4 with Anima Turbo, 13 s per
  sprite expression, 72 s with base Anima. At 0.9 expressions read clearly and identity holds
  (Frenni's muzzle, a cutesexyrobutts human face); 0.8 barely changed them.
- **Region mode, tried and dropped (the user's call, 2026-10-15).** Sampling a crop of 2× the box
  at a megapixel with a prompt for the crop alone gave sharp fingers but wrong ones: bare hands on
  an armoured knight from "a hand in a steel gauntlet", the hand left out with more context; 2
  usable of 12 tries. The whole image with its own prompt knew she was a knight.
- **Back as an opt-in: `prompt_scope: "area"` (v1.20.0, the user's call).** Its one strength is
  resolution: a small detail is sampled at many times the pixels the whole-image pass gives it. The
  default stays `"image"`, and the description tells Claude when `"area"` is allowed: only after a
  normal redraw of that area left it blurry, only for a detail at most about a tenth of the image's
  width and height, with the prompt rewritten for the area alone, never for faces in a portrait or
  anything that must match its surroundings. Our region node takes an optional `area_only`: the
  crop (2× the grown area's longer side, kept inside the image) is sampled at a megapixel, scaled up
  when smaller, and pasted back through the same mask as the whole-image mode. Without the input
  (every default call, and older graphs) nothing changes. A PC agent says `redraw_area` in its
  hello; an older one's node would ignore the input, so the call answers "needs a newer agent".
- **The area.** A box is grown 1.5× and drawn as a rounded rectangle; a face, the detector's box
  grown 1.2×, as an ellipse; both blurred by 4% of their shorter side (8% left the knight's
  new hand half see-through; Frenni's expressions read the same at either). On the knight's mangled
  hand (8 tries each): grown 1.15×, 2 drew a gauntlet and most left the hand out; 1.5×, 6 drew a
  gauntleted hand; 2×, as many but more of the armour around it redrawn. A loose box works, so the
  description says to measure the box with tooling where there is any, otherwise to estimate it
  erring larger, and to call again with a larger box if the problem remains. In the spike a box
  estimated by eye was within about 30 px of the measured one.
- **The inpainting control (v1.21.0, the user's call: always on).** kohya's Anima ControlNet-LLLite
  inpainting weights (`anima-lllite-inpainting-v2.safetensors`, 66 MB: small modules added to some
  of the model's layers, like a LoRA, where a full ControlNet would copy half the model) read the
  image with the area blanked and the mask, and steer the sampler to continue what surrounds the
  area. Our `ComfyGenInpaintControl` node applies them to the model after its LoRAs, fed the
  region's sample and mask, at strength 1.0 (core `redrawWorkflow`, the pack's `inpaint_control`;
  the weights are one of both Anima packs' models, in `comfy_gen`). The model code is kohya's
  (`comfy_node/lllite.py`, copied from kohya-ss/ComfyUI-Anima-LLLite at `b7495bd` under the Apache
  License 2.0, with its licence beside it), so no node pack is added on any GPU; the extension now
  ships as a set of files (`build.mjs`, `writeWaitExtension`). Trained on Anima Base; it works on
  Turbo too. In the spike (build plan, "Outpainting") it was as good or better than redrawing
  without it in all 18 pairs on both models: without it a glove melted into the hip, a muzzle
  lightened, a steel gauntlet came out brown; with it, about 25% more time (Turbo 6.4 s against 5.2
  at a megapixel, Base 35.5 against 27.2). It draws the area to fit its surroundings, not what was
  inside it, so the description asks to name in the prompt anything there that must stay (a sword
  inside the area was lost; one reaching out of it was kept). A PC agent says `inpaint_control` in
  its hello; an older one's redraws run without it, as before.
- **Extend: outpainting (v1.21.0).** `extend` ({left, top, right, bottom}, shares of the image's
  width and height, at most 1 per axis per call) grows the canvas instead of repainting a box (not
  both). The region node pads the image, its edge stretched and blurred into the new border; the
  mask is the border and a band of the original, the sampler denoises fully (strength doesn't
  apply), with the control on; the paste puts the original back from further in than the band, so
  the result is the canvas with the original's interior pixel for pixel (opaque). Sizes are shares
  of the image's shorter side (band 0.047, paste-back inset 0.031, feather 0.016: the spike's 48,
  32 and 16 px at 1024). The inset is what removed the spike's ghosts (half-transparent bottles
  where the original's frame cut them, from blending the original back over the whole band). The
  description recommends up to 0.5 per side (2× in one call repeated a motif in the spike), a
  prompt for the whole new picture with its new framing, and a second redraw for a stray hand. A PC
  agent says `redraw_extend`; an older one answers "needs a newer agent".
- **Our nodes.** `ComfyGenRedrawRegion` (the area, its mask, the image to sample) and
  `ComfyGenRedrawPaste` in our extension, so redraw runs where it does: Modal, the extension, and a
  PC whose agent's hello says `redraw` (v1.17.0; older agents get a plain "needs a newer agent").
- **The face detector.** deepghs' anime face detector v1.4 s (YOLOv8, MIT, 45 MB, `comfy_gen`
  folder), run by onnxruntime directly (pinned, beside ultralytics), not through ultralytics: that
  installed a package on its own in the spike. Its model set (core `FACE_MODELS`) downloads from
  the start like background removal's; a call without a box waits for it like for a pack. No face
  found is an error naming the fix: pass a box.
- **Which packs: illustrations only** (the user's call, 2026-10-15). A photograph has no art style
  to drift, so `edit_image` serves it, and redraw on Z-Image Turbo was never tried. Redraw runs
  the model that drew the image, read from the prompt the image carries (core `redrawPackFor`:
  the UNETLoader's file in it, matched to a pack that can redraw; v1.18.0), since a redraw by
  another model mixes two styles. Without that (an upload, an outside image, an edit model's or a
  cut-out's output), Anima Turbo whatever the settings select (core `REDRAW_DEFAULT`; base Anima
  took 74 s live against Turbo's 11, and the family downloads whole). A scripted caller's `model`
  wins. The Worker reads a stored image (an id or its own link) before routing and passes the
  model on, so the call goes to a GPU with that pack; the MCPB reads local files; URLs are not
  downloaded for it.
  `canRedraw` also requires a KSampler fed by the empty latent, the denoise the technique needs.
- **No watermark step**, except on an extend: the image was cleaned when it was made. An extend
  paints new borders, though, and that's where the models paint signatures: one appeared in a
  corner on the PC, live, 2026-10-17. So since v1.22.1 an extend gets the mark removal after the
  paste, as a generation does (before any background cut, the generate tools' order). A
  transparent input keeps its alpha (LoadImage's mask, put back).
- **Background removal on request, after the paste** (`remove_background`, v1.17.2). Visual
  Novelist's sprite → cut background → redraw went wrong where the area reached a transparent part:
  the model sampled the colours left under it, and the old alpha was pasted back over the new edge.
  So the order is sprite → redraw → cut: the paste then gets no alpha, and `withBackgroundRemoval`
  cuts the pasted result, as on the generate tools. The description says to redraw the opaque
  version of a transparent sprite.
- **Sprite sheets: base → redraw → edit → cut** (how Visual Novelist does it, 2026-10-16). Every
  expression is a `redraw` of the clean opaque base. A pose (`edit_image`, hands, arms) comes after
  it, then `remove_background` (the hidden tool) or the option on the last call. Redrawing after
  the edit has Anima repaint the edit model's pixels, and it extended them (extra fingers at the
  mask's edge). One open risk: an edit that moves the head can blur the expression, since nothing
  re-checks the face after it.

### Waiting

**Both models stay loaded.** ComfyUI 0.37.0's default RAM-pressure cache frees an earlier prompt's
node outputs, the loaded model included, after every prompt. It treats them as "inactive" and frees
them until free RAM reaches 100% of total RAM, which never happens. So calls alternating packs
reloaded each time. On Modal (2026-10-14, v1.12.2), Z-Image Turbo took about 10 s warm and about
20 s after an Anima call. Both launches (Modal's `app.py`, local `comfyui.ts`) now pass
`--cache-ram 4 6` (a GPU's own ComfyUI flags come after it and may override it: §2, "GPUs"):
- An earlier prompt's outputs stay while 6 GB of RAM is free.
- The current prompt's outputs stay while 4 GB is free.

A local probe (A, B, then A again) found prompt A's nodes cached with this flag, and not with the
default or `--cache-classic`. `--cache-lru` would keep them too, but with no regard for RAM. The
reading is cgroup-aware, so Modal's container limit counts.

Live on Modal after v1.13.0 (2026-10-14, through the connector with `model`):
- Turbo right after an Anima call took 9.4–9.5 s, the same as warm Turbo (9.0–9.5 s).
- Anima stayed at its warm ~40 s, so neither model reloads when calls alternate between them.
- Z-Image Turbo right after an Anima-family call still took about 20 s, against about 10 s warm.
  All three packs come to about 19 GB, so VRAM alone doesn't explain it. Unconfirmed: its GGUF
  loaders, or the container dropping under the 6 GB threshold.


`tools/call` blocks up to 2.5 minutes, returning the image directly. claude.ai's MCP client
timeout is 5 minutes (S8), but a claude.ai connector used from Claude Code gave up at about 183 s
(2026-10-01: a cold Modal edit the Worker answered at 211 s reached nobody). A cold start plus
generation usually stays under 2. The request-token path plus `fetch_result` is the fallback. No
cold/warm status vocabulary.

The 2.5 minutes (`DEFAULT_WAIT_S` = 150 s; 240 s until 2026-10-01) are **one budget per tool call, counted from its start**:
the client's `stopBy`. The cold-start retries of submit, uploads and `/view` stop at it as well as
at their own limit (`MODAL_COLD_START_S`), and the wait gets what is left. So a call answers within
150 s with the image, a `fetch_result` token (submitted, still running), or "The GPU is still
starting up; call the tool again in a minute" (never got to submit). Until 2026-10-01 the 240 s
counted from after the submit, so a slow cold start plus the wait passed 300 s and a tester's
Claude Code gave up with "operation timed out". The extension holds its own start-up (launching
ComfyUI, node installs) to the same budget: past it, the call says ComfyUI is still starting and
the launch goes on for the next call to join. Keep-warm's idle stop counts ComfyUI's queue as use,
so a generation that outlived its call (answered with a token) is not stopped under it.

Jobs are stateless: the request token is ComfyUI's own `prompt_id`. `fetch_result` just resumes polling `/history`, so nothing is kept between requests, which
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
workflows already run ComfyUI themselves.

## 4. Images, references, uploads, edits

- **R2 is the storage** (2026-10-01, replacing "the generator is the storage"). The Worker keeps
  every image in its R2 bucket (`STORE`, named `<worker>-storage` by the build, which wrangler
  creates on deploy): generated outputs as the WebP the result shows, uploads as uploaded, each
  under `img/<id>`. A bucket rule deletes them after a year. So no image depends on the GPU that
  made it: links open and edits work with every GPU off, and any GPU edits any image. GPUs are
  plain compute; ComfyUI's own PNGs stay on their disks (the Modal Volume, a PC) untouched. R2
  needs a card on file on the Cloudflare account (free tier: 10 GB, free egress): the Worker's
  Setup page has the step, and the Worker runs without the bucket until then (§6). The extension
  (no Worker) keeps local paths.
- **Image ids are random R2 keys**: 8 base62 characters (about 47 bits), e.g. `h3Kd9QxA`. The id is
  the capability, with no MAC: it names nothing on any GPU, and at 100k requests a day guessing one
  of a few thousand images takes centuries. Never paths from the model. (Before: a signed ComfyUI
  location plus its backend, `m7.Ab3d`; those ids are gone, as only two installs existed.)
- **No PNGs, no `:lossless`.** Every edit goes through the model's VAE, which loses far more than
  WebP at quality 90; the `:lossless` switch dated from JPEG results (no transparency) and is gone.
- **Results are inline WebP.** claude.ai does not support `resource_link` (it shows "Resource links
  are not currently supported" and the model sees only the name and URL), while inline
  `ImageContent` is shown to the user and seen by the model, WebP included (S2, S2c). Every result
  carries the image inline as base64. Outputs are saved as WebP by ComfyUI itself (v1.18.0: core
  `withWebpSave` turns every SaveImage into its built-in SaveAnimatedWEBP, quality 90, just before
  submitting; one image makes a plain still WebP, alpha kept), and fetched from `/view` as they
  are. The Worker base64s them with the runtime's native encoder (about 3 ms of Worker CPU per MB,
  appendix). Over 1.4 MB (700 KB before v1.18.0, doubled for the metadata), the Worker asks again
  for `/view`'s `preview=webp;75` conversion. That conversion drops the metadata, so the saved
  file's EXIF chunk is put back in (2026-10-26, core `withExifOf`). It walks chunk headers only and
  adds a VP8X header where the conversion wrote a plain VP8/VP8L file. Pillow and Chromium decoded
  the same pixels and alpha after it. Those bytes are also what
  it stores in R2 (one `put`, about 1 ms of CPU). The MCPB does the same against its local
  ComfyUI, without storing; its saved_paths are those WebPs.
- **The prompt travels in the file** (v1.18.0, the user's call). SaveAnimatedWEBP writes ComfyUI's
  metadata as its docs describe (docs.comfy.org, workflow metadata): the API prompt in EXIF tag
  0x0110 as `prompt:{json}`, `extra_pnginfo` entries from 0x010F down. We submit API prompts, so
  there is no UI `workflow`; ComfyUI builds the graph from the prompt when one is dropped on it.
  `/view`'s own WebP conversion had dropped the PNG's text chunks, so stored images carried none
  before. Anyone with an image's link can read its prompt, as with any ComfyUI PNG. Redraw reads
  it to pick its model (Redraw, above). The route considered first, our extension converting with
  the metadata copied, needed a new agent on every PC; the built-in node needs nothing.
- **Image URLs.** `/img/<id>` streams the stored image from R2 (no GPU involved; about 0 ms of
  CPU). Each result's text block carries the image id and this URL for the user. No
  `resource_link`.
- **Encrypted images (2026-10-11), a setting, off by default.** With **Encrypt new images in R2** on
  (Settings), a new image (output or upload) is stored sealed, so it isn't readable in the bucket
  or to automated scanning. Not secrecy from the account's owner: the key sits in the same
  account. AES-256-GCM through `crypto.subtle` with the Worker's image key (`secrets.image_key`,
  made the first time the setting is turned on, never rotated or deleted: losing it loses those
  images), a random 12-byte IV, and the R2 key `img/<id>` as associated data, so a sealed file
  only opens under its own id. Stored as `application/octet-stream` with R2 `customMetadata`
  `{enc: "aes-gcm-1", iv: <base64>, type: <the image's type>}`. Reads open any object with the
  mark, whatever the setting; unmarked objects read as before, so turning it off keeps sealed
  images readable and new ones plain. `/img/<id>` buffers a sealed image to decrypt it (HEAD
  answers from the metadata); an isolate that cached the secrets before the key existed reads
  them again. A file that fails to open (changed, or moved to another id) answers 404 or a tool
  error, never garbage. Scope `img/` only: LoRAs stay plain (Modal and the agent fetch them by
  signed URL). Cost, measured on a probe Worker: about 1 ms of CPU per MB each way (0.4 ms for a
  400 KB WebP), so +0.4 ms per generation, +0.8 per edit, and an upload 1 ms per MB.
- **Edits** read the image from R2 and upload it into the answering ComfyUI's inputs as
  `upload-<id>.<ext>`, so editing the same image twice reuses one file; its size comes from the
  bytes. A URL is downloaded and uploaded the same way.
- **Uploads from claude.ai** use the code-execution sandbox (S3). A `request_upload` tool returns a
  one-time URL plus the snippet to run. The sandbox posts the attached file, the Worker stores it
  in R2 under the token's nonce (which is the new image id), the tool result carries that id, and
  `edit_image` takes it. No GPU has to be online for an upload.
  Attached files stay available in the sandbox for the conversation, so the upload happens when the
  edit is requested. The tool description covers the case where code execution is off: ask the user
  to enable it or give a URL. The snippet sets its own `User-Agent` (see section 8).
- `edit_image` accepts an upload reference, a previous output reference, or an https URL.

### LoRAs in R2

**One way in** (decided 2026-09-30): every LoRA comes through **Upload LoRA** on a settings page,
and only LoRAs that came in that way exist for the app. A PC may hold hundreds of LoRAs in its
ComfyUI's folders, many not for our models; they are never listed, synced or configured. On a
machine "ours" is a registry, `loras.json` in the app's home, of the names uploaded or copied there
(`packages/local` `lora-uploads.ts`); the folder alone would not do, since a shared folder is the
user's.

**R2 is the hub** (2026-10-01). On a Worker an upload goes into R2 as `lora/<name>` (never
expiring), and every GPU copies from there: Modal's Volume through its admin API, a PC through the
agent's sync (§9). The extension's upload goes into this computer's LoRAs folder. Both speak one
chunked protocol (`packages/core` `lora-upload.ts`: the name and chunk rules both servers check, and
the one sender the page and the agent's push use): open a session, PUT chunks, each answered with its
MD5 (R2's ETag for a multipart part, or the extension's own), which the sender compares with its own,
then finish with the list of parts. Delete removes a LoRA from R2 and every GPU, and records the name as
deleted so a PC that was offline drops its copy at its next sync instead of pushing it back.

A LoRA a model is set to use is ours too (2026-10-01, the extension's upgrade from v1.2.0): the
extension's server adopts the configured names into the registry at start and on every save,
when the file is in a LoRA folder ComfyUI reads, ours or a shared one. The registry finds a name
in our folder first, then in the others; deleting one from a shared folder only forgets it. (With
"Your own ComfyUI", removed 2026-10-15, LoRAs were typed in by name.)

LoRAs are uploaded from the settings page, and each belongs to one **LoRA group**: the model
family it was trained for (`lora_group` on a pack). Since 2026-10-18 every family has one:
`anima` (Anima, Anima Turbo), `zimage`, `klein4b` (Flux 2 Klein 4B and its Edit: one base model),
`klein9b`, `qwenimage21` (Qwen Image 2.1, both tools) and `krea2`; before, Anima's was the only one. `packs/tools.json` defines them in order, the first
the default: a title, the base model names trainers write (`base_models`), the tensor layout and
width that recognise a file without them (`match`), and optionally `trigger_note`, what the tool
description says its triggers are (Anima's: "@artist styles or concept tags"). The engine needs
nothing per family: `injectLoras` chains `LoraLoaderModelOnly` after the `cg:model` loader, and
ComfyUI-GGUF patches LoRAs into GGUF models.

**Which family a file is for** (core `lora-detect.ts`, run by the page on the file before it
uploads, so the Worker spends nothing): its safetensors header's `ss_base_model_version` or
`modelspec.architecture` or `base_model` (an `org/` prefix dropped; a name matches its base or a
variant of it, not another version: `qwen_image_2512` is no `qwen_image_2`) when present, else its
tensor names (Anima `blocks.N.cross_attn`, Krea 2 `blocks.N.attn.wq`/`gate` or `text_fusion`,
Z-Image `layers.N.attention`, Qwen Image 2.1 `transformer_blocks` 0–31 with no single-stream blocks
(v1 has 60, with `add_q_proj` and `txt_mlp`), Flux 2 `double_blocks`/`single_blocks` or diffusers
`transformer_blocks`, 8 of them) and most common input width (2048, 6144, 3840, 4096, and 3072 for
Klein 4B, 4096 for 9B). Flux 1 looks like Klein
4B (`double_blocks`, 3072) and is told apart by its per-block modulation, block count and MLPs 4×
the width (Flux 2's are 3×); Lumina 2 has Z-Image's names at 2304. Checked against ten LoRAs from
Hugging Face (2026-10-18): every Z-Image, Klein 4B/9B and Anima one right with or without its
metadata, Flux 1 and SD 1.5 refused; and against 13 more for the new models: five Krea 2 (ComfyUI,
ai-toolkit, kohya, PEFT, Krea's diffusers) and six Qwen Image 2.1 (DiffSynth, lightx2v, ai-toolkit,
PAI) recognised, two Qwen Image v1 refused. The one named "Z-Image-Lora" says Krea-2 in its file
and is one. An upload goes into the
family found, saying so; one made for another model asks first; one it can't tell goes into the
open family. The file's `modelspec.trigger_phrase`, when it has one, becomes the trigger. `pack_loras` is keyed by
group, and each entry is file, enabled, strength, trigger (it applies only when the prompt
contains the trigger; no trigger means always), hidden (the trigger is not listed in the tool
description); a switched-off LoRA is not loaded, advertised or warned about. **Strength per pack**
(v1.19.0, the user's call: Anima and Anima Turbo take LoRAs differently): an entry may carry
`strengths: {pack: n}`, and a pack's strength is its own there, else `strength` (core
`strengthIn`; `packLoras` hands each pack its own, so generate, edit and redraw all use it, a
scripted caller's `model` included). The page keeps the map only while the packs differ, and
`strength` as the first pack's, so a config without it, or a version before it, reads the same. The
settings page picks the group shown from a **Model family** list (each with how many are on, and
"not selected" when none of its models is; `#settings/loras/<group>` opens one, and each model
card links there), and a LoRA can be moved to another family from under its name. A stored LoRA in no group (from before groups, or pushed from a PC) joins the
default group switched off (`tagLoras`): the Worker on listing, saving and an upload's finish (which
names its group), the extension at start and likewise, and the page on its working copy so a save
doesn't undo it (2026-10-03; before, being in a family's list meant both "for these models" and
"on"). A LoRA whose trigger is not in the prompt is taken out of the workflow, not set to
strength 0: ComfyUI checks every loader's file, so a missing file would fail calls that never asked
for it (seen 2026-10-01). Deleting a LoRA also takes it out of every pack's settings. On Windows a
file ComfyUI has open can't be deleted (a LoRA it used stays open): the LoRA leaves the list at
once, ComfyUI is asked to unload its models (`POST /free`) and the delete retried for a few seconds,
and failing that the file waits in `loras-pending-delete.json` until ComfyUI stops (2026-10-02).

- **Upload path, through the Worker into R2.** `POST /api/loras/uploads` opens an R2 multipart
  upload (the session, with R2's upload id, in the State object's `lora_uploads`, 24 h); each
  `PUT <id>/<index>` streams one 8 MiB chunk into its part (R2 wants equal parts but the last, each
  at least 5 MiB), about 1 ms of Worker CPU, and answers the part's ETag; `POST <id>/finish
  {parts}` completes it. A bucket rule drops a multipart upload left unfinished after a day.
- **Copies to the GPUs.** After an upload, a settings save and a Modal deploy, the Worker asks the
  Modal admin API to `POST /loras/fetch {name, url, size}` for each LoRA the Volume lacks: a CPU
  function downloads the storage link (a `/store/<token>` URL the Worker signs, serving R2 with
  Range) into `models/loras/` and requests the idle-time reload, so a warm ComfyUI sees the file
  (§3, S5(d)). An online PC is told to `sync`.
- Saving settings warns about configured LoRAs that R2 lacks (deleted, or a PC's own not yet
  pushed).

## 5. Config and settings

- Config lives with the brain: the `State` Durable Object for the Worker (Workers KV caches reads
  at the edge for up to a minute, which gave stale reads and lost updates live; see §11), a local
  JSON file for the MCPB.
- One Svelte settings app, rendered from the declarative settings schema, served by the Worker
  (behind a Cloudflare-token login and a cookie session) and by the MCPB's local server.
- Keep-warm and ComfyUI flags are set per GPU in the GPU list (§2, "GPUs"). Keep-warm: Modal's applies to its
  `scaledown_window` (live, through `update_autoscaler`, S5), a PC's to its agent's idle stop (idle
  time on a PC costs nothing, so a new PC starts at 10 minutes and Modal at 5). The extension keeps `keep_warm_minutes` in its settings for its idle
  stop.
- Which GPU answers is the list's order (§2, "GPUs").
- `remove_marks` (default on): clean painted-in signatures and watermarks (§3, "Signatures and
  watermarks"). It is a card beside the model cards, a checkbox only: its models download in the
  background.
- **One config for every backend** (decided 2026-09-30, after trying one per backend): Claude sees
  one tool list, and its descriptions (styles, LoRA triggers, packs) cannot change with which
  backend is online, so separate settings needed a "keep these the same by hand" warning. What
  really differs per GPU is its files, so the one Settings page shows those per GPU:
  - **Models:** a card per image tool, side by side: its model, its options, and the chosen
    model's state on each GPU (ready, downloading, missing with a Download button). Saving starts
    the downloads on every GPU, and a model picked but not saved says so (`GET /api/models` returns
    `{gpus, packs: [{…, on: {gpuId: status}}]}`; `?gpu=` for one; one poll serves every card).
  - **LoRAs:** the Model family list (§4), then a table (v1.19.0) with column headers: file (Move
    to… under it), Enabled, a strength column per pack of the family (Anima, Anima Turbo), Trigger,
    Hidden, the size once, then a column per place
    (Stored, each GPU) showing only ✓ or the copy's state, and delete; upload below. Narrower than
    760 px, a card per file with each value labelled. Packs sharing a settings key
    share their LoRAs (Anima and Anima Turbo). A new trigger is the file name, with the `@` that
    Anima's artist tags use for packs whose styles are @tags. Every stored LoRA is copied to each
    GPU (§4, "LoRAs in R2").
- **The page's shape (2026-10-11).** Full-window on the Worker, like Setup: a bar of sections
  (Models, LoRAs, GPUs, Worker; on the extension Models, LoRAs, This computer), one shown at a time
  (`#settings/<section>`). The config (models, options, LoRA choices, the extension's keep-warm) is
  a working copy with one Save, in a footer that shows only while something differs from the last
  save, naming what; Discard restores it, and leaving the page or the tab asks first. Everything
  else acts at once and never shows there: uploads and deletes, downloads, the GPU list (rename,
  order, keep-warm, pause), and the Worker section (the connector URL to copy, show or replace, as
  on Setup's Claude step; image encryption; the password; the account).
- The extension's page is the same, for its one computer, at its usual width. `#settings` opens
  the page directly.

## 6. Setup flows

The whole setup is one stepper led by two questions (2026-10-03). The static site (`site/`,
published to GitHub Pages by `.github/workflows/pages.yml`) asks **how will you use it**
(claude.ai, recommended; or Claude Desktop only, which leads to the extension and needs no
Worker), then **where images are made**: the cloud (Modal, recommended for most people), my PC, or
both (the PC first, Modal while it is off). Only that answer's steps follow: the accounts it needs,
the Deploy button, opening the Worker. Connecting GitHub happens inside Deploy (the v1.9.0 dry run
found that installing Cloudflare's app from GitHub's side never links the Cloudflare account): the
deploy form's **New GitHub connection** → GitHub's **Install & Authorize** → Cloudflare lands on
its own "Select a repository" page, which is ignored → the Deploy button again, where the account
is now listed. An app already installed (an earlier try) dead-ends on GitHub's settings page:
uninstall it and start over. Cloudflare's build-log viewer stops early (the API has every line),
so the site sends people to **Visit** once the build shows Success. Its progress is kept in the
browser; without JavaScript every step shows.

**The answer reaches the Worker through the template.** The Deploy button can't carry data, and
the site never learns the Worker's address. So there is one template per answer,
`bootstrap-cloud/`, `-pc/` and `-both/`: `bootstrap/` plus `"vars": {"SETUP_MODE": …}`. The
deploy form shows that variable filled in; the build (`deploy.py`) carries it over from the user's
copy; the Worker takes it as its answer. `bootstrap/` stays the answer-less template for old links.

The Worker's page is the rest of the stepper: log in; **turn on storage** (below); **where should
images be made?** (the answer: chosen on this page, stored in `setup.mode`, else `SETUP_MODE`);
that answer's steps (Set up your PC; Deploy ComfyUI to Modal and its models);
connect Claude. Changing the answer only adds steps. Each step ticks itself from the Worker's state:
the generator set, the models on the Volume, the PC connected, and Claude having connected (the
first `tools/list` on the connector URL sets `claude_seen` in the `setup` key; a new URL clears
it). Until Claude has connected, the page opens on Setup rather than Settings. The agent's and the
extension's own pages carry a short checklist on top (pair, install ComfyUI) above their usual
sections.

**Both are full-window wizards (2026-10-11).** One step at a time, under a bar of the steps
(`site/guide/wizard.css`, shared; the site's inline script, the Worker's `Wizard.svelte`). A step
with a walkthrough pins its screenshot to the left of the window, as tall as it, and puts its
text, controls and Back / Next in a column on the right; on a phone they stack. One Next drives
both: through every step of the walkthrough, then on to the next step, and no further until the
step is through. On the site that means a question answered, every account ticked, or the
walkthrough walked to its end, remembered once done; on the Worker's page it is the step's real
state (storage on, the PC paired, Modal deployed, Claude connected), with "Waiting for …" under a
disabled Next. The models step lets you go on while they download. The
login page sits beside the token walkthrough the same way, with its own Back / Next. Without JavaScript the site is still
the long page with every step open; a walkthrough that can't load falls back to its plain steps
and holds nothing.

**Things happen by themselves (2026-10-14, from a run-through as an average user).** Its notes:
instructions hid in grey text, pages lacked buttons to the pages to visit, there was jargon nobody
needed, the Modal card was a step of its own, and filled-in fields still waited for a click. So:
- A step that turns done while it shows says "Done" and moves on (`Wizard.svelte`); moving on
  passes over steps with nothing to do (*skip*: already done, such as the answer the setup site
  gave, or the models once Modal is up). Back and the bar still open them, and the first step after
  the answer says what it was, with **Change**.
- Pasted input acts at once: the Cloudflare token logs in, Modal's `modal token set …` command
  starts the deploy, the pairing link pairs the agent (each keeps its button).
- Coming back to the tab (`onReturn`) checks what was done elsewhere: storage after **Open
  Cloudflare storage**, the deploy again after **Add a card in Modal**.
- Every page to visit is a button (`OpenButton`): R2, Modal's sign-up, tokens
  (`modal.com/settings/tokens`) and billing (`modal.com/settings/usage`), claude.ai. What to do is
  a numbered list (`ol.steps`) of plain sentences, each with its button or field; grey is only for
  optional detail. Since v1.20.2 a walkthrough's steps are items of that same list (below).
- **The card is checked by the deploy.** Modal has no API that says whether a card is on file, so
  there is no card step: a deploy refused for it shows **Add a card in Modal**, and retries when
  the user comes back.
- **Claude** gets claude.ai's install link, `claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Comfy-Gen&connectorUrl=…`:
  the dialog opens filled in, and the user clicks Add, then Connect. The URL to copy by hand is
  folded under it.
- Default-only walkthrough steps are gone (the project name, SETUP_MODE, "keep No sign-in"); old
  Workers load the same `guides.json`, so only steps are removed, never a guide.

The PC step follows the pairing in order: with no PC, only **Add a PC**; with one waiting to pair,
the agent's download for this browser's system (the others one click away) and how to run it
unsigned, then the pairing link and **Copy link**; once paired, the GPU list and **Add another
PC**. The last step's button, where Next would be, is **Go to settings**. The build log is a line
of status with the log under **Details**, open from the start and left to the user (v1.20.1: a
bound `open` was reset by every poll, closing it).

**From a tester with little English (v1.20.1).** Their notes: Next for every trivial sub-step,
earlier sub-steps hidden, too much going back and forth between the Worker's page and the agent's,
and the agent's page offering the Worker's settings before the PC was set up. So:
- **One list per page, walked with Next (v1.20.2, the user's design).** v1.20.1 showed each
  walkthrough whole; what was wrong was the nesting: on the Worker a walkthrough sat inside one
  item of the page's numbered list, with its own 1, 2, 3. Now the page's steps and the
  walkthrough's are one list (`Walk.svelte` with `WalkStep` and `WalkGuide`; `tour-core.js`
  `steps` and `stageAt`), every step always listed. Next moves which one is current (red) and the
  screenshot; a click on a step goes to it. A step's buttons and fields show only while it is
  current; errors, progress and alternative routes (typing the token, adding the connector by
  hand) stay outside the list. A step of the page's own shows the nearest screenshot: the one
  before it with its markers done, else the next one bare. The site walks its walkthroughs the
  same way (the Deploy button stays above the list, as two of its steps use it).
- **The PC step waits for a ready PC**, not just a paired one: paired, and its hello saying
  ComfyUI is installed (`comfyui` not `not_installed`, `installing` false). The agent sends its
  hello again when ComfyUI's state changes. The step lists each PC's progress (waiting to pair,
  click **Install ComfyUI**, installing, ready), and **My PC is set up, continue** lets anyone with
  an older agent through. The agent's page shows **Open your Worker's settings** only once ComfyUI
  is installed; until then it says to install it first.
- **claude.ai is optional** on the site's accounts step: "A claude.ai account (optional)", any app
  with MCP tools will do; no box to tick.
- **Plain wording** on the site, the Worker setup and the agent's page: one action per sentence,
  short common words, button and field names in bold as they read on screen (the walkthrough's
  "Modal command" box is **Paste the command here**; the agent's button says **Install ComfyUI**).
  Instructions stay HTML, never in screenshots, and the site says the browser can translate it
  (`lang="en"`).

**Storage is a step, not a prerequisite.** R2 needs a checkout with a card on file, which can't
be automated, and a Deploy button on an account without R2 used to fail (wrangler's error 10042).
The templates no longer declare the bucket; the build checks R2 (`wrangler r2 bucket list`) and,
when it was never turned on, deploys without the binding. The Worker then runs without storage:
tool calls, uploads and the LoRA routes say "storage isn't turned on yet" without touching a GPU,
listings are empty, and its page shows the step (R2's dashboard button, the checkout, then a check
when the user comes back to the tab, or **Check now**: it rebuilds through the update path, and the
build binds the bucket once R2 is on). An R2
error the build can't place keeps the bucket bound, so an install never loses its storage to a
hiccup. `COMFY_GEN_TEST_NO_STORAGE=1` (a build variable) forces the no-storage path for testing.

**Costs** are on the site, folded under "What does it cost?" (Cloudflare free for one person, R2
past 10 GB at $0.015 per GB a month; Modal per second with $30 free a month and a card on file).

### No GPU

1. Static site: the two questions (claude.ai, then the cloud), the accounts (Cloudflare, GitHub,
   Modal with a card on file), connecting GitHub, then the Deploy button for `bootstrap-cloud/`.
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
   for each selected pack and the rest of its family. The setup page streams the build logs, then
   the downloads (about 23 GB for the defaults, Anima beside Anima Turbo; about 3 minutes). A tool whose models are not on the Volume yet answers with
   the download's progress instead of failing inside ComfyUI.
   If `modal deploy` fails, the build still deploys the Worker, and the callback carries Modal's
   own reason (the text of its Error panel, such as "Please add a payment method to use L4 GPU
   functions." on an account with no card, seen in the from-scratch test). The setup page shows it
   in the Modal step (for a missing card: **Add a card in Modal**, and a retry on coming back), and
   **Try again** starts a build without token fields: the build secrets keep the stored token, which
   Modal would not show again.
7. **Add to claude.ai** opens claude.ai's connector dialog filled in.

### GPU owner

1. Steps 1 to 3 of "No GPU", choosing "On my PC" instead of pasting a Modal token.
2. The step "Run the agent on your PC" makes a pairing link, `https://<worker>/agent#<secret>`, and
   links the launcher downloads.
3. The user downloads the launcher for their OS from the release and runs it. It installs itself,
   fetches Node, starts the agent and opens the agent's page on `127.0.0.1:9248`.
4. There they pair: the Worker page's **Pair with the agent** opens `127.0.0.1:9248/#pair=<link>`
   (v2.2.2; the link stays in the fragment), which pairs at once while the agent is unpaired, and
   asks, naming the Worker, before replacing a pairing, since any page can open that address.
   Paired that way, the page goes back to the Worker's page once ComfyUI is installed here (at
   once when it already was). Pasting the link still works. Then they install ComfyUI as in the MCPB (GPU choice; other
   installs' model folders are found and used, and listed before the install beside a field for
   another models folder, so nothing downloads twice). The agent connects to the Worker and keeps the
   connection; the Worker's page shows it connected, with its GPU and ComfyUI state.
5. From then on the agent starts at login, starts ComfyUI on the first job, downloads a pack's
   missing models when a tool needs them, and stops ComfyUI after the idle window.

Modal can be added (or kept) as the fallback: each call uses the PC when it is connected and Modal
otherwise. A new pairing link replaces the old secret (the connected agent is dropped); "Unpair"
removes it.

### Claude Desktop only

Install the `.mcpb` in Claude Desktop, open the settings page from the tray or the first tool
result, pick the GPU and install ComfyUI (or keep the old extension's). Before the install the page lists
the model folders it found and asks for any other one: models download at the first image, so this
is the moment to say where existing ones are. No accounts.

### Sign-in, and a setup without a repository (direction, 2026-10-17)

Two of setup's hardest parts are tokens: the Cloudflare token on the login page (a template link,
narrowing "All accounts", copying) and the Modal token (New Token, Create, copying the command).
And the GitHub connection inside Deploy is the most error-prone step of all. Two new facts change
what is possible:

- **Cloudflare has real OAuth** (self-managed OAuth clients, open to every account since June 2026).
  Authorization code with PKCE (or a client secret); scopes are API-token permission names; the
  consent screen shows our name, logo and verified domain and lets the user pick the account(s),
  and the user can revoke it from their profile. A client is private (our account's members only)
  until we verify its domain and make it public, which is permanent.
- **Workers can call gRPC servers** (private beta since August 2026): the Worker speaks gRPC-web and
  Cloudflare's edge converts it to gRPC. Unary and server-streaming only; bidirectional needs
  Containers. Modal's control plane (`api.modal.com`) is gRPC.

**Buildable now, for every user:**

- **Log in with Cloudflare.** The Worker starts the flow with PKCE and exchanges the code itself. A
  client registers fixed redirect URLs and every Worker has its own address, so the redirect is one
  page we own (on the setup site) that relays the code to the Worker named in `state`. A code
  relayed elsewhere is useless without the Worker's verifier, so the relay holds no secret. One
  consent screen replaces the token walkthrough, and could replace the password too: an OAuth login
  proves the person controls the account the Worker runs in. The Worker keeps the refresh token for
  what it does with the pasted token today (the build trigger, build secrets).
  To check first, on a private client on the test account: the access and refresh token lifetimes
  (the docs don't say), whether the Builds API takes an OAuth token (it rejects account API tokens,
  §8), the scope names (`GET /oauth/scopes`; today's four permissions, §8), and domain
  verification for a `github.io` address (we may need a small domain of our own).
- **Approve in Modal (the token flow, run by the build).** `modal setup` gets its token from two
  unary calls: start a token flow (an approval URL on modal.com, a flow id, a wait secret), then
  wait for the user to approve it there. The Workers Build already runs the Python SDK, so the
  Worker starts a "connect Modal" build, the build starts the flow and posts the approval URL back
  (the nonce callback the deploy uses), the page shows **Approve in Modal**, and the build waits,
  stores the token in the build secrets and goes on to the deploy. No tokens page, no copying. The
  button appears after the build starts (about 30 to 60 s: "Preparing Modal sign-in…"). The typed
  token stays as the fallback. To check first: that the flow completes from a headless build
  without the CLI's `localhost` callback.
- **Modal's state through the admin app.** `comfy-gen-admin` runs the Python SDK inside Modal,
  signed in to its workspace, and already sets keep-warm through it (`/idle`). It can also report
  the ComfyUI function's stats (queue backlog, running containers) so a tool call can say "Modal
  is starting a container", and stop the container on demand. It exists only after a deploy, so
  it can't check a token before the first one.

**The direction: no repository.** With both, the setup site itself could create the Worker through
the Cloudflare API (upload the script, create the R2 bucket, set the variables) and skip GitHub and
the Deploy button. The Worker would update itself by uploading a new script version. What still
needs a repository is the Modal deploy: `modal deploy` is the Python SDK at work (the image
definition, mounting our code, creating each function from its Python definition, publishing), and
Workers Builds need a connected repo. Re-implementing a deploy in the Worker would copy SDK
internals that change every release; Modal's own JS and Go SDKs say defining functions will likely
stay Python-only. The route that works: once Workers have gRPC, the Worker creates a **Modal
Sandbox** in the user's account from a stock Python image, which runs `pip install modal`, fetches
our release and runs the real `modal deploy` with the user's token; the Worker streams its output
and reads its exit code. A few simple calls, not a deploy, and seconds of CPU on Modal.

**Unblocked without waiting for GA (decided 2026-10-17): our own gRPC-web proxy.** Workers gRPC is a
closed beta. Users already run self-updating code from us, so routing Modal calls through a proxy
we host adds no new trust. The proxy:

- is stock Envoy (`grpc_web` filter, no code of ours) on Google Cloud Run;
- forwards only to `api.modal.com:443`, and only the methods setup needs (403 for anything else);
- is rate-limited, capped at two instances, keeps no state and writes no access log;
- is retired when Workers gRPC is GA: the same calls then go direct.

Decided with it:

- **A setup Worker on our account,** stateless, does the Cloudflare side: OAuth, creating the
  user's Worker, R2. The browser can't call `api.cloudflare.com` (no CORS), and the user's Worker
  doesn't exist yet at that point.
- **The user's Worker then drives Modal:** the token flow, and the deploy from a Sandbox.
- **The Modal token is kept twice,** so either update path works:
  - as a Modal Secret in the user's workspace;
  - in the user's Worker.
- **Existing installs migrate;** the GitHub route becomes legacy.
- **Releases ship the built Worker bundle** for the self-upload.
- **The Modal client version** is read from npm (`modal`, libmodal) and refreshed once on a
  version error.

### The spike (2026-10-17): every piece proven on the test accounts

**Proxy.**
- Envoy 1.39.4 on Cloud Run (us-east4, `--timeout 3600 --max-instances 2`), setup cost about
  nothing: a few hundred vCPU-seconds against a 180,000-second free tier.
- A disallowed method answers 403 in 0.35 s; an allowed call reaches Modal in 0.39 s.
- Server streams arrive unbuffered (a log line 0.1 s after it was printed).
- Modal itself ends one log call after 55 s, not Cloud Run; the client resumes from
  `last_entry_id`.
- GCP gotchas, for whoever sets this up again:
  - a billing account allows only a few linked projects;
  - re-linking a project that's already linked reports that quota as the error;
  - a budget must be in the billing account's own currency (EUR here), or the API answers only
    "invalid argument".

**Modal over gRPC-web (`fetch` only, so it runs in a Worker).**
- protobuf-es codecs generated from `modal_proto/api.proto`, plus a ~150-line transport:
  5-byte frames, the trailer frame or trailers-only headers, unary and server streams.
- Headers as libmodal sends them:
  - `x-modal-client-type` 8 (LIBMODAL_JS), `x-modal-client-version` 1.0.0;
  - `x-modal-libmodal-version` from npm;
  - the token id and secret, plus `x-modal-auth-token` from `AuthTokenGet`.
- **Token flow:** `TokenFlowCreate` needs no credentials, and works headless (no localhost
  callback). The person approves on modal.com, and `TokenFlowWait` (40 s polls) returns the token:
  78 s including the approval.
- **Deploy from a Sandbox:**
  1. `SecretGetOrCreate` holds the token (`MODAL_TOKEN_ID/SECRET`);
  2. `AppGetOrCreate` makes the app `comfy-gen-setup`;
  3. `ImageGetOrCreate` + `ImageJoinStreaming` build `python:3.12-slim` + `pip install modal`;
  4. `SandboxCreate` (network open, the Secret attached) runs
     `bash -c '… > app.py && modal deploy app.py'`;
  5. `SandboxGetLogs` streams the output, and `SandboxWait` returns the exit code.

  First run 28 s, with the image built (13.6 s); later runs about 6 s, through Cloud Run 7.6 s.
- **Updates, both ways proven:**
  - (1) a function of the app runs `modal deploy` on its own app. Inside Modal the CLI ignores the
    token env vars and uses the container's credentials, so this way needs no stored token;
  - (2) the Worker starts a fresh Sandbox, as for the first deploy.
- **Modal deploys are rolling:** a warm container of the previous version keeps answering until
  it idles out, as with today's updates.
- **In a Worker:**
  - the client adds 86–103 KB gzipped;
  - CPU per request (Workers Logs `cpuTimeMs`, 12 calls each): the unauthenticated token flow
    call median 1 ms; three authenticated calls (auth, app, image) median 9 ms, max 17. The max is
    a fresh isolate decoding the whole proto descriptor. The milestone can trim the codecs to the
    ~15 messages used, and keep the auth token across calls.

**Cloudflare OAuth.**
- **Endpoints,** from `dash.cloudflare.com/.well-known/openid-configuration`: authorize
  `/oauth2/auth`, token `/oauth2/token` (PKCE S256, `token_endpoint_auth_method: none`, so no
  secret), revoke `/oauth2/revoke`.
- **Clients are created by API** (`POST /accounts/{id}/oauth_clients`, needs "OAuth Client
  Write"). Scope ids come from `GET /oauth/scopes`; `offline_access` is added for a
  `refresh_token` grant.
- **The scopes we need:** `workers-scripts.write`, `workers-r2.write`, `account-settings.read`.
- **Tokens:**
  - access tokens last 1 hour;
  - a refresh takes about 0.45 s and rotates the refresh token, so the Worker must store each new
    one; the refresh token's own lifetime isn't stated;
  - the token reads accounts, scripts, R2 and the workers.dev subdomain;
  - `/user` and the Builds API are refused (not in scope; we drop Builds).
- **Going public is permanent and needs domain verification:** a DNS TXT record
  `cloudflare_oauth_client_publisher=…` on the client URI's host, verified within two days.

**Creating the Worker by API, with only the OAuth token** (what wrangler does, by hand). The steps:
1. create the R2 bucket;
2. open a static-assets upload session (manifest of path → hash and size, the hash as wrangler
   computes it), and upload only the files it asks for;
3. upload the script (multipart: metadata plus the bundled module) with bindings, Durable Object
   migrations and the assets config, `run_worker_first` included;
4. set the cron;
5. enable workers.dev.

Results:
- Our real bundle (215 KB, 57 KB gzipped) was serving its settings page in 7.9 s, with the
  Durable Objects answering.
- **Self-update** is the same calls: a new version went up in 3.5 s with a freshly refreshed token.
  Unchanged assets are skipped (0 to upload); the migration is sent as `old_tag` = `new_tag`.
- Embedding `web/dist` in the script wasn't needed: the assets upload is straightforward.

**Still for the milestone:**
- the real `comfy-gen` deploy and its nonce callback (not run, so as not to replace the live test
  app);
- the setup site's UI and the migration of existing installs;
- the custom domain for the setup Worker, the proxy and the public OAuth client.

R2's checkout and Modal's billing stay manual.

### Setup without a repository: the Cloudflare side (Phase 1, built 2026-10-17)

The milestone has four phases, with no numbered release until the first three are done:
1. **the setup Worker and the Worker updating itself** (this section);
2. **Modal through the proxy:** the token flow, the deploy from a Sandbox, and `grpc.lugia19.com`
   as a pass-through Worker to Cloud Run;
3. **migrating existing installs:** Connect Cloudflare, plus `workers-ci.write` so the Worker can
   delete its old build trigger; the GitHub route becomes legacy;
4. **later:** the OAuth login replaces the password.

**The setup Worker** (`packages/setup`, `comfy-setup.lugia19.com`, on our account) serves the site
(`site/`; GitHub Pages keeps publishing `site/guide/`, which Workers load their walkthroughs from,
and redirects its front page). The steps are use → where → accounts (no GitHub) → **Connect
Cloudflare** → **Create** (account, Worker name, and a workers.dev subdomain if the account has
none) → **Open**. It is stateless and stores nothing:
- `/oauth/start` puts the PKCE verifier and state in a cookie sealed with AES-GCM under
  `COOKIE_KEY` (ten minutes); `/oauth/callback` checks the state and exchanges the code; the
  tokens wait in another sealed cookie (50 minutes, the access token lasting an hour) until
  creation.
- `POST /api/create` (about 8 s, mostly waiting on the API) refuses a name the account already
  uses, then: the bucket (R2 off, error 10042, is fine: no binding yet), its lifecycle, the
  latest release uploaded with a fresh one-time `CLAIM` secret and the vars below, the cron, and
  workers.dev. It then hands the tokens to the new Worker's `/api/claim` (retried for up to 30 s
  while the new address still answers 404), which answers a login ticket, and the browser opens
  `<worker>#ticket=…`. The tokens cookie is cleared.
- The vars it sets, which every later version carries (`releases.WORKER_VARS`): `SETUP_MODE`,
  `CF_OAUTH_CLIENT`, `COMFY_GEN_SETUP` (its own address) and, in development, `COMFY_GEN_RELEASES`.
- `/reconnect?worker=…&code=…` signs in again for a Worker whose connection was lost, and hands
  the new tokens over only if that workers.dev address is a Worker in an account the sign-in
  reaches: a link can name any address, and the tokens must only reach the user's own Worker. The
  Worker checks the account too, and its one-time code (15 minutes).
- `/privacy` says what it does with the access.

**Releases ship the Worker as a bundle** (`packages/worker/build-bundle.mjs`, run by
`release.yml`): `worker-bundle.js` (wrangler's own bundling, `deploy --dry-run`),
`worker-assets.json` (the settings app, `{hash: base64}`, hashed as wrangler does) and
`worker-manifest.json` (module hash, bindings, migrations, assets config and files, crons, read
from `wrangler.jsonc`). Core `releases.ts` loads one (checking the module's hash) and uploads it as
a version (`cfapi.ts`): only the static files Cloudflare lacks, then the script with
`keep_bindings: ["secret_text"]` and the migrations after the script's current tag. In development
the setup Worker serves bundles built from the branch (`packages/setup/build-dev.mjs`, plain
versions past the real releases) at `/dev/<tag>/` with a `latest.txt`, and Workers it creates use
that base.

**The user's Worker** (`App`):
- **Claim:** `/api/claim` takes `{claim, tokens, account_id, script}` once, checked against
  `CLAIM` (`cf_claimed` in the secrets), or `{reconnect, tokens, account_id}`. It answers a
  one-use login ticket (ten minutes). One-use codes are kept as SHA-256 hashes in the setup state.
  The password step follows, as before.
- **OAuth tokens** live in the State object (`cf_oauth`) and are only touched there, one call at
  a time (`oauth.Lock`): each refresh rotates the refresh token, so the new pair is stored before
  the access token is used. The daily cron refreshes even with nothing to update, so the grant
  never sits idle. `invalid_grant` marks the connection lost (`/api/state` `cf_lost`), and the
  page shows **Reconnect Cloudflare**.
- **Updates go through one `updates.Updater`:** a Workers Build (made from a repository) or an
  upload of itself (`App.uploadSelf`). The daily check, Update now and the storage check use it
  alike. The upload makes sure the bucket exists first, so R2 binds with the next upload once it
  is on, as `deploy.py` does at each build; the storage check is an upload of the same version.
- **A Cloudflare token still logs in** (the way back when the setup site can't be reached): it only
  proves the token sees this Worker, and isn't kept. The password this section started with was
  replaced by Log in with Cloudflare in Phase 4 (§8).

**End to end on the test account (2026-10-17),** through `comfy-setup.lugia19.com` with dev bundles:
- Created `comfy-gen-p1test`: every binding, `CLAIM` as a secret, R2 bound, the cron. Claim and
  ticket login, the password, a token login, and Reconnect Cloudflare all worked.
- Self-updates: v9.0.0 → v9.0.1 in 5.2 s (2 changed files uploaded), v9.0.2 → v9.0.3 in 3.6 s
  (none); bindings and the secret survived; live on the next request. The storage check answers
  from the live version.
- Found and fixed live: a Worker can't fetch its own custom domain (the setup Worker reads `/dev`
  through its ASSETS binding), and static files must go up with their content type, or Cloudflare
  serves them with none and the browser won't run the settings app.
- CPU (Workers Logs `cpuTimeMs`): setup `/api/create` median 7 ms (max 12), `/oauth/callback`
  3.5; the Worker's `/api/claim` 4, `/api/state` 2.5; a self-upload (Update now, the storage
  check) 16 to 17 ms, over the 10 ms budget but rare. Phase 2 moved those into the State object
  (below).

### Setup without a repository: the Modal side (Phase 2, built 2026-10-18)

A Worker made by the setup site has no Workers Build to run `modal deploy`, so it connects and
deploys Modal itself, through our gRPC-web proxy (the spike above):

- **The proxy's address** is `grpc.lugia19.com`, a second custom domain on the setup Worker: it
  passes `/modal.client.ModalClient/*` POSTs through to the Cloud Run Envoy (`GRPC_UPSTREAM`), whose
  method allowlist is unchanged. Moving the proxy is a change to that one var. (Its static files
  answer on that address too; nobody looks there.)
- **The Worker's Modal client** (`packages/worker/src/modal/`): `client.ts` is the spike's
  transport with libmodal's headers (one AuthTokenGet shared by concurrent calls, auth tokens kept
  per Modal token until they expire, the npm-looked-up version retried once on a version error);
  `proto.ts` is a small codec over only the fields used, with Modal's field numbers, instead of
  generated code (nothing to decode at isolate start); `scripts/check_modal_proto.mjs` checks every
  field against `api.proto`.
- **Connect Modal:** Modal's sign-in (`TokenFlowCreate`, then `TokenFlowWait` polled by the page
  while the person approves on modal.com) or a pasted token. The token is kept twice: in the
  Worker's secrets (`modal_token`) and as the workspace Secret `comfy-gen-token`.
- **The deploy** runs in a Modal Sandbox (app `comfy-gen-setup`, image `python:3.12-slim` + uv): it
  downloads the release's source (GitHub's tag tarball; the dev base's `source.tar.gz` in
  development), runs `comfy_gen_modal.deploy --callback`, which runs the real `modal deploy` and
  posts the same report the build's `deploy.py` sends to `/build-callback`. So the result arrives
  with no page open, and `buildCallback` is unchanged. A Sandbox that ends without its report shows
  as Modal's error.
- **One route pair for both ways a Worker deploys Modal:** `POST /setup/modal` (with a token, or
  the stored one) starts a Workers Build or a Sandbox; `GET /setup/modal/log` answers
  `{lines, cursor, done}` from either.
- **Updates:** an update uploads the Worker, then redeploys Modal with the same release (the
  storage check doesn't); a failed start shows as Modal's error, not a failed update.
- **The heavy work runs in the State object.** Measured live, Update now took up to 51 ms of CPU
  and a deploy start 15, against a Worker request's 10 ms. Jobs (`platform.ts` `Job`: an install,
  Modal's deploy, the daily check) go to the State Durable Object (`State.runJob`), which runs
  the same App over its own storage. A CPU probe on the free plan (2026-10-18): a Durable Object
  request ran 12.7 s, 3.7 s and 1.5 s of CPU without error, while a Worker request was killed at
  1.6 s once and once at exactly 10 ms (most bursts up to about 1 s passed). Jobs aren't retried
  on a broken stub, as an upload or a deploy isn't safe to run twice.

**End to end (2026-10-18),** on `comfy-gen-p1test` in the usual Modal workspace: Connect Modal
(approved on modal.com), the Sandbox's deploy and its report, an image in 73 s from a cold start,
and five self-updates each redeploying Modal (the Sandbox reports within about 30 s, the image
cached). CPU on the Worker: `/api/modal/connect` 3 ms, `/connect/wait` 5, the log 3 to 4, Update
now 7 to 9 (the job in the State object).

### Moving an install made from a repository (Phase 3, built 2026-10-18)

An install made with the Deploy button (a GitHub copy of the template, a Workers Build, a pasted
Cloudflare token) moves to the new setup from its own page, keeping its address, connector URL,
password, PCs, images, LoRAs, settings and bucket (the build named it `<worker>-storage`, as
`cfapi.bucketName` does). After that the GitHub route is legacy, kept until the installs have moved.

- **Move to the new setup** is a banner on a Worker whose update path is "build". The Worker
  writes its answer to "where?" into its setup state (it came from the template's `SETUP_MODE`
  var, which the new version won't carry), mints a one-use code and sends the browser to
  `<setup site>/move?worker=<origin>&code=…`. The setup site's address is a constant there
  (`SETUP_SITE`): a Worker made from a repository has no `COMFY_GEN_SETUP`.
- **The setup site's `/move`** is `/reconnect`'s sign-in, with the same check that the workers.dev
  address is a Worker in an account the sign-in reaches. It then uploads the latest release over
  that script, as create does (the bucket kept and bound, the Durable Objects' migration tag from
  the script, `WORKER_VARS`; routes, the cron and workers.dev are separate resources and stay), and
  claims it with the code and the tokens, waiting while the new version rolls out. The setup site
  does the upload because only it holds the OAuth token then; a failed claim leaves a Worker that
  still updates through its build, so Move can be tried again.
- **The claim, on a move** (a reconnect code while `cf_claimed` is unset), deletes the Workers
  Build trigger with the token the build path kept (its template includes Workers Builds edit, so
  no OAuth scope is added), then forgets `cf_token`, `cf_trigger` and `cf_branch`. Its note
  (`move_note`, shown until dismissed) says the GitHub copy can be deleted, or, when Cloudflare
  refused the delete, how to disconnect the build by hand.
- **Modal after a move:** its token was only in the build's secrets, which can't be read back.
  Modal keeps running what it has; a banner (**Connect Modal**, the Setup step's component) asks
  for it, and the connect redeploys Modal with the Worker's version. Until then updates pass it
  over.

**End to end (2026-10-18),** on the real `comfy-gen` (made from the template, on a branch build):
Move, Allow on Cloudflare, and back on its page logged in (the claim 21 s after the click, the Allow included). Its address, connector URL,
bucket (images, LoRAs), cron and PC kept; the build trigger gone; the note shown. Connect Modal
redeployed in 7 s (nothing had changed), an image came through the old connector URL (137 s,
cold), and Update now to the next dev bundle redeployed Modal 9 s later. CPU on the Worker:
`/api/cloudflare/move` 2 ms, the claim 5, the build callback 10 to 12, Update now 1 (4 in the
State object), a generation 7.

## 7. Updates

- **Worker and Modal app:** the Worker's cron checks the latest GitHub release against its own
  version. On a new one it starts a Workers Build. The template's deploy command is a stub that
  downloads the release's `deploy.sh`, so the user's copy never goes stale and there is no fork
  sync. One build updates both the Worker and the Modal app. Packs, tool descriptions and workflow
  templates ship with the code: a new pack is a release.
- **Update now:** the Worker page's header, beside the version, has the update button when a
  newer release is out (on every tab and setup step). It opens a panel with the release, its
  notes and **Update now**, which starts the same build at once (`POST /api/update`) without
  waiting for the daily check; the panel then shows its log. The header follows the build
  (`GET /api/update`: `building`, and once stopped the `outcome` Cloudflare gave): **Updating…**,
  then **Reload for vX** or **Update failed** (the panel offers Try again and the log). The
  version's tooltip says when it is the latest; a development build says it doesn't update.
  For the first minutes after a release, GitHub's caches don't all agree, so a reload could hide
  the button again (2026-10-13). The Worker therefore keeps offering a release it has seen for an
  hour (`latest_seen` in the setup state, `updates.steadyLatest`), even when a later answer is
  older.
- **A Worker made by the setup Worker** uploads the release itself instead (§6, "Setup without a
  repository"), in its State object, then redeploys Modal from a Sandbox with the same release:
  Update now answers once the new version is live (seconds), and the header offers **Reload for
  vX**. `GET /api/update` answers both paths in one shape: `path`, `blocked` (why it
  can't update: no token, connection lost) and `failed` (the last attempt's reason).
- **An install made from a repository** offers **Move to the new setup** (§6) and from then on
  updates itself as above; the build path stays only until those installs have moved.
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
| Modal token pair | Build secrets (made from a repository); Worker state (`modal_token`) and the workspace Secret `comfy-gen-token` (made by the setup site) | `modal deploy` in the build, or in the Worker's Modal Sandbox |
| Modal sign-in | Worker state (`modal_flow`: flow id, wait secret) | Connect Modal's pending approval (15 min) |
| Modal proxy token | Worker state, Modal Dict | Calls to the ComfyUI server and admin endpoint |
| Ref HMAC key | Worker state | Signs upload tokens and storage links |
| Agent pairing secret | Worker state, `agent.json` | Authenticates the relay: the agent's `Authorization: Bearer`, checked before the WebSocket upgrade. It travels in the pairing link's fragment, which browsers do not send |
| Build nonce | Build secrets, Worker state | One-time callback from the build |
| LoRA upload session id | Worker state (`lora_uploads`), the settings page or the agent | Names one R2 multipart upload; the settings page's cookie or the agent's pairing secret is still required (24 h) |
| Storage link | Modal, the agent | `/store/<token>`: reads one stored object, the token signed with the HMAC key (6 h) |
| Image id | Chats | 8 random base62 characters: the image in R2, read by `/img/<id>` and `edit_image` (a year) |
| Image key | Worker state (`image_key`) | AES-256 key for images stored encrypted (§4); made once, never changed |
| Cloudflare OAuth tokens | Worker state (`cf_oauth`); the setup Worker's sealed cookie until creation | A Worker made by the setup Worker updates itself and checks R2 with them (§6). Access 1 h, refresh rotating |
| `CLAIM` | the Worker's secret binding | One-time hand-off from the setup Worker; random per Worker, never re-sent by uploads |
| Login ticket, reconnect code | Worker state (hashed) | One use: the setup site's login link (10 min), Reconnect Cloudflare (15 min) |
| `COOKIE_KEY` | the setup Worker's secret | Seals its sign-in cookies (AES-GCM) |

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
the rest of it (`setup.login_fails`), while the token login stays open. Only Workers made from a
repository have one now: on the new setup, Cloudflare is the login (below).

**Log in with Cloudflare** (the new setup, v2.1.0). The login page's button asks the Worker for a
one-use code (`POST /api/login/cloudflare`, no session needed) and goes to the setup site's
`/login`, which is Reconnect's sign-in: Cloudflare's consent, the check that the Worker is in an
account the sign-in reaches, the claim with the code and the new tokens, then `#ticket=` back on
the Worker. So it proves what the token login proves (control of the Worker's account), with no
token to make, and every login also brings new tokens (a lost connection comes back with it).
Starting one needs no session, since only a sign-in to the Worker's account can finish it; the last
five codes stay valid (15 minutes each), so someone starting logins can't cancel the owner's. The
claim deletes a password left from before a move, and the new setup can't set one. The pasted token
stays as the way in when the setup site can't be reached.
Seen live (2026-10-18): each login shows Cloudflare's full consent screen again, and the user's
connected applications list Comfy-Gen once however many times they sign in, so the replaced tokens
aren't revoked (one grant; revoking an old refresh token could cut the new one off). Other
sign-ins don't end a Worker's tokens either: the moved `comfy-gen`'s refresh token from 00:41 still
renewed at 01:52, after two sign-ins for another Worker, for its update to v2.1.0.

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

## 9. Relay (PC GPUs)

- A Durable Object per PC is the rendezvous, named after its GPU id (§2, "GPUs"). A Worker has no
  memory between requests, so the waiting `tools/call` and the agent need a shared addressable
  object to meet in.
- The agent holds an outbound WebSocket, accepted with the hibernation API; `ping`/`pong` text
  frames are answered by the runtime without waking the object. A `tools/call` sends a request down
  the socket and awaits the reply with the same id. Round trip Worker to agent and back: 19 to 37 ms
  (S6). An idle connection costs nothing measurable; drops come every few minutes to few hours, so
  the agent reconnects at once and the Worker waits briefly for it (S6).
- The Durable Object and its migration are declared in the bootstrap template from the first
  release, so adding the PC path later needs no template change.

**As built (M6; one per PC since the GPU list).** Each PC has its own pairing secret. `GET /agent`
finds the PC whose secret the bearer matches (401 without one, so the agent can tell "unpaired"
from "not a WebSocket", 426), then forwards the upgrade to that PC's `Relay` object. A new
connection replaces the old (close 4000: "another agent connected"); unpairing or a new pairing
link closes it with 4001. After either, or a 401, the agent retries only every 5 minutes, and at
once when it is given a new link.

Which socket the `Relay` sends on (`liveSocket`, fixed 2026-10-07): the newest open one that still
pings. `getWebSockets()` has no order, and a socket closed this side stays listed until the other
end answers the close, which an agent that vanished in a network outage never does; picking "the
last one" sent on that dead socket ("Can't call WebSocket send() after close()") for every call,
across agent restarts. An open socket with no ping for 60 s (three missed; the runtime records the
last one auto-answered) is closed as gone, so the PC reads offline and calls go to the next GPU;
requests waiting on a closed socket fail at once. A send that throws is tried once more on a fresh
socket. The agent, for its part, drops a connection that has sent it nothing for 60 s and reconnects:
a network outage can leave its socket looking open for many minutes.

The protocol (`core/relay.ts`, shared by both ends): a message is a JSON header in a text frame,
followed by its body in binary frames of at most 1 MiB, the header saying how many. Each side sends
a header and its chunks in one synchronous run, so messages never interleave.

| Message | Direction | Carries |
|---|---|---|
| `http` | Worker → agent | One ComfyUI request (method, path, params, headers, body); the agent calls its ComfyUI inside a job, so the idle stop waits |
| `control` | Worker → agent | An agent operation: `pause` (`{paused}`, from the Setup page), `ensure` (start ComfyUI, install the pack's nodes, check or start its model downloads), `loras` (its files and the LoRA copies in progress), `models`, `download`, `sync` (start a LoRA sync), `lora_delete`, `status` |
| `reply` | agent → Worker | `{id, status}` and the body |
| `hello` | agent → Worker | On connecting, and again when paused or resumed: version, platform, GPU, ComfyUI state, `paused`, and what this agent's ComfyUI can do (`remove_marks`, `remove_background`, `redraw`, `cutout`, `redraw_area`, `inpaint_control`, `redraw_extend`; `update_now` when its shim can update it on request; and `installing` while ComfyUI is installed; each absent on an agent from before it, so the Worker leaves that step out or says the agent needs updating); the latest is kept with the socket for the settings page |

On the Worker, `RelayTransport` is core's `Transport` over the object's `request()`, so the
ComfyUI client, held waits and the brain are unchanged. A call with no agent connected waits 10 s
for a reconnect, then fails with "<name> is offline"; one whose agent drops mid-call fails with
"the connection to your PC dropped". Timeouts: 120 s for a ComfyUI request (a held wait is 50 s),
30 s for control, 100 s for `ensure` (past it the call says ComfyUI is still starting on that PC,
and the agent carries on for the next call). The GPU is chosen per call from the list (§2, "GPUs"); an
image to edit comes from R2 (§4), whichever GPU made it.

Measured on the test install (appendix, "M6 live"): a warm relayed generation costs the Worker a
median 10 ms of CPU (8 to 19, as on the Modal path) and the Relay object 0 to 3 ms; a 3 MB image
crosses in 1 s each way. Durable Object duration cannot outgrow the free plan: one object billed at
128 MB, active around the clock, is 10,800 GB-s a day of the 13,000 allowed, and a hibernating
socket is not active. Requests: about 10 per generation, against 100,000 a day.

**Images while ComfyUI is stopped.** The idle stop ends ComfyUI after keep-warm, and before R2 a
PC image's link and edits by `image_id` read it back through `/view` (now they read R2; this stays
for a result fetched late). The agent answers such a `/view` from
ComfyUI's output, input or temp folder on disk (confined to them) without starting ComfyUI; the
`preview` parameter is ignored and the original sent.

**Ending with the launcher.** On Windows, ending a process leaves its children running, so ending
the launcher left Node, the tray and ComfyUI behind. The launcher passes its pid
(`COMFY_GEN_LAUNCHER_PID`; older launchers are the parent process, which is the same), and the
agent checks it every 5 s: once it is gone, the agent stops ComfyUI and exits.

**Pause.** The agent's tray has "Pause agent" ("Resume agent" while paused), and the Worker's Setup page has
Pause and Resume on each PC in its GPU list (usable from a phone), sent to the agent
as a `pause` control op over its connection: the agent has no inbound port. Both set the same flag
in the agent, which then sends a hello with `paused: true`; the tray re-reads the flag every 2 s and
the page reads the hello, so they agree whichever changed it. The Worker then treats the PC as not
there: the next GPU in the list answers, or, with none, the tools say the PC is paused. The pause is not
saved, and both places say so: a restart takes requests again, so a forgotten pause cannot send
every image to Modal for days.

The agent (`packages/agent`) reconnects at once after a drop, then backs off (1 s to 60 s),
resetting after a connection that lasted a minute; it pings every 20 s, answered by the runtime,
and reconnects when 60 s pass with no answer.
Its settings page (loopback only) is the MCPB's machine setup plus the pairing section; pack
settings stay on the Worker, whose settings page lists each GPU's LoRAs and model status
(`/api/loras`, `/api/models`).

**A page per PC (2026-10-12; replaces "One settings page", 2026-10-02).** Each paired PC has its
own page on the Worker, `/gpu/<id>`: the agent's own settings page, all of it, relayed. The GPU
list (Settings, GPUs) links to it with **Open its page** (a new tab). The agent's tray opens the
Worker's Settings while connected, where most settings are (2026-10-15; until then it opened this
page, its id from `GET /agent/whoami`, which stays for agents from before). The Worker serves the app on
that path (the `ASSETS` binding, `/gpu/*` run first) after checking the id when logged in: Modal
goes to the GPU list, an unknown id is a 404, and a logged-out visitor gets the
login whatever the id. On that path the app (`api.js`) sends every call to
`/api/gpus/<id>/machine/…`, which the Worker relays as a `machine` control op, path, query and a
JSON body as text, unparsed; binary bodies (the agent page's own LoRA uploads) get 415, since LoRAs
come in on the Worker's page and are synced. The page shows everything the agent's page has,
its models folder included, except pairing and the buttons that open a folder on
the PC's screen; an offline PC shows as such, with a retry every 10 s.

The 2026-10-02 allow-list (the agent let the Worker read its state, install, start and stop, and
nothing else, "as the PC is where remote reach must stop") is gone, because it guarded nothing:
every `ensure` carries the pack's `required_nodes`, which the agent installs from the Comfy
Registry, so whoever controls the Worker already runs code on the PC. Since v2.2.2 a machine
installs only the node packages Comfy-Gen's own shipped packs list (`knownNodePackages`, today
ComfyUI-GGUF alone): a pack needing a new one ships with the release that adds it, and an older
agent says to update. Pairing alone stays on the
PC (the agent answers 403 to `/pair` from the relay, whatever the method or path spelling): it is
what makes the Worker trusted, so it is only done there. The
agent's answer to a settings save no longer echoes its config file (the pairing secret was in it).
The extension, which has no Worker, keeps its local page as it is.

**Several agents on one machine (a developer switch).** `COMFY_GEN_AGENT_INSTANCE=2` (to 9) in the
launcher's environment starts another agent, for testing a Worker with several PCs on one computer.
It keeps its own config (pairing), logs and ComfyUI output, input, temp and user folders in
`~/.comfy-gen-mcp/instances/<n>/`, takes settings port 9248 + n - 1, and runs its own ComfyUI process
from the shared install, with the shared models and LoRAs. Downloads write `.part-<n>` files, so two
agents fetching the same file never share one. Two ComfyUIs share the GPU's memory, and both may
install a pack's nodes at once on a first run, so set packs up on the first agent before starting a
second.

**LoRA sync.** Every LoRA in R2 should be on every PC. The agent posts its LoRA files (`{name: size}`,
ours only) to `POST /agent/sync` (the pairing secret, as for `/agent`); the Worker answers with a
plan: every stored LoRA the PC lacks is **pulled** (a storage link, downloaded with Range so a cut
transfer resumes); one of the PC's that R2 lacks (uploaded before R2) is **pushed** (an upload to
`/agent/loras/uploads`, the same protocol as the settings page, with the pairing secret, each chunk
checked against R2's MD5); and one deleted while the PC was offline is **deleted** there. At most
20 copies per plan; the agent asks again after a round that copied something. It syncs on each
connection and when the Worker sends `sync` (after an upload, a settings save, or the page's
request); copies in progress show on the settings page.

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
| `setup` | the setup Worker: Cloudflare sign-in, creating the user's Worker (§6) | Workers (our account) |
| `site` | the setup site, served by `setup`; `guide/` also on GitHub Pages | browser |
| `bootstrap` | what the Deploy button copies: wrangler config and `package.json` with the deploy stub | Workers Builds |

`core` exports its TypeScript source directly (no build step): wrangler bundles it into the Worker,
and the MCPB and agent bundle it with esbuild (`packages/mcpb/build.mjs` builds the one bundle and
the shim the launcher embeds).

A release is ten files: `deploy.sh`, `comfy-gen.mjs`, the tray helpers' archive and the Worker
bundle's three files (§6), which installs download on their own, and the `.mcpb` and three
launchers, which people download; the notes open with a download table
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
| R2 or KV for image storage | The generator already holds the files; R2 needs a card on file. **Reversed 2026-10-01**: storage that outlives every GPU (links with the PC off, edits across GPUs, a LoRA hub for several PCs) is worth a card on file; R2's free tier stays free |
| Durable Object storage for images and LoRAs (2026-10-01) | No card, but 5 GB per account, 1 GB per object and 2 MB per value on the free plan, and only reachable through the Worker: fine for WebP images, poor for LoRAs of hundreds of MB |
| Full-size PNGs in storage (2026-10-01) | Every edit goes through the model's VAE, which loses far more than WebP at quality 90; ComfyUI's PNG stays on the GPU's disk. The `:lossless` switch dates from JPEG results (no transparency) and goes |
| Two fixed generators, "main" (Modal or a URL) and "pc" (2026-10-01) | One PC at most, a fixed preference, and a `fetch_result` token that misrouted when the PC dropped. One list in priority order (§2, "GPUs") takes any number of PCs, and each token names its GPU |
| QoL or settings-page uploads | The model would not know which reference to use; the sandbox upload keeps it in context |
| Workers KV for the Worker's state | Reads are cached at the edge for up to a minute: after a save, reads alternated between old and new values for about 60 s, and a read-modify-write could undo a recent write. A SQLite Durable Object is consistent and on the free plan |
| Hot pack manifest in KV | A second update path; a release build takes about 2 minutes and runs automatically |
| Fork-sync GitHub Action | More code; the token-driven build covers updates |
| Qt desktop app | Settings moved to the web; the PC side is a daemon with a small tray |
| Cold/warm status in results | A blocking call fits inside the client timeout |
| Modal Sandboxes over gRPC | Outbound gRPC from Workers is private beta, browsers cannot reach Modal's API (no CORS, no gRPC-web), and Sandboxes would make us own lifecycle and an undocumented protocol. **Reconsidered 2026-10-17**: deferred, not rejected. A Sandbox that runs the real `modal deploy` is the one piece a setup without a repository lacks; it waits for Workers gRPC to reach general availability, and keeps the call surface small (§6, Sign-in) |
| Worker uploading over its own script | Replaced by Workers Builds, which also updates Modal. Back in the direction of 2026-10-17 (§6, Sign-in): with Cloudflare OAuth the Worker could update itself, once Modal deploys no longer need the build |
| An automatic upload route for images pasted into Claude Desktop (MCPB) | The sandbox trick needs a public endpoint, and the extension is on `127.0.0.1`. A clipboard route (the model asks the user to copy the image, then passes `"clipboard"`) was built and removed: too much machinery for the gain. What remains is opt-in, and costs no code: the `edit_image` description offers a file path, or an upload to Litterbox (catbox's temporary host) for one hour, only after the user agrees to the image being public for that hour; the returned URL goes to `edit_image` like any URL. It needs code execution with network access to `litterbox.catbox.moe`. Tested 2026-09-30: one POST, the URL serves the same bytes to the extension's fetch |
| A PC's settings reachable from the Worker only through an allow-list (2026-10-02) | Guarded nothing: the Worker can already run code on the PC through each pack's `required_nodes`. Every setting is now on the PC's own page on the Worker; only pairing stays on the PC (§9, "A page per PC") |
| The negative prompt against painted-in signatures (2026-10-15) | Didn't stop them on base Anima, and Anima Turbo skips the negative at CFG 1 |
| Repainting a mark with the image's own model, or ready-made node packs (2026-10-15) | A diffusion inpaint per image costs seconds of GPU and loads another graph. The marks sit on flat colour near the corners, which LaMa fills well. Acly's LaMa node resizes the whole image to 512 and blurred it; Impact Pack's detailers were more machinery than one detector and one fill. Our own node crops each mark at full resolution |
| `edit_image` for touch-ups, and an inpainting control model (2026-10-15) | Flux 2 Klein's edits changed 0.7 to 1% of a sprite's body pixels, lost Frenni's bear muzzle and shifted the style. kohya's Anima LLLite inpainting needed a custom node, and masked denoising on the pack's own graph seemed enough (§3, Redraw). **Reversed 2026-10-17**: the spike showed the control fixes what plain masked denoising got wrong, on both models; its code (Apache-2.0) is copied into our extension and its weights (Anima's licence) ship with the packs (§3, Redraw: the inpainting control) |
| Redrawing a crop around the area (2026-10-15) | With the whole character's prompt the crop got the body the prompt described (a bustier drawn into a face crop); with a prompt for the crop alone, the model lost what the crop didn't show (bare hands on an armoured knight): 2 usable of 12. Redraw samples the whole image with the prompt for all of it, and repaints only the mask (§3, Redraw) |
| Lucida for background removal (v1.16.0 to v1.17.2), and fixes that only cleaned its edge colours (2026-10-16) | A white contour over dark scenes, from a light ring in the images that any soft mask keeps, and enclosed background kept between hair and face; RMBG 2.0 with isnet-anime's gaps, a 2 px shrink and colour cleanup won on all 7 test sprites (§3, Background removal) |
| Seed records keyed by pack name only (to v1.17.3) | Changing a pack's files under the same name kept both records at "done", so Modal never fetched v1.17.3's background models; keys now carry a hash of the files (`seedKey`, §2) |
| A ComfyUI by URL as a GPU, and "Your own ComfyUI" for the agent and the extension (`comfyui_url`); removed 2026-10-15 | Every feature since the wait route needs our ComfyUI extension (the held wait, watermark removal; background removal needs our model folders), and each had to say "except there". What people wanted from their own ComfyUI, its models, the managed install already uses (other installs' folders are found and shared, §5). A stored URL GPU is left out of the list; a stored `comfyui_url` is dropped when the config loads, and the managed ComfyUI takes over |
| A Python Worker running the Modal SDK (2026-10-17) | The SDK needs raw sockets for HTTP/2 gRPC (`grpclib`); a Python Worker reaches the network only through `fetch`, and the gRPC beta gives Workers gRPC-web over `fetch`, not sockets. Pyodide's per-request cost (above) with the SDK's imports would also break the free plan's CPU limit. The admin app on Modal already runs the SDK (§6, Sign-in) |
| Cloudflare Containers for the Modal SDK, or for a setup without a repository (2026-10-17) | They run Python natively, but need the paid Workers plan; every user's Cloudflare is the free plan |
| Reimplementing `modal deploy` over gRPC (2026-10-17) | A deploy is the SDK's internals (images, mounts, functions from their Python definitions), which change every release; Modal's JS and Go SDKs leave defining functions to Python. A Sandbox running the real SDK does it with a few calls (§6, Sign-in) |
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
| MCP client timeout | 5 minutes (claude.ai); about 3 from Claude Code through a claude.ai connector | S8, 2026-09-28; test report 2026-10-01 |
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
request, and never mixes outputs. Since 2026-10-11 every call also saves under its own name
(`comfy-gen/<12 hex>`, set on the save nodes by `buildPrompt`), so two ComfyUIs on one Volume can no
longer number into the same file.

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

**R2 and the GPU list live, 2026-10-01.** The test install on the branch, two agents on one Windows
PC (`COMFY_GEN_AGENT_INSTANCE`) plus Modal, driven by a local Claude Code. Worker `cpuTimeMs` from
Workers Logs over the run (27 `/mcp` calls): warm generations median about 18 ms (9 to 27; M6 had
10), a cold Modal edit that waited 211 s 73 ms, a cold Modal call 57 ms; nothing over the limit.
`/img/` 0 to 1 ms, an upload 7 ms, `/store/` 2 to 3 ms, a LoRA chunk 1 to 2 ms, `/agent/sync` median
4 ms, `/api/state` 2, `/api/models` 4, the State and Relay objects 0 to 2 ms. Times: 142 MiB LoRA
upload about 9 s; R2 to a PC 6.5 s, to Modal about 20 s; PC generations 40 to 56 s with ComfyUI
cold, Modal cold 108 to 140 s. Itemized the same day with a throwaway Worker (`comfy-gen-cpuprobe3`, deleted after): the real
`App` on the PC path with canned agent answers, one piece swapped per variant, medians over 15
calls:

| Variant | 2 KB image | 419 KB image |
|---|---|---|
| everything in memory | 2 ms | 11 ms |
| + the relay as a Durable Object (RPC, as live) | 5 ms | 13.5 ms |
| + the real State object | | 17 ms |
| + the real R2 put | 7 ms | 16 ms |

(The probe re-read and re-sent each response, which inflates the image column a little.) So no
regression: the image (about 5 ms for 400 KB, as on the Modal path on 2026-09-28), five relay calls
(status, ensure, prompt, wait, view: about 3 ms) and the State reads (about 3.5 ms; the 30 s cache
misses when generations are 40 s apart) add up, R2 costs nothing measurable, and platform variance
does the rest. M6's 10 ms was a two-node workflow with a tiny image, not a like-for-like baseline.
The one cut taken: the readiness bookkeeping no longer re-reads the settings when nothing changed.

**R2 through the Worker, 2026-10-01: effectively free.** A throwaway Worker (`comfy-gen-r2probe`,
deleted after) with an R2 binding, median billed `cpuTimeMs`: a 500 KB `put` from memory 1 ms; a
20 MB request body streamed into `put` 1 ms (Content-Length is enough, no `FixedLengthStream`); an
8 MiB multipart part 1 ms (about 0.6 s wall); a 200 MB object streamed out, whole or with a Range
(206), 0 ms and 4.5 to 6 s wall, with no response size cap. So bytes go through the Worker, with
no S3 keys or presigned URLs. Also seen: `wrangler deploy` (4.143) creates a missing `bucket_name`
bucket on its own; `wrangler r2 bucket lifecycle add` fails on a second run, `lifecycle set
--file` is idempotent; `put(key, body, {sha256})` is checked by R2; a multipart part's ETag is its
MD5, so an uploader can check each chunk itself.
