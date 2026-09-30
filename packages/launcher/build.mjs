// Builds the launcher for each release platform into dist/, embedding the shim that
// packages/mcpb/build.mjs left in packages/mcpb/dist/shim.mjs (run that first). Needs Go.
// Usage: node packages/launcher/build.mjs [vX.Y.Z]

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tag = process.argv[2] || "dev";
const dist = join(here, "dist");

const TARGETS = [
  ["windows", "amd64", "comfy-gen-agent-windows-x64.exe"],
  ["darwin", "arm64", "comfy-gen-agent-macos-arm64"],
  ["darwin", "amd64", "comfy-gen-agent-macos-x64"],
  ["linux", "amd64", "comfy-gen-agent-linux-x64"],
];

copyFileSync(join(here, "..", "mcpb", "dist", "shim.mjs"), join(here, "shim.mjs"));
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
for (const [goos, goarch, name] of TARGETS) {
  // windowsgui: no console window; Node runs hidden under it.
  const ldflags = `-s -w -X main.version=${tag}${goos === "windows" ? " -H windowsgui" : ""}`;
  execFileSync("go", ["build", "-trimpath", "-ldflags", ldflags, "-o", join(dist, name), "."], {
    cwd: here,
    stdio: "inherit",
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
  });
  console.log(`built ${name} (${(statSync(join(dist, name)).size / 1e6).toFixed(1)} MB)`);
}
