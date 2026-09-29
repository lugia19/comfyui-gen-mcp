// Where the local install keeps its files: the old extension's folder, so an upgrade keeps its
// config, its ComfyUI and its models.

import { homedir } from "node:os";
import { join } from "node:path";

export type Paths = {
  home: string;
  config: string; // local_config.json
  logs: string;
  comfyui: string; // the managed ComfyUI workspace
  cli: string; // the venv holding comfy-cli
  bin: string; // uv
  app: string; // server bundles, one folder per release tag
  oldRuntimeVenv: string; // the old launcher's venv; older installs put torch there
};

/** COMFY_GEN_HOME moves everything (tests, a second install); COMFY_CONFIG_PATH only the config,
 * as in the old extension. */
export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.COMFY_GEN_HOME || join(homedir(), ".comfy-gen-mcp");
  return {
    home,
    config: env.COMFY_CONFIG_PATH || join(home, "local_config.json"),
    logs: join(home, "logs"),
    comfyui: join(home, "comfyui"),
    cli: join(home, "cli"),
    bin: join(home, "bin"),
    app: join(home, "app"),
    oldRuntimeVenv: join(home, "runtime", "venv"),
  };
}

/** A venv's interpreter or console script. */
export function venvBin(venv: string, name: string): string {
  return process.platform === "win32" ? join(venv, "Scripts", `${name}.exe`) : join(venv, "bin", name);
}
