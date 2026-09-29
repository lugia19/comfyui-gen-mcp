// Where the local install keeps its files. The folder is the old extension's, so its ComfyUI
// models are kept; its config file (local_config.json) is not read.

import { homedir } from "node:os";
import { join } from "node:path";

export type Paths = {
  home: string;
  config: string; // config.json
  logs: string;
  comfyui: string; // the managed ComfyUI workspace
  cli: string; // the venv holding comfy-cli
  bin: string; // uv
  app: string; // server bundles, one folder per release tag
};

/** COMFY_GEN_HOME moves everything (tests, a second install). */
export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.COMFY_GEN_HOME || join(homedir(), ".comfy-gen-mcp");
  return {
    home,
    config: join(home, "config.json"),
    logs: join(home, "logs"),
    comfyui: join(home, "comfyui"),
    cli: join(home, "cli"),
    bin: join(home, "bin"),
    app: join(home, "app"),
  };
}

/** A venv's interpreter or console script. */
export function venvBin(venv: string, name: string): string {
  return process.platform === "win32" ? join(venv, "Scripts", `${name}.exe`) : join(venv, "bin", name);
}
