// Builds the launcher for each release platform into dist/, embedding the shim that
// packages/mcpb/build.mjs left in packages/mcpb/dist/shim.mjs (run that first). Needs Go.
// Usage: node packages/launcher/build.mjs [vX.Y.Z]
//
// The macOS one is zipped: a browser saves a bare download without its executable bit, so Finder
// would not run it, while Archive Utility keeps the mode stored in the zip.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const tag = process.argv[2] || "dev";
const dist = join(here, "dist");

// [GOOS, GOARCH, file, zipped as]
const TARGETS = [
  ["windows", "amd64", "comfy-gen-agent-windows.exe"],
  ["darwin", "arm64", "comfy-gen-agent", "comfy-gen-agent-macos.zip"],
  ["linux", "amd64", "comfy-gen-agent-linux"],
];

/** A zip holding one executable file (mode 0755, stored as made on Unix). */
function zipOne(name, data) {
  const packed = deflateRawSync(data, { level: 9 });
  const fname = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(0x21, 12); // date: 1980-01-01, for reproducible output
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fname.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode below counts
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fname.length, 28);
  central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
  const offset = local.length + fname.length + packed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fname.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, fname, packed, central, fname, end]);
}

copyFileSync(join(here, "..", "mcpb", "dist", "shim.mjs"), join(here, "shim.mjs"));
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
for (const [goos, goarch, name, zipped] of TARGETS) {
  // windowsgui: no console window; Node runs hidden under it.
  const ldflags = `-s -w -X main.version=${tag}${goos === "windows" ? " -H windowsgui" : ""}`;
  const out = join(dist, name);
  execFileSync("go", ["build", "-trimpath", "-ldflags", ldflags, "-o", out, "."], {
    cwd: here,
    stdio: "inherit",
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
  });
  if (zipped) {
    writeFileSync(join(dist, zipped), zipOne(name, readFileSync(out)));
    rmSync(out);
  }
  const file = zipped ?? name;
  console.log(`built ${file} (${(statSync(join(dist, file)).size / 1e6).toFixed(1)} MB)`);
}
