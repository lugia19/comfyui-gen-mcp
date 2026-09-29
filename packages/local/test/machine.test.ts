import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchFile } from "../src/fetchfile.ts";
import { comfyDir, torchBackend } from "../src/install.ts";
import { freePort, portFree } from "../src/comfyui.ts";
import { run } from "../src/proc.ts";
import { uvTarget } from "../src/uv.ts";
import { mkdirSync, writeFileSync } from "node:fs";

const dir = () => mkdtempSync(join(tmpdir(), "machine-"));

function serve(body: Buffer): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      if (req.url === "/missing") return res.writeHead(404).end();
      res.writeHead(200, { "Content-Length": body.length }).end(body);
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });
}

describe("fetchFile", () => {
  const body = Buffer.from("model bytes ".repeat(10000));
  const sha = createHash("sha256").update(body).digest("hex");

  it("downloads and checks size and SHA-256", async () => {
    const srv = await serve(body);
    const dest = join(dir(), "sub", "m.bin");
    const seen: number[] = [];
    expect(await fetchFile(`${srv.url}/m`, dest, { sha256: sha, size: body.length, onProgress: (d) => seen.push(d) })).toBe(sha);
    expect(readFileSync(dest)).toEqual(body);
    expect(seen.at(-1)).toBe(body.length);
    srv.close();
  });

  it("leaves nothing behind on a mismatch or an HTTP error", async () => {
    const srv = await serve(body);
    const dest = join(dir(), "m.bin");
    await expect(fetchFile(`${srv.url}/m`, dest, { sha256: "0".repeat(64) })).rejects.toThrow(/checksum/);
    await expect(fetchFile(`${srv.url}/m`, dest, { size: 5 })).rejects.toThrow(/expected 5/);
    await expect(fetchFile(`${srv.url}/missing`, dest)).rejects.toThrow(/404/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
    srv.close();
  });
});

describe("machine helpers", () => {
  it("maps platforms to uv release targets", () => {
    expect(uvTarget("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(uvTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(uvTarget("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(uvTarget("linux", "ia32")).toBeNull();
  });

  it("picks the PyTorch backend per GPU kind", () => {
    expect(torchBackend("cpu")).toBe("cpu");
    expect(torchBackend("nvidia")).toBe("auto");
    expect(torchBackend("intel")).toBe("xpu");
  });

  it("finds ComfyUI in a workspace or nested in it", () => {
    const ws = dir();
    expect(comfyDir(ws)).toBeNull();
    mkdirSync(join(ws, "ComfyUI", "models"), { recursive: true });
    writeFileSync(join(ws, "ComfyUI", "main.py"), "");
    expect(comfyDir(ws)).toBe(join(ws, "ComfyUI"));
  });

  it("probes ports with a real bind", async () => {
    const port = await freePort();
    expect(await portFree(port)).toBe(true);
    const srv = createServer().listen(port, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    expect(await portFree(port)).toBe(false);
    srv.close();
  });

  it("runs commands, reporting lines and a missing binary", async () => {
    const lines: string[] = [];
    const r = await run(process.execPath, ["-e", "console.log('a'); console.error('b'); process.exit(3)"], { onLine: (l) => lines.push(l) });
    expect(r.code).toBe(3);
    expect(lines.sort()).toEqual(["a", "b"]);
    expect((await run("no-such-binary-xyz", [])).code).toBeNull();
  });
});
