# Comfy-Gen-MCP
Do you just want to install this? Start here: https://comfy-setup.lugia19.com/

Image generation for Claude through ComfyUI, wherever the GPU is:

- **No GPU:** a free Cloudflare Worker drives ComfyUI on Modal. Set up from the browser.
- **Your own GPU, from claude.ai or mobile:** the same Worker reaches your PC through a small agent,
  so no tunnel or reverse proxy.
- **Claude Desktop only:** an MCPB extension runs everything locally, no accounts.

**Your prompts and images never pass through anything I run.** They go straight to accounts you
own: your Cloudflare Worker and R2 bucket, your Modal account, or your own PC (the extension runs
entirely on it). The setup page signs in to Cloudflare to create your Worker and hands that access
to it, keeping nothing ([privacy](https://comfy-setup.lugia19.com/privacy)); your Worker reaches
Modal's API for setup and updates through a relay I run, which passes the calls through and stores
nothing. The only other places Comfy-Gen contacts are GitHub (releases and update checks), Hugging
Face (model files) and the ComfyUI registry (custom nodes), and none of those see your prompts or
images. One exception,
opt-in: to edit an image you pasted into Claude Desktop, Claude can offer to put it on Litterbox,
a public host, for an hour, and only does so if you say yes.

## Setup

**Open the setup page: <https://comfy-setup.lugia19.com/>.** It asks how you'll use Comfy-Gen and
where images should be made, then walks you through the rest with screenshots.

What each path looks like:

- **claude.ai, mobile, or Claude Desktop through the Worker** (cloud, your PC, or both): you need a
  Cloudflare account, plus a [Modal](https://modal.com) account for cloud generation. The page's
  **Connect Cloudflare** creates your Worker in your account; open it and finish setup there
  (Modal, models, the PC agent, connecting Claude). It updates itself.
- **Already set up from a GitHub copy (before v2.0.0)?** Your Worker's page offers **Move to the
  new setup**: it keeps your address, connector, images and settings, and from then on updates
  itself. The GitHub copy can be deleted afterwards.
- **Claude Desktop only, on your own GPU:** download
  [`Comfy-Gen-MCP.mcpb`](https://github.com/lugia19/comfyui-gen-mcp/releases/latest/download/Comfy-Gen-MCP.mcpb)
  and open it with Claude Desktop. The extension installs ComfyUI and the models itself.

Other downloads are on the [latest release](https://github.com/lugia19/comfyui-gen-mcp/releases/latest).

## Development

See [`docs/design.md`](docs/design.md) for the design and [`docs/build-plan.md`](docs/build-plan.md)
for what is built; [`CLAUDE.md`](CLAUDE.md) covers the layout and tests. The previous version lives
in [`lugia19/comfy-gen-mcp`](https://github.com/lugia19/comfy-gen-mcp).
