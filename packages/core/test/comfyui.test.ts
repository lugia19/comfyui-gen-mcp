import { describe, expect, it } from "vitest";
import { fromUtf8 } from "../src/bytes.ts";
import { ComfyUIError, HELD_WAIT_S, OutputImage } from "../src/comfyui.ts";
import { FakeComfy, fastClient } from "./fake-comfy.ts";

const WF = { "1": { class_type: "SaveImage", inputs: {} } };

function setup() {
  const comfy = new FakeComfy();
  return { comfy, client: fastClient(comfy, { coldStartS: 60 }) };
}

describe("ComfyUIClient", () => {
  it("upload waits out a cold start too, but only where cold starts are expected", async () => {
    const { comfy, client } = setup();
    comfy.uploadBootFails = 2;
    const img = await client.upload(new Uint8Array([1, 2]), "a.png", "image/png");
    expect(img.filename).toBe("a.png");
    expect(comfy.calls.filter((c) => c[1] === "/upload/image").length).toBe(3);
    const warmOnly = fastClient(comfy, {}); // a PC or a URL: no cold start to wait for
    comfy.uploadBootFails = 1;
    await expect(warmOnly.upload(new Uint8Array([1]), "b.png", "image/png")).rejects.toThrow(/HTTP 503/);
  });

  it("submit waits out a cold start", async () => {
    const { comfy, client } = setup();
    comfy.bootFails = 3;
    expect(await client.submit(WF)).toBe("p1");
    expect(comfy.calls.filter((c) => c[1] === "/prompt").length).toBe(4);
  });

  it("submit without a cold-start allowance fails on 503", async () => {
    const comfy = new FakeComfy();
    comfy.bootFails = 1;
    await expect(fastClient(comfy).submit(WF)).rejects.toThrow(/HTTP 503/);
  });

  it("a rejection names the bad node", async () => {
    const { comfy, client } = setup();
    comfy.reject = {
      error: { message: "Prompt outputs failed validation" },
      node_errors: { "44": { class_type: "UNETLoader", errors: [{ message: "Value not in list", details: "unet_name: x" }] } },
    };
    await expect(client.submit(WF)).rejects.toThrow(/node 44 \(UNETLoader\): Value not in list/);
  });

  it("wait returns the output images", async () => {
    const { comfy, client } = setup();
    await client.submit(WF);
    comfy.history = ["running", "running", "done"];
    expect(await client.wait("p1", 60)).toEqual([new OutputImage("comfy-gen_00001_.png", "", "output")]);
  });

  it("wait times out with null", async () => {
    const { comfy, client } = setup();
    await client.submit(WF);
    comfy.history = Array(50).fill("running");
    expect(await client.wait("p1", 0)).toBeNull();
  });

  it("wait reports execution errors", async () => {
    const { comfy, client } = setup();
    await client.submit(WF);
    comfy.history = ["error"];
    await expect(client.wait("p1", 60)).rejects.toThrow(/KSampler: out of memory/);
  });

  it("wait detects a replaced worker", async () => {
    const { comfy, client } = setup();
    await client.submit(WF);
    comfy.history = ["running", 503, "gone", "gone"];
    await expect(client.wait("p1", 60)).rejects.toThrow(/restarted mid-image/);
  });

  it("wait on an unknown id", async () => {
    const { comfy, client } = setup();
    comfy.history = ["gone", "gone"];
    await expect(client.wait("nope", 60)).rejects.toThrow(/Unknown or expired/);
  });

  it("statusMessage", async () => {
    const { comfy, client } = setup();
    await client.submit(WF);
    comfy.history = ["pending"];
    await client.wait("p1", 0);
    expect(await client.statusMessage("p1")).toBe("Position 2 in queue");
  });

  it("view passes the preview format", async () => {
    const { comfy, client } = setup();
    const resp = await client.view(new OutputImage("a.png"), "webp;90");
    expect(fromUtf8(resp.content.subarray(0, 4))).toBe("RIFF");
    expect(comfy.calls.at(-1)![2]).toEqual({ filename: "a.png", subfolder: "", type: "output", preview: "webp;90" });
  });

  it("view waits out a cold start, but not without an allowance", async () => {
    const { comfy, client } = setup();
    comfy.viewBootFails = 2;
    expect((await client.view(new OutputImage("a.png"))).status).toBe(200);
    expect(comfy.calls.filter((c) => c[1] === "/view").length).toBe(3);
    comfy.viewBootFails = 1;
    await expect(fastClient(comfy).view(new OutputImage("a.png"))).rejects.toThrow(/HTTP 503/);
  });

  it("upload sends multipart and returns an input image", async () => {
    const { comfy, client } = setup();
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x20, 0x64, 0x61, 0x74, 0x61]);
    const img = await client.upload(data, "upload-x.png", "image/png", "comfy-gen-uploads");
    expect(img).toEqual(new OutputImage("upload-x.png", "comfy-gen-uploads", "input"));
    expect(String.fromCharCode(...comfy.uploads[0])).toContain("\x89PNG data");
  });

  it("nodeClasses", async () => {
    const { client } = setup();
    expect((await client.nodeClasses()).has("KSampler")).toBe(true);
  });
});

describe("held wait (/comfy-gen/wait)", () => {
  function held() {
    const comfy = new FakeComfy();
    comfy.heldWait = true;
    return { comfy, client: fastClient(comfy, { coldStartS: 60 }) };
  }
  const waits = (comfy: FakeComfy) => comfy.calls.filter((c) => c[1].startsWith("/comfy-gen/wait/"));

  it("returns the images without polling", async () => {
    const { comfy, client } = held();
    await client.submit(WF);
    comfy.history = ["running", "done"];
    expect(await client.wait("p1", 240)).toEqual([new OutputImage("comfy-gen_00001_.png", "", "output")]);
    expect(waits(comfy).map((c) => c[2])).toEqual([{ timeout: String(HELD_WAIT_S) }, { timeout: String(HELD_WAIT_S) }]);
    expect(comfy.calls.some((c) => c[1].startsWith("/history") || c[1] === "/queue")).toBe(false);
  });

  it("holds no longer than the caller's timeout", async () => {
    const { comfy, client } = held();
    comfy.history = ["running"];
    expect(await client.wait("p1", 7)).toBeNull();
    expect(waits(comfy)[0][2]).toEqual({ timeout: "7" });
  });

  it("reports errors, unknown ids and a replaced worker", async () => {
    let { comfy, client } = held();
    comfy.history = ["error"];
    await expect(client.wait("p1", 60)).rejects.toThrow(/KSampler: out of memory/);
    ({ comfy, client } = held());
    comfy.history = ["gone"];
    await expect(client.wait("p1", 60)).rejects.toThrow(/Unknown or expired/);
    ({ comfy, client } = held());
    comfy.history = ["running", 503, "gone"];
    await expect(client.wait("p1", 60)).rejects.toThrow(/restarted mid-image/);
  });

  it("falls back to polling on a ComfyUI without it, once", async () => {
    const { comfy, client } = setup(); // FakeComfy answers 404 on the route by default
    await client.submit(WF);
    comfy.history = ["running", "done", "done"];
    expect(await client.wait("p1", 60)).not.toBeNull();
    expect(await client.wait("p1", 60)).not.toBeNull();
    expect(waits(comfy).length).toBe(1);
  });

  it("keeps the budget reserve", async () => {
    const comfy = new FakeComfy();
    comfy.heldWait = true;
    const c = fastClient(comfy, { requestBudget: 5 });
    comfy.history = Array(10).fill(503);
    expect(await c.wait("p1", 3600)).toBeNull();
    expect(c.remaining()).toBe(2);
  });
});

describe("request budget (the Worker's free plan allows 50 subrequests per invocation)", () => {
  it("wait stops early and keeps the reserve", async () => {
    const comfy = new FakeComfy();
    const c = fastClient(comfy, { requestBudget: 12 });
    await c.submit(WF);
    comfy.history = Array(100).fill("running");
    expect(await c.wait("p1", 3600)).toBeNull();
    expect(c.remaining()!).toBeGreaterThanOrEqual(2); // left for the image, or the queue position
    expect(await c.statusMessage("p1")).toBe("Currently being generated");
    expect(c.requestsMade).toBeLessThanOrEqual(12);
  });

  it("a cold start gives up before the budget runs out", async () => {
    const comfy = new FakeComfy();
    comfy.bootFails = 100;
    const c = fastClient(comfy, { coldStartS: 3600, requestBudget: 10 });
    await expect(c.submit(WF)).rejects.toThrow(/still starting/);
    expect(c.requestsMade).toBeLessThanOrEqual(10);
  });

  it("statusMessage without budget makes no request", async () => {
    const comfy = new FakeComfy();
    const c = fastClient(comfy, { requestBudget: 0 });
    expect(await c.statusMessage("p1")).toBe("Generating");
    expect(comfy.calls).toEqual([]);
  });

  it("errors are ComfyUIError", async () => {
    const comfy = new FakeComfy();
    comfy.history = ["error"];
    await expect(fastClient(comfy).wait("p1", 60)).rejects.toBeInstanceOf(ComfyUIError);
  });
});
