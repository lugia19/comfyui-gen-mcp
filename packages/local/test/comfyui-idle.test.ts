import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
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
