import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { freePort, loadConfig, paths, saveConfig } from "@comfy-gen/local";
import { main } from "../src/main.ts";

/** One extension process: main() over in-memory stdio. */
function proc(home: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const replies = new Map<number, (msg: any) => void>();
  let buf = "";
  stdout.on("data", (d) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.get(msg.id)?.(msg);
    }
  });
  let exited = false;
  let id = 0;
  const started = main({ version: "t", waitExtension: "", web: () => null, paths: paths({ COMFY_GEN_HOME: home }), stdin, stdout, exit: () => (exited = true) });
  const rpc = (method: string) =>
    new Promise<any>((resolve) => {
      const i = ++id;
      replies.set(i, resolve);
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method }) + "\n");
    });
  return { started, rpc, stdin, stdout, exited: () => exited };
}

describe("bind or relay", () => {
  it("relays to the owner and takes over when it goes", async () => {
    const home = mkdtempSync(join(tmpdir(), "main-"));
    const p = paths({ COMFY_GEN_HOME: home });
    saveConfig(p.config, { ...loadConfig(p.config), mcp_port: await freePort() });
    const a = proc(home);
    await a.started;
    const b = proc(home);
    await b.started;
    const tools = await b.rpc("tools/list"); // B relays to A
    expect(tools.result.tools.length).toBeGreaterThan(0);

    a.stdin.end(); // A exits: it closes its server
    for (let i = 0; i < 50 && !a.exited(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(a.exited()).toBe(true);
    expect((await b.rpc("ping")).result).toEqual({}); // B took over
    const c = proc(home);
    await c.started;
    expect((await c.rpc("ping")).result).toEqual({}); // and C relays to B
    c.stdin.end();
    b.stdin.end();
  });
});

