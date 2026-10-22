import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalComfy } from "../src/comfyui.ts";
import { paths } from "../src/paths.ts";

describe("keep-warm's idle stop", () => {
  it("counts ComfyUI's queue as use: a generation that outlived its tool call keeps it running", async () => {
    let queue = { queue_running: [["1", "p"]], queue_pending: [] as unknown[] };
    const server = createServer((_, res) => res.end(JSON.stringify(queue)));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const comfy = new LocalComfy(paths({ COMFY_GEN_HOME: mkdtempSync(join(tmpdir(), "idle-")) }), () => ({ extra_models_dir: "", keep_warm_minutes: 1, gpu: "" }), {});
      comfy.url = url; // as if launched
      expect(await comfy.queueEmpty()).toBe(false);
      queue = { queue_running: [], queue_pending: [["2", "p"]] };
      expect(await comfy.queueEmpty()).toBe(false);
      queue = { queue_running: [], queue_pending: [] };
      expect(await comfy.queueEmpty()).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("custom node packages", () => {
  it("installs only the ones Comfy-Gen's own packs use: a paired Worker names them, and they are code", async () => {
    const comfy = new LocalComfy(paths({ COMFY_GEN_HOME: mkdtempSync(join(tmpdir(), "nodes-")) }), () => ({ extra_models_dir: "", keep_warm_minutes: 1, gpu: "" }), {});
    comfy.nodeClasses = async () => new Set(["KSampler"]);
    await expect(comfy.ensureNodes({ EvilNode: "evil-package" })).rejects.toThrow("evil-package, which this version of Comfy-Gen doesn't install");
    // A known one gets past the check (and on to the install, which needs ComfyUI installed).
    await expect(comfy.ensureNodes({ UnetLoaderGGUF: "ComfyUI-GGUF" })).rejects.toThrow("ComfyUI is not installed");
    await comfy.ensureNodes({ KSampler: "evil-package" }); // already loaded: nothing to install, nothing refused
  });
});

describe("a GPU's own ComfyUI flags", () => {
  // A ComfyUI install whose "python" runs main.py with Node: it notes its arguments and answers.
  function fakeInstall() {
    const home = mkdtempSync(join(tmpdir(), "flags-"));
    const p = paths({ COMFY_GEN_HOME: home });
    mkdirSync(join(p.comfyui, "models"), { recursive: true });
    writeFileSync(join(p.comfyui, "main.py"), `
      const args = process.argv.slice(2);
      require("node:fs").appendFileSync("starts.jsonl", JSON.stringify(args) + "\\n");
      const port = Number(args[args.indexOf("--port") + 1]);
      require("node:http").createServer((req, res) => res.end(JSON.stringify({ queue_running: [], queue_pending: [] }))).listen(port, "127.0.0.1");
    `);
    const python = join(home, "python");
    writeFileSync(python, `#!/bin/sh\n[ "$1" = "-c" ] && exit 0\nexec "${process.execPath}" "$@"\n`);
    chmodSync(python, 0o755);
    writeFileSync(join(p.comfyui, ".comfy-gen.json"), JSON.stringify({ version: "x", gpu: "nvidia", python }));
    const starts = () => readFileSync(join(p.comfyui, "starts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    return { p, starts };
  }

  it.skipIf(process.platform === "win32")("go after ours, and a change restarts ComfyUI at its next use", async () => {
    const { p, starts } = fakeInstall();
    const home = process.env.HOME;
    process.env.HOME = p.home; // ComfyUI's start announces it in ~/.comfy-registry: not the real one
    let comfy_args = ["--reserve-vram", "2", "--cache-ram", "8"];
    const comfy = new LocalComfy(p, () => ({ extra_models_dir: "", keep_warm_minutes: 1, gpu: "", comfy_args }), {});
    try {
      await comfy.ensureRunning();
      expect(starts()[0].slice(-7)).toEqual(["--cache-ram", "4", "6", "--reserve-vram", "2", "--cache-ram", "8"]);
      await comfy.ensureRunning();
      expect(starts()).toHaveLength(1); // unchanged: no restart
      comfy_args = ["--lowvram"];
      await Promise.all([comfy.ensureRunning(), comfy.ensureRunning()]);
      expect(starts()).toHaveLength(2);
      expect(starts()[1].slice(-4)).toEqual(["--cache-ram", "4", "6", "--lowvram"]);
      comfy_args = ["--listen", "0.0.0.0"]; // edited in by hand: ignored
      await comfy.ensureRunning();
      expect(starts()[2].slice(-3)).toEqual(["--cache-ram", "4", "6"]);
    } finally {
      await comfy.stop();
      process.env.HOME = home;
    }
  }, 30_000);
});
