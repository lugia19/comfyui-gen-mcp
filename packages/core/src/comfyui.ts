// Async ComfyUI client over a pluggable transport.
//
// ComfyUI's own HTTP API is the generator interface everywhere: Modal (HTTPS with proxy-token
// headers), a PC (through the Worker's relay to the agent), or localhost (the MCPB). The client only
// needs something that sends one HTTP request and hands back status and body, so the relay
// can carry requests as plain data.
//
// Completion: a generator with our /comfy-gen/wait extension (the Modal image's, comfy_node/)
// holds one request until the prompt finishes; any other ComfyUI is polled on /history. No
// WebSocket: it doesn't survive the relay. Each request costs the Worker CPU and a subrequest, so
// the poll schedule backs off quickly.

import { concat, fromUtf8, tokenHex, utf8 } from "./bytes.ts";

export const BOOTING = [502, 503, 504]; // what a scale-to-zero host answers while a container starts
// Seconds between /history polls: quick at first (a warm generation takes a few seconds), then
// sparse. The Worker's free plan allows 50 subrequests per invocation.
export const POLL_SCHEDULE = [1, 1, 2, 2, 3, 5, 5, 8];
export const POLL_SCHEDULE_TAIL = 10;
export const COLD_START_POLL_S = 5; // Modal boots in about 44 s: ~9 retries
const QUEUE_CHECK_EVERY = 5; // polls between queue checks while nothing looks wrong
// Seconds one /comfy-gen/wait request is held: well under the 100 s after which Cloudflare's edge
// may give up on a response.
export const HELD_WAIT_S = 50;
// Requests kept back for after the wait: the result image and one re-request at lower quality, or
// the queue position for a Pending answer.
export const BUDGET_RESERVE = 2;
/** A cold start still going when the tool call must answer: the model should simply call again. */
export const STILL_STARTING = "The GPU is still starting up (a cold start). Call the tool again in a minute.";

/** A generation failed. The message is meant for the user. */
export class ComfyUIError extends Error {
  name = "ComfyUIError";
}

export class Response {
  status: number;
  content: Uint8Array;

  constructor(status: number, content: Uint8Array = new Uint8Array()) {
    this.status = status;
    this.content = content;
  }

  get text(): string {
    return fromUtf8(this.content);
  }

  json(): any {
    return JSON.parse(this.text);
  }
}

export type RequestOptions = {
  params?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
};

export interface Transport {
  request(method: string, path: string, opts?: RequestOptions): Promise<Response>;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<globalThis.Response>;

/** HTTP(S) to a ComfyUI base URL with fixed extra headers. Network failures read as 503, so a host
 * that isn't listening yet looks the same as one that is booting. */
export class FetchTransport implements Transport {
  readonly baseUrl: string;
  private fetchFn: Fetch;
  private headers: Record<string, string>;

  constructor(fetchFn: Fetch, baseUrl: string, headers: Record<string, string> = {}) {
    this.fetchFn = fetchFn;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.headers = headers;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const query = opts.params ? "?" + new URLSearchParams(opts.params).toString() : "";
    try {
      const resp = await this.fetchFn(this.baseUrl + path + query, {
        method,
        headers: { ...this.headers, ...opts.headers },
        body: opts.body as BodyInit | undefined,
      });
      return new Response(resp.status, new Uint8Array(await resp.arrayBuffer()));
    } catch (e) {
      return new Response(503, utf8(String(e)));
    }
  }
}

/** A file ComfyUI owns: an output (generated), or an input (uploaded). */
export class OutputImage {
  filename: string;
  subfolder: string;
  type: string;

  constructor(filename: string, subfolder = "", type = "output") {
    this.filename = filename;
    this.subfolder = subfolder;
    this.type = type;
  }

  params(): Record<string, string> {
    return { filename: this.filename, subfolder: this.subfolder, type: this.type };
  }

  /** The value LoadImage takes: inputs by relative path, outputs with ComfyUI's "[output]" annotation (S5). */
  loadValue(): string {
    const path = this.subfolder ? `${this.subfolder}/${this.filename}` : this.filename;
    return this.type === "input" ? path : `${path} [${this.type}]`;
  }
}

/** multipart/form-data body. files: {field: [filename, data, mime]}. */
export function encodeMultipart(
  fields: Record<string, string>,
  files: Record<string, [string, Uint8Array, string]>,
): [Uint8Array, string] {
  const boundary = "----comfygen" + tokenHex(12);
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(utf8(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const [name, [filename, data, mime]] of Object.entries(files)) {
    parts.push(utf8(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
    parts.push(data, utf8("\r\n"));
  }
  parts.push(utf8(`--${boundary}--\r\n`));
  return [concat(parts), `multipart/form-data; boundary=${boundary}`];
}

export type ClientOptions = {
  /** How long submit() keeps retrying while the host answers 502/503/504. */
  coldStartS?: number;
  /** Max transport requests this client may make (the Worker's per-invocation subrequest limit).
   * wait() stops early, returning null, when only BUDGET_RESERVE requests are left. */
  requestBudget?: number | null;
  sleep?: (seconds: number) => Promise<void>;
  /** Seconds, monotonic enough for deadlines. */
  now?: () => number;
};

const defaultSleep = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));

export class ComfyUIClient {
  readonly coldStartS: number;
  readonly requestBudget: number | null;
  requestsMade = 0;
  /** false once the generator answered 404 on /comfy-gen/wait: poll instead. */
  heldWait = true;
  readonly clientId = tokenHex(16);
  readonly transport: Transport;
  /** When the current tool call must answer by (now() terms), or null: no cold-start wait goes past
   * it, so a call ends with an image, a fetch_result token or "still starting", never a client
   * timeout. The Brain sets it per call. */
  stopBy: number | null = null;
  private sleep: (s: number) => Promise<void>;
  private now: () => number;

  constructor(transport: Transport, opts: ClientOptions = {}) {
    this.transport = transport;
    this.coldStartS = opts.coldStartS ?? 0;
    this.requestBudget = opts.requestBudget ?? null;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => Date.now() / 1000);
  }

  /** The clock the client keeps time by. */
  time(): number {
    return this.now();
  }

  /** Until when a cold start may be waited out, and whether the call's budget is what limits it. */
  private coldDeadline(): { at: number; byCall: boolean } {
    const own = this.now() + this.coldStartS;
    return this.stopBy !== null && this.stopBy < own ? { at: this.stopBy, byCall: true } : { at: own, byCall: false };
  }

  remaining(): number | null {
    return this.requestBudget === null ? null : this.requestBudget - this.requestsMade;
  }

  /** Whether n more requests fit while keeping the reserve. */
  private canSpend(n: number): boolean {
    const left = this.remaining();
    return left === null || left - n >= BUDGET_RESERVE;
  }

  private request(method: string, path: string, opts?: RequestOptions): Promise<Response> {
    this.requestsMade += 1;
    return this.transport.request(method, path, opts);
  }

  private pollDelay(polls: number): number {
    return polls < POLL_SCHEDULE.length ? POLL_SCHEDULE[polls] : POLL_SCHEDULE_TAIL;
  }

  /** Queue a workflow and return its prompt_id, waiting out a cold start when allowed. */
  async submit(workflow: Record<string, any>): Promise<string> {
    const body = JSON.stringify({ prompt: workflow, client_id: this.clientId });
    const deadline = this.coldDeadline();
    for (;;) {
      const resp = await this.request("POST", "/prompt", { headers: { "Content-Type": "application/json" }, body });
      if (resp.status === 200) return resp.json().prompt_id;
      if (!BOOTING.includes(resp.status) || !this.coldStartS) throw new ComfyUIError(rejection(resp));
      if (this.now() > deadline.at) {
        throw new ComfyUIError(deadline.byCall ? STILL_STARTING : `The GPU did not start within ${this.coldStartS.toFixed(0)}s.`);
      }
      // Leave room for at least one more submit and a couple of polls after it.
      if (!this.canSpend(3)) throw new ComfyUIError("The GPU is still starting up. Please try again in a minute.");
      await this.sleep(COLD_START_POLL_S);
    }
  }

  /**
   * Wait until the prompt finishes. Returns its images, or null if still running at *timeout*.
   * Throws ComfyUIError on an execution error, or when the prompt is in neither history nor queue
   * (unknown id, cancelled, or the GPU worker was replaced mid-job).
   */
  async wait(promptId: string, timeout: number): Promise<OutputImage[] | null> {
    if (this.heldWait) {
      const result = await this.waitHeld(promptId, timeout);
      if (result !== undefined) return result;
    }
    return this.waitPolling(promptId, timeout);
  }

  /** wait() through /comfy-gen/wait; undefined if the generator doesn't have it. */
  private async waitHeld(promptId: string, timeout: number): Promise<OutputImage[] | null | undefined> {
    const deadline = this.now() + timeout;
    let interrupted = false;
    for (;;) {
      if (!this.canSpend(1)) return null;
      const hold = Math.max(0, Math.min(deadline - this.now(), HELD_WAIT_S));
      const resp = await this.request("GET", `/comfy-gen/wait/${encodeURIComponent(promptId)}`, { params: { timeout: String(hold) } });
      if (resp.status === 404) {
        this.heldWait = false;
        return undefined;
      }
      if (resp.status === 200) {
        const job = resp.json();
        if (job.state === "done") return outputs(promptId, job);
        if (job.state === "unknown") throw new ComfyUIError(interrupted ? RESTARTED : unknown(promptId));
      } else {
        interrupted = true; // a 5xx mid-job: the GPU worker may have been replaced
      }
      if (this.now() >= deadline) return null;
      if (resp.status !== 200) await this.sleep(COLD_START_POLL_S);
    }
  }

  private async waitPolling(promptId: string, timeout: number): Promise<OutputImage[] | null> {
    const deadline = this.now() + timeout;
    let interrupted = false; // saw a 5xx since we started waiting
    let polls = 0;
    for (;;) {
      if (!this.canSpend(3)) return null; // a poll can cost three requests (history, queue, history)
      let [entry, status] = await this.historyEntry(promptId);
      interrupted ||= status >= 500;
      if (entry) return outputs(promptId, entry);
      const checkQueue = status === 200 && (interrupted || polls % QUEUE_CHECK_EVERY === 0);
      if (checkQueue && (await this.queuePosition(promptId)) === null) {
        [entry] = await this.historyEntry(promptId); // it may have finished between the requests
        if (entry) return outputs(promptId, entry);
        throw new ComfyUIError(interrupted ? RESTARTED : unknown(promptId));
      }
      if (this.now() >= deadline) return null;
      await this.sleep(this.pollDelay(polls));
      polls += 1;
    }
  }

  async statusMessage(promptId: string): Promise<string> {
    const left = this.remaining();
    if (left !== null && left < 1) return "Generating";
    const pos = await this.queuePosition(promptId);
    if (pos === 0) return "Currently being generated";
    if (pos) return `Position ${pos} in queue`;
    return "Generating";
  }

  private async historyEntry(promptId: string): Promise<[any | null, number]> {
    const resp = await this.request("GET", `/history/${promptId}`);
    if (resp.status !== 200) return [null, resp.status];
    const entry = resp.json()[promptId];
    if (!entry) return [null, 200];
    const status = entry.status ?? {};
    if (status.status_str === "error" || status.completed || (entry.outputs && Object.keys(entry.outputs).length)) {
      return [entry, 200];
    }
    return [null, 200];
  }

  /** 0 if running, n > 0 if pending at position n, null if not queued. An unreadable queue counts
   * as running, so a flaky read never fails a live job. */
  private async queuePosition(promptId: string): Promise<number | null> {
    const resp = await this.request("GET", "/queue");
    if (resp.status !== 200) return 0;
    const q = resp.json();
    if ((q.queue_running ?? []).some((i: any[]) => i.length > 1 && i[1] === promptId)) return 0;
    const pending = [...(q.queue_pending ?? [])].sort((a: any[], b: any[]) => (a?.[0] ?? 0) - (b?.[0] ?? 0));
    const idx = pending.findIndex((i: any[]) => i.length > 1 && i[1] === promptId);
    return idx < 0 ? null : idx + 1;
  }

  /** Fetch an image from /view. *preview* ("webp;90", "jpeg;85") has ComfyUI convert it first.
   * Waits out a cold start like submit(): a full-resolution link opened after the GPU scaled to
   * zero would otherwise fail (seen live). */
  async view(image: OutputImage, preview?: string): Promise<Response> {
    const params = image.params();
    if (preview) params.preview = preview;
    const deadline = this.coldDeadline();
    for (;;) {
      const resp = await this.request("GET", "/view", { params });
      if (resp.status === 200) return resp;
      const left = this.remaining();
      const booting = BOOTING.includes(resp.status) && this.coldStartS;
      const retry = booting && this.now() <= deadline.at && (left === null || left > 0);
      if (!retry) {
        if (booting && deadline.byCall && this.now() > deadline.at) throw new ComfyUIError(STILL_STARTING);
        throw new ComfyUIError(`Could not fetch ${image.filename} (HTTP ${resp.status}).`);
      }
      await this.sleep(COLD_START_POLL_S);
    }
  }

  /** Upload to ComfyUI's input folder (overwriting a same-named file). Waits out a cold start like
   * submit(): editing a PC image on a Modal that had scaled to zero failed at once (seen live). */
  async upload(data: Uint8Array, filename: string, mime: string, subfolder = ""): Promise<OutputImage> {
    const fields: Record<string, string> = { type: "input", overwrite: "true" };
    if (subfolder) fields.subfolder = subfolder;
    const [body, ctype] = encodeMultipart(fields, { image: [filename, data, mime] });
    const deadline = this.coldDeadline();
    let resp: Response;
    for (;;) {
      resp = await this.request("POST", "/upload/image", { headers: { "Content-Type": ctype }, body });
      if (resp.status === 200) break;
      const left = this.remaining();
      const retry = BOOTING.includes(resp.status) && this.coldStartS && this.now() <= deadline.at && (left === null || left > 3);
      if (!retry) {
        if (BOOTING.includes(resp.status) && this.coldStartS) throw new ComfyUIError(STILL_STARTING);
        throw new ComfyUIError(`Upload to ComfyUI failed (HTTP ${resp.status}): ${resp.text.slice(0, 300)}`);
      }
      await this.sleep(COLD_START_POLL_S);
    }
    const info = resp.json();
    return new OutputImage(info.name, info.subfolder || "", "input");
  }

  /** Every node class this ComfyUI knows. /object_info is large: callers should cache it. */
  async nodeClasses(): Promise<Set<string>> {
    const resp = await this.request("GET", "/object_info");
    if (resp.status !== 200) throw new ComfyUIError(`Could not read ComfyUI's node list (HTTP ${resp.status}).`);
    return new Set(Object.keys(resp.json()));
  }
}

const RESTARTED = "The GPU worker restarted mid-image. Please retry.";
const unknown = (promptId: string) => `Unknown or expired request ${promptId}: it is not queued and has no result.`;

/** User-facing text for a rejected /prompt, with ComfyUI's validation messages when present. */
function rejection(resp: Response): string {
  let data: any;
  try {
    data = resp.json();
  } catch {
    return `ComfyUI rejected the workflow (HTTP ${resp.status}): ${resp.text.slice(0, 500)}`;
  }
  const err = data && typeof data === "object" && !Array.isArray(data) ? data.error ?? {} : {};
  const details: string[] = [];
  for (const [nodeId, nodeErr] of Object.entries<any>(data?.node_errors ?? {})) {
    for (const e of nodeErr.errors ?? []) {
      details.push(`node ${nodeId} (${nodeErr.class_type ?? "?"}): ${e.message} ${e.details ?? ""}`.trim());
    }
  }
  const msg = err.message || `HTTP ${resp.status}`;
  return "ComfyUI rejected the workflow: " + msg + (details.length ? "\n" + details.join("\n") : "");
}

function outputs(promptId: string, entry: any): OutputImage[] {
  const status = entry.status ?? {};
  if (status.status_str === "error") throw new ComfyUIError(`ComfyUI execution failed: ${errorSummary(status)}`);
  const images: OutputImage[] = [];
  for (const node of Object.values<any>(entry.outputs ?? {})) {
    for (const img of node.images ?? []) {
      if ((img.type ?? "output") === "output") images.push(new OutputImage(img.filename, img.subfolder ?? "", img.type ?? "output"));
    }
  }
  if (!images.length) throw new ComfyUIError(`Job ${promptId} finished but produced no images.`);
  return images;
}

function errorSummary(status: any): string {
  for (const [kind, data] of status.messages ?? []) {
    if (kind === "execution_error" && data && typeof data === "object") {
      const node = data.node_type || data.node_id || "?";
      return `${node}: ${String(data.exception_message ?? "").trim()}`;
    }
  }
  return JSON.stringify(status.messages ?? null).slice(0, 500);
}
