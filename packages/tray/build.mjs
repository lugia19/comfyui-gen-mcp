// Builds the tray helper into dist/, one file per platform, then packs every helper in dist/ into
// dist/comfy-gen-tray.tgz: the one release asset, from which the bundle extracts its platform's
// (packages/mcpb/build.mjs pins the hashes, so build these first). Needs Go; the macOS one needs cgo
// (Cocoa), so it builds only on a Mac, and the release brings it over before packing. Linux and
// Windows cross-compile anywhere.
// Usage: node packages/tray/build.mjs [linux|windows|macos …]   (none: every one this computer can build)

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const asked = process.argv.slice(2);
const dist = join(here, "dist");

const ARCHIVE = "comfy-gen-tray.tgz";

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

// The archive: every helper in dist/, flat, with its mode (so the Unix ones stay executable).
const helpers = Object.values(TARGETS).map((t) => t[2]).filter((name) => existsSync(join(dist, name)));
for (const name of helpers) chmodSync(join(dist, name), 0o755);
rmSync(join(dist, ARCHIVE), { force: true });
execFileSync("tar", ["-czf", ARCHIVE, ...helpers], { cwd: dist, stdio: "inherit" });
console.log(`packed ${ARCHIVE} (${(statSync(join(dist, ARCHIVE)).size / 1e6).toFixed(1)} MB): ${helpers.join(", ")}`);
