# comfyui-gen-mcp

Rewrite of Comfy-Gen-MCP. `docs/design.md` is the source of truth; read it before changing
architecture, and update it when a decision changes.

## Hard rules

- **Never create a GitHub repository named `comfy-dxt` or `comfy-gen-mcp`** under lugia19. Installed
  copies of the old version self-update by pulling `github.com/lugia19/comfy-dxt.git`, which GitHub
  redirects to `comfy-gen-mcp`; a new repository with either name would capture that update channel.
  Never delete the old repository while installs exist; archiving is fine.
- `packages/core` must stay importable under Pyodide (the Cloudflare Python Worker): no Pillow, no
  threads, no subprocess, no websockets, no filesystem paths beyond `importlib.resources`. I/O goes
  through the `Transport` protocol.
- The MCPB and the agent share `packages/local`. Don't fork machine-side logic between them.

## Layout

uv workspace. `packages/*` are the product (see the design doc's Repository section); `spikes/` is
throwaway infrastructure tests, deleted once their results are recorded in the design doc.

## Tests

- `uv run pytest` from the repository root.
- Tests use pytest with anyio (`pytestmark = pytest.mark.anyio`), not pytest-asyncio.
