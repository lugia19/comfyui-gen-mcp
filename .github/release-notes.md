## Downloads

| You want | Download |
|---|---|
| Claude Desktop only, everything on this PC | [Comfy-Gen-MCP.mcpb](https://github.com/lugia19/comfyui-gen-mcp/releases/download/__TAG__/Comfy-Gen-MCP.mcpb): open it to install it in Claude Desktop |
| claude.ai and mobile, generating on your PC | The agent for [Windows](https://github.com/lugia19/comfyui-gen-mcp/releases/download/__TAG__/comfy-gen-agent-windows.exe), [macOS (Apple silicon)](https://github.com/lugia19/comfyui-gen-mcp/releases/download/__TAG__/comfy-gen-agent-macos.zip) or [Linux](https://github.com/lugia19/comfyui-gen-mcp/releases/download/__TAG__/comfy-gen-agent-linux), with a Worker ([setup](https://github.com/lugia19/comfyui-gen-mcp#readme)) |
| claude.ai and mobile, no GPU | Nothing to download: deploy the Worker ([setup](https://github.com/lugia19/comfyui-gen-mcp#readme)) |

The agent is not signed yet. Windows: **More info → Run anyway**. macOS: unzip and open it; macOS refuses it the first time, so then choose **Open Anyway** in System Settings → Privacy & Security (once). Linux: `chmod +x comfy-gen-agent-linux` first. Its tray icon shows on KDE, Ubuntu, Cinnamon, XFCE and most desktops; plain GNOME (Fedora, Debian) needs the AppIndicator extension for it.

Installs update themselves; `deploy.sh`, `comfy-gen.mjs` and the `comfy-gen-tray-*` helpers are what they download.
