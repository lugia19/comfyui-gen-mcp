# Comfy-Gen-MCP

Image generation for Claude through ComfyUI, wherever the GPU is:

- **No GPU:** a free Cloudflare Worker drives ComfyUI on Modal. Set up from the browser.
- **Your own GPU, from claude.ai or mobile:** the same Worker reaches your PC through a small agent,
  so no tunnel or reverse proxy.
- **Claude Desktop only:** an MCPB extension runs everything locally, no accounts.

Setup starts at the [project page](site/index.html); downloads are on the
[latest release](https://github.com/lugia19/comfyui-gen-mcp/releases/latest). See
[`docs/design.md`](docs/design.md) for the design and [`docs/build-plan.md`](docs/build-plan.md)
for what is built. The previous version lives in
[`lugia19/comfy-gen-mcp`](https://github.com/lugia19/comfy-gen-mcp).
