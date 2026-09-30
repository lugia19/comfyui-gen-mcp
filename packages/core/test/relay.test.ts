import { describe, expect, it } from "vitest";
import { relay, utf8 } from "../src/index.ts";

describe("relay framing", () => {
  it("sends a header and its body in chunks, and reassembles them", () => {
    const body = new Uint8Array(relay.CHUNK * 2 + 123).map((_, i) => i % 251);
    const frames = relay.encodeMessage({ kind: "reply", id: "a", status: 200 }, body);
    expect(frames.length).toBe(4); // header + 3 chunks
    expect(JSON.parse(frames[0] as string)).toEqual({ kind: "reply", id: "a", status: 200, chunks: 3 });
    const asm = new relay.Assembler();
    const out = frames.map((f) => asm.push(f));
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out[3]!.header).toEqual({ kind: "reply", id: "a", status: 200 });
    const got = out[3]!.body;
    expect(got.length).toBe(body.length);
    expect(got.every((b, i) => b === body[i])).toBe(true); // toEqual on megabytes is slow
  });

  it("delivers a message without a body at once, and keeps messages apart", () => {
    const asm = new relay.Assembler();
    const hello = relay.encodeMessage({ kind: "hello", info: { gpu: "nvidia" } });
    expect(hello.length).toBe(1);
    expect(asm.push(hello[0])!.header).toEqual({ kind: "hello", info: { gpu: "nvidia" } });
    const [h1, c1] = relay.encodeMessage({ kind: "reply", id: "1", status: 200 }, "one");
    const [h2, c2] = relay.encodeMessage({ kind: "reply", id: "2", status: 404 }, utf8("two"));
    expect(asm.push(h1)).toBeNull();
    expect(new TextDecoder().decode(asm.push(c1)!.body)).toBe("one");
    expect(asm.push(h2)).toBeNull();
    const m = asm.push((c2 as Uint8Array).slice().buffer as ArrayBuffer)!; // an ArrayBuffer, as a WebSocket delivers
    expect([m.header, new TextDecoder().decode(m.body)]).toEqual([{ kind: "reply", id: "2", status: 404 }, "two"]);
  });

  it("refuses frames out of order", () => {
    expect(() => new relay.Assembler().push(new Uint8Array([1]))).toThrow(relay.ProtocolError);
    const asm = new relay.Assembler();
    asm.push(JSON.stringify({ kind: "reply", id: "x", status: 200, chunks: 1 }));
    expect(() => asm.push(JSON.stringify({ kind: "hello", info: {} }))).toThrow(/before the previous/);
    expect(() => new relay.Assembler().push("not json")).toThrow(/not JSON/);
  });

  it("reads control results", () => {
    expect(relay.controlResult(200, utf8('{"a":1}'))).toEqual({ ok: true, data: { a: 1 } });
    expect(relay.controlResult(500, utf8("downloading"))).toEqual({ ok: false, message: "downloading" });
    expect(relay.controlResult(200, utf8("nope"))).toMatchObject({ ok: false });
  });
});
