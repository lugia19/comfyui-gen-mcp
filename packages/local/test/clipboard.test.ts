import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { firstFileUri, parseAppleData, readClipboardImage } from "../src/clipboard.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/** A PATH holding a fake clipboard tool that answers *answers* by requested type. */
function fakeTool(name: string, answers: Record<string, Buffer | string>): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "clip-"));
  for (const [type, body] of Object.entries(answers)) writeFileSync(join(dir, type.replace("/", "_")), body);
  writeFileSync(
    join(dir, name),
    `#!/bin/sh\nfor a in "$@"; do t="$a"; done\n` + // xclip: -t TYPE -o; wl-paste: --type TYPE
      `for a in "$@"; do case "$prev" in -t|--type) t="$a";; esac; prev="$a"; done\n` +
      `f="${dir}/$(echo "$t" | tr / _)"\n[ -f "$f" ] && cat "$f" && exit 0\nexit 1\n`,
  );
  chmodSync(join(dir, name), 0o755);
  return { PATH: `${dir}:${process.env.PATH}` };
}

describe("clipboard", () => {
  it("parses osascript data and uri lists", () => {
    expect(parseAppleData("«data PNGf89504E47»")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(parseAppleData("")).toBeNull();
    expect(firstFileUri("# comment\r\nfile:///tmp/a%20b.png\r\n")).toBe("/tmp/a b.png");
    expect(firstFileUri("https://x")).toBeNull();
  });

  it.runIf(process.platform === "linux")("reads image data through xclip, a copied file first", async () => {
    expect(await readClipboardImage("linux", fakeTool("xclip", { "image/png": PNG }))).toEqual(PNG);
    const file = join(mkdtempSync(join(tmpdir(), "clipf-")), "copied.png");
    writeFileSync(file, PNG);
    const env = fakeTool("xclip", { "text/uri-list": pathToFileURL(file).href + "\n", "image/png": Buffer.from("other") });
    expect(await readClipboardImage("linux", env)).toEqual(PNG);
    expect(await readClipboardImage("linux", fakeTool("xclip", {}))).toBeNull();
  });

  it.runIf(process.platform === "linux")("uses wl-paste on Wayland", async () => {
    const env = { ...fakeTool("wl-paste", { "image/png": PNG }), WAYLAND_DISPLAY: "wayland-0" };
    expect(await readClipboardImage("linux", env)).toEqual(PNG);
  });
});
