// Builds the tray helper into dist/, one file per platform, named as the release assets the bundle
// downloads (packages/mcpb/build.mjs pins their hashes, so build these first). Needs Go; the macOS
// one needs cgo (Cocoa), so it builds only on a Mac. Linux and Windows cross-compile anywhere.
// Usage: node packages/tray/build.mjs [linux|windows|macos …]   (none: every one this computer can build)

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const asked = process.argv.slice(2);
const dist = join(here, "dist");

// platform: [GOOS, GOARCH, file, cgo]
const TARGETS = {
  windows: ["windows", "amd64", "comfy-gen-tray-windows.exe", false],
  linux: ["linux", "amd64", "comfy-gen-tray-linux", false],
  macos: ["darwin", "arm64", "comfy-gen-tray-macos", true],
};

const platforms = asked.length ? asked : Object.keys(TARGETS).filter((k) => !TARGETS[k][3] || process.platform === "darwin");
mkdirSync(dist, { recursive: true });
for (const platform of platforms) {
  if (!TARGETS[platform]) throw new Error(`unknown platform ${platform} (linux, windows, macos)`);
  const [goos, goarch, name, cgo] = TARGETS[platform];
  if (cgo && process.platform !== "darwin") throw new Error(`the ${platform} tray helper builds only on a Mac`);
  // windowsgui: no console window.
  const ldflags = `-s -w${goos === "windows" ? " -H windowsgui" : ""}`;
  const out = join(dist, name);
  rmSync(out, { force: true });
  execFileSync("go", ["build", "-trimpath", "-ldflags", ldflags, "-o", out, "."], {
    cwd: here,
    stdio: "inherit",
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: cgo ? "1" : "0" },
  });
  console.log(`built ${name} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
}
