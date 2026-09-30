// The relay protocol between the Worker's Relay Durable Object and the PC agent (design §9), over
// one WebSocket the agent opens. Shared by both ends; Web-platform APIs only.
//
// A message is a JSON header in a text frame, followed by its body, if any, in binary frames of at
// most CHUNK bytes; the header says how many. Each side sends a header and its chunks in one
// synchronous run, so frames of two messages never interleave, and the receiver reassembles them in
// order (WebSocket keeps order).
//
//   Worker -> agent:  http     one ComfyUI request: {method, path, params, headers} + body
//                     control  an agent operation: {op, args}, and a body for a LoRA upload's chunk
//                              (ensure, loras, download, models, sync, upload_*, lora_delete, status)
//   agent -> Worker:  reply    {id, status} + body. For http, ComfyUI's status and body; for
//                              control, 200 with a JSON body or an error status with a message
//                     hello    {info}: the agent's version, GPU, ComfyUI state, on connecting

import { fromUtf8, utf8 } from "./bytes.ts";

export const CHUNK = 1 << 20; // below every WebSocket message limit Cloudflare documents

export type HttpMessage = {
  kind: "http";
  id: string;
  method: string;
  path: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
};
export type ControlMessage = { kind: "control"; id: string; op: string; args?: unknown };
export type ReplyMessage = { kind: "reply"; id: string; status: number };
export type HelloMessage = { kind: "hello"; info: Record<string, unknown> };
export type RelayHeader = HttpMessage | ControlMessage | ReplyMessage | HelloMessage;
export type RelayMessage = { header: RelayHeader; body: Uint8Array };

/** The frames of one message: the header (with its chunk count), then the body's chunks. */
export function encodeMessage(header: RelayHeader, body?: Uint8Array | string): (string | Uint8Array)[] {
  const bytes = typeof body === "string" ? utf8(body) : body ?? new Uint8Array();
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) chunks.push(bytes.subarray(i, i + CHUNK));
  return [JSON.stringify({ ...header, chunks: chunks.length }), ...chunks];
}

export class ProtocolError extends Error {
  name = "ProtocolError";
}

/** Reassembles frames into messages. push() returns a message once it is complete, else null. */
export class Assembler {
  private header: (RelayHeader & { chunks?: number }) | null = null;
  private parts: Uint8Array[] = [];

  push(frame: string | ArrayBuffer | Uint8Array): RelayMessage | null {
    if (typeof frame === "string") {
      if (this.header) throw new ProtocolError("a header arrived before the previous message's body");
      let header: any;
      try {
        header = JSON.parse(frame);
      } catch {
        throw new ProtocolError("a text frame that is not JSON");
      }
      if (!header || typeof header.kind !== "string") throw new ProtocolError("a header without a kind");
      if (!header.chunks) return { header: strip(header), body: new Uint8Array() };
      this.header = header;
      this.parts = [];
      return null;
    }
    if (!this.header) throw new ProtocolError("a binary frame without a header");
    this.parts.push(frame instanceof Uint8Array ? frame : new Uint8Array(frame));
    if (this.parts.length < this.header.chunks!) return null;
    const header = strip(this.header);
    const body = this.parts.length === 1 ? this.parts[0] : join(this.parts);
    this.header = null;
    this.parts = [];
    return { header, body };
  }
}

function strip(header: RelayHeader & { chunks?: number }): RelayHeader {
  const { chunks: _, ...rest } = header;
  return rest as RelayHeader;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** A control reply's JSON body, or its error message. */
export function controlResult(status: number, body: Uint8Array): { ok: true; data: any } | { ok: false; message: string } {
  const text = fromUtf8(body);
  if (status === 200) {
    try {
      return { ok: true, data: text ? JSON.parse(text) : null };
    } catch {
      return { ok: false, message: "the PC answered with something that is not JSON" };
    }
  }
  return { ok: false, message: text || `the PC answered ${status}` };
}
