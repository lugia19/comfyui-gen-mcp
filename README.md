# Comfy-Gen-MCP

Image generation for Claude through ComfyUI, wherever the GPU is:

- **No GPU:** a free Cloudflare Worker drives ComfyUI on Modal. Set up from the browser.
- **Your own GPU, from claude.ai or mobile:** the same Worker reaches your PC through a small agent,
  so no tunnel or reverse proxy.
- **Claude Desktop only:** an MCPB extension runs everything locally, no accounts.

This repository is the rewrite. It is not usable yet; see [`docs/design.md`](docs/design.md) for
the design and [`spikes/`](spikes/) for the infrastructure tests being run first. The current,
working version lives in [`lugia19/comfy-gen-mcp`](https://github.com/lugia19/comfy-gen-mcp).
