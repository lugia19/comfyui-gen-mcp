# comfyui-gen-mcp

Rewrite of Comfy-Gen-MCP. `docs/design.md` is the source of truth; read it before changing
architecture, and update it when a decision changes. `docs/build-plan.md` is the build order.

## Hard rules

- **Never create a GitHub repository named `comfy-dxt` or `comfy-gen-mcp`** under lugia19. Installed
  copies of the old version self-update by pulling `github.com/lugia19/comfy-dxt.git`, which GitHub
  redirects to `comfy-gen-mcp`; a new repository with either name would capture that update channel.
  Never delete the old repository while installs exist; archiving is fine.
- `packages/core` must stay importable under Pyodide (the Cloudflare Python Worker): no Pillow, no
  threads, no subprocess, no websockets, no filesystem paths beyond `importlib.resources`. I/O goes
  through the `Transport` protocol.
- The MCPB and the agent share `packages/local`. Don't fork machine-side logic between them.
- Any Python code that calls a Worker (build callbacks, the upload snippet, the agent) sets its own
  `User-Agent`. Cloudflare rejects urllib's default `Python-urllib/x.y` with Error 1010 before the
  Worker runs, and `wrangler dev` does not reproduce this.

## Worker CPU budget

The Worker runs on the free plan (10 ms CPU per request nominal; a bare Python request already
costs about 3 ms, 10 to 20 ms on a fresh isolate). In Worker code and in anything `core` runs per
request:

- no heavy imports: nothing pydantic-based, no MCP SDK
- compute or serialize anything request-independent at import time (it lands in the deploy-time
  snapshot); never at request time
- no logging on the MCP path
- per call, plain dict work only; image bytes are base64'd, never decoded

Measure with Workers Logs `cpuTimeMs` (see the S1b method in the design doc's appendix) when a change
could move it.

## Layout

- uv workspace (Python 3.12+): `packages/core`, `local`, `mcpb`, `agent`, `modal_app`.
- `packages/worker` is a standalone pywrangler project (Python 3.14), outside the workspace, depending
  on `core` by path with `editable = false`. Keep it out: a workspace forces every member onto the
  intersection of their `requires-python`.
- `web/` is the Svelte settings and setup app; its built `web/dist` is committed.
- `spikes/` is throwaway infrastructure tests, deleted once S6 is recorded in the design doc.

## Tests

- `uv run pytest` from the repository root (CI runs Python 3.12 and 3.14).
- `node scripts/test_pyodide.mjs` runs `core`'s tests under Pyodide.
- Tests use pytest with anyio (`pytestmark = pytest.mark.anyio`), not pytest-asyncio.
