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
      const comfy = new LocalComfy(paths({ COMFY_GEN_HOME: mkdtempSync(join(tmpdir(), "idle-")) }), () => ({ comfyui_url: url, extra_models_dir: "", keep_warm_minutes: 1, gpu: "" }), "");
      await comfy.refresh();
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
