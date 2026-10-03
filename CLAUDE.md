# comfyui-gen-mcp

Rewrite of Comfy-Gen-MCP. `docs/design.md` is the source of truth; read it before changing
architecture, and update it when a decision changes. `docs/build-plan.md` is the build order.

## Hard rules

- **Never create a GitHub repository named `comfy-dxt` or `comfy-gen-mcp`** under lugia19. Installed
  copies of the old version self-update by pulling `github.com/lugia19/comfy-dxt.git`, which GitHub
  redirects to `comfy-gen-mcp`; a new repository with either name would capture that update channel.
  Never delete the old repository while installs exist; archiving is fine.
- `packages/core` (TypeScript) uses Web-platform APIs only: `fetch`, `crypto.subtle`, `TextEncoder`,
  `Uint8Array`, `structuredClone`. No `Buffer`, no `node:` imports in `src/` (tests may use them). It
  runs in the Worker and, later, in the Node MCPB and agent. I/O goes through the `Transport`
  interface.
- Stored formats are compatibility surfaces: upload tokens and storage links (`refs.ts`), session
  cookies (`auth.ts`), the State Durable Object's keys and JSON values, and R2 keys (`img/<id>`,
  `lora/<name>`). `test/golden.json` pins the tokens; change any of them only with a migration.
- The MCPB and the agent share one machine-side package (M5). Don't fork that logic between them.
- Any code that calls a Worker from outside (build callbacks, the upload snippet, the agent) sets its
  own `User-Agent`. Cloudflare rejects urllib's default `Python-urllib/x.y` with Error 1010 before
  the Worker runs, and `wrangler dev` does not reproduce this.

## Worker CPU budget

The Worker runs on the free plan: 10 ms CPU per request, with some tolerance for occasional
overruns. Measured (design doc appendix): ping, tools/list and the settings API cost 1 to 2 ms; a
warm generation about 6 ms of work (billed 5 to 18 per call), cold 17 to 19; on the PC path about
12 to 15 (image, five relay calls and the State reads; 2026-10-01 probe). A fetch costs about 0.25 ms, a Durable Object call 0.4;
JavaScript loops over image bytes cost the most (base64 by hand was 55 ms per MB). So:

- base64 through `bytes.ts` `toBase64` (native `Uint8Array.toBase64` where available); never loop
  over image bytes in JS
- keep fetches per request low: waits go through `/comfy-gen/wait` where the generator has it
- no heavy dependencies on the request path; request-independent data is built at module scope
- plain data only at module scope (no stubs, `env` or I/O objects: they are request-bound)
- image bytes are base64'd, never decoded

Measure with Workers Logs `cpuTimeMs` when a change could move it (the appendix has the method).

## Layout

- npm workspaces: `packages/core` (`@comfy-gen/core`, TS source exported directly, no build step),
  `packages/worker` (the Cloudflare Worker, wrangler), `packages/local` (the machine side the MCPB
  and the agent share: config, ComfyUI install and lifecycle with uv, downloads; Node APIs),
  `packages/mcpb` (the Claude Desktop extension: shim, bind-or-relay entry, local server, tray;
  `node packages/mcpb/build.mjs [tag]` builds `comfy-gen.mjs`, the one bundle holding the server
  and the agent, the shim and the `.mcpb`), `packages/agent` (the PC agent: relay client and its
  settings routes over `local`), `packages/launcher` (Go, not a workspace: the agent's
  launcher; `node packages/launcher/build.mjs [tag]` after the MCPB build, `go test ./...` in its
  folder) and `packages/tray` (Go, not a workspace: the tray helper on fyne.io/systray;
  `node packages/tray/build.mjs` (the helpers, packed into `comfy-gen-tray.tgz`) before a release
  MCPB build, which pins their hashes; the macOS one needs cgo, so only a Mac builds it). `web/`
  (Svelte settings app) stays outside, with its own lockfile; its built `web/dist` is committed.
- Python that remains, as a uv workspace: `packages/modal_app` (runs on Modal and in the Workers
  Build). The build step `packages/worker/deploy/deploy.{sh,py}` is stdlib Python and must stay at
  that path: published `deploy.sh` releases call it there.

## Tests

- `npm run typecheck` and `npm test` (vitest) from the repository root; `go vet ./... && go test
  ./...` in `packages/launcher` and `packages/tray`.
- `uv run pytest` for the Modal app and the build step (CI runs Python 3.12 and 3.14).
- `python3 scripts/check_pack_models.py` checks pack sizes and hashes against Hugging Face.
- Local end to end: `npx wrangler dev` in `packages/worker` (with `.dev.vars` from the example), a
  ComfyUI on localhost as the direct generator.
