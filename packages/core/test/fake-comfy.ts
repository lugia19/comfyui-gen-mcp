// A scripted in-memory ComfyUI, as a Transport. Shaped after Visual-Novelist's FakeComfy.

import { concat, fromUtf8, utf8 } from "../src/bytes.ts";
import { ComfyUIClient, Response, type ClientOptions, type RequestOptions, type Transport } from "../src/comfyui.ts";

/** Instant sleeps and a clock that moves only when slept, so waits are deterministic. */
export function fastClient(transport: Transport, opts: ClientOptions = {}): ComfyUIClient {
  let t = 0;
  return new ComfyUIClient(transport, {
    sleep: async (s) => {
      t += s;
    },
    now: () => t,
    ...opts,
  });
}

/** The smallest PNG header that imageSize and sniffMime accept. */
export function png(w = 64, h = 48): Uint8Array {
  const head = new Uint8Array(24);
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(head.buffer);
  view.setUint32(16, w);
  view.setUint32(20, h);
  return concat([head, new Uint8Array([8, 2, 0, 0, 0, 0, 0, 0, 0])]);
}

export const OUTPUT = { filename: "comfy-gen_00001_.png", subfolder: "", type: "output" };

export const json = (data: unknown, status = 200) => new Response(status, utf8(JSON.stringify(data)), { "content-type": "application/json" });

/**
 * bootFails   how many /prompt calls answer 503 before one is accepted
 * reject      if set, /prompt answers 400 with this JSON body
 * history     per /history call, what the job looks like; when exhausted, "done":
 *               "running"  not in history, running in the queue
 *               "pending"  not in history, second in the pending queue
 *               "done"     in history with an output image
 *               "error"    in history with an execution error
 *               "gone"     in neither history nor queue
 *               <number>   that HTTP status
 */
export class FakeComfy implements Transport {
  bootFails = 0;
  viewBootFails = 0;
  reject: unknown = null;
  history: (string | number)[] = [];
  prompts: Record<string, any>[] = [];
  calls: [string, string, Record<string, string> | undefined][] = [];
  uploads: Uint8Array[] = [];
  viewBody: Uint8Array = utf8("RIFF\x00\x00\x00\x00WEBPVP8 fake");
  private state = "running";

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    this.calls.push([method, path, opts.params]);
    const body = typeof opts.body === "string" ? utf8(opts.body) : opts.body ?? new Uint8Array();
    if (path === "/prompt") {
      if (this.bootFails) {
        this.bootFails -= 1;
        return new Response(503);
      }
      if (this.reject !== null) return json(this.reject, 400);
      this.prompts.push(JSON.parse(fromUtf8(body)).prompt);
      this.state = "running";
      return json({ prompt_id: `p${this.prompts.length}` });
    }
    const m = /^\/history\/(\w+)$/.exec(path);
    if (m) {
      const step = this.history.length ? this.history.shift()! : "done";
      if (typeof step === "number") return new Response(step);
      this.state = step;
      const pid = m[1];
      if (step === "done") {
        return json({ [pid]: { status: { status_str: "success", completed: true }, outputs: { "9": { images: [OUTPUT] } } } });
      }
      if (step === "error") {
        return json({
          [pid]: {
            status: { status_str: "error", messages: [["execution_error", { node_type: "KSampler", exception_message: "out of memory" }]] },
            outputs: {},
          },
        });
      }
      return json({});
    }
    if (path === "/queue") {
      const pid = `p${this.prompts.length}`;
      const running = this.state === "running" ? [[0, pid, {}, {}, []]] : [];
      const pending = this.state === "pending" ? [[1, "other", {}, {}, []], [2, pid, {}, {}, []]] : [];
      return json({ queue_running: running, queue_pending: pending });
    }
    if (path === "/view") {
      if (this.viewBootFails) {
        this.viewBootFails -= 1;
        return new Response(503);
      }
      return new Response(200, this.viewBody, { "content-type": "image/webp" });
    }
    if (path === "/upload/image") {
      this.uploads.push(body);
      const text = String.fromCharCode(...body);
      const name = /filename="([^"]+)"/.exec(text)![1];
      const sub = /name="subfolder"\r\n\r\n([^\r]*)\r\n/.exec(text);
      return json({ name, subfolder: sub ? sub[1] : "", type: "input" });
    }
    if (path === "/system_stats") return json({ system: { comfyui_version: "0.37.0", os: "posix" }, devices: [] });
    if (path === "/object_info") return json({ KSampler: {}, SaveImage: {}, CLIPTextEncode: {} });
    return new Response(404);
  }
}
