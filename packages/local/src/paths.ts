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
  /** Another agent on this machine (agentInstance, a developer switch): its folder holds its own
   * config, logs and ComfyUI output; the ComfyUI install, models and LoRAs are shared. */
  instance?: { n: number; dir: string };
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

/**
 * COMFY_GEN_AGENT_INSTANCE=2 to 9, a developer switch: another agent on this machine, to test a
 * Worker with several PCs. Its own pairing, settings port, logs and ComfyUI process (with its own
 * output, input, temp and user folders) in instances/<n>/; the ComfyUI install, models and LoRAs
 * are the first agent's. Two ComfyUIs share the GPU's memory, so test with small models.
 */
export function agentInstance(p: Paths, env: NodeJS.ProcessEnv = process.env): Paths {
  const n = Number(env.COMFY_GEN_AGENT_INSTANCE);
  if (!Number.isInteger(n) || n < 2 || n > 9) return p;
  const dir = join(p.home, "instances", String(n));
  return { ...p, logs: join(dir, "logs"), instance: { n, dir } };
}

/** A venv's interpreter or console script. */
export function venvBin(venv: string, name: string): string {
  return process.platform === "win32" ? join(venv, "Scripts", `${name}.exe`) : join(venv, "bin", name);
}
