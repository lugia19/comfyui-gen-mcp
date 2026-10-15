# Comfy-Gen-MCP
Do you just want to install this? Follow this guide: https://lugia19.github.io/comfyui-gen-mcp/

Image generation for Claude through ComfyUI, wherever the GPU is:

- **No GPU:** a free Cloudflare Worker drives ComfyUI on Modal. Set up from the browser.
- **Your own GPU, from claude.ai or mobile:** the same Worker reaches your PC through a small agent,
  so no tunnel or reverse proxy.
- **Claude Desktop only:** an MCPB extension runs everything locally, no accounts.

**Your prompts and images never pass through anything I run.** They go straight to accounts you
own: your Cloudflare Worker and R2 bucket, your Modal account, or your own PC (the extension runs
entirely on it). The setup page is a static page that sends nothing anywhere. The only other
places Comfy-Gen contacts are GitHub (releases and update checks), Hugging Face (model files) and
the ComfyUI registry (custom nodes), and none of those see your prompts or images. One exception,
opt-in: to edit an image you pasted into Claude Desktop, Claude can offer to put it on Litterbox,
a public host, for an hour, and only does so if you say yes.

## Setup

**Open the setup page: <https://lugia19.github.io/comfyui-gen-mcp/>.** It asks how you'll use
Comfy-Gen and where images should be made, then walks you through the rest with screenshots.

What each path looks like:

- **claude.ai, mobile, or Claude Desktop through the Worker** (cloud, your PC, or both): you need a
  GitHub and a Cloudflare account, plus a [Modal](https://modal.com) account for cloud generation.
  The page's **Deploy to Cloudflare** button creates your Worker; once the build finishes, open
  `https://comfy-gen.<your-subdomain>.workers.dev` and finish setup there (models, Modal, the PC
  agent, connecting Claude).
- **Claude Desktop only, on your own GPU:** download
  [`Comfy-Gen-MCP.mcpb`](https://github.com/lugia19/comfyui-gen-mcp/releases/latest/download/Comfy-Gen-MCP.mcpb)
  and open it with Claude Desktop. The extension installs ComfyUI and the models itself.

Other downloads are on the [latest release](https://github.com/lugia19/comfyui-gen-mcp/releases/latest).

## Development

See [`docs/design.md`](docs/design.md) for the design and [`docs/build-plan.md`](docs/build-plan.md)
for what is built; [`CLAUDE.md`](CLAUDE.md) covers the layout and tests. The previous version lives
in [`lugia19/comfy-gen-mcp`](https://github.com/lugia19/comfy-gen-mcp).
