// Builds the local artifacts into dist/:
//   comfy-gen.mjs       the bundle (the extension's server and the PC agent), a release asset the
//                       shim downloads
//   Comfy-Gen-MCP.mcpb  the extension: shim, manifest, icon, and this release's bundle
//   shim.mjs            the shim alone, which the launcher embeds
// Usage: node packages/mcpb/build.mjs [vX.Y.Z]   (default "dev"; web/dist must be built)

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const tag = process.argv[2] || "dev";
const version = tag.replace(/^v/, "");
const dist = join(here, "dist");
const stage = join(dist, "mcpb");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

function walk(dir) {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
}

// The comfy-gen:* modules bundle.ts imports.
const embedded = {
  name: "comfy-gen-embedded",
  setup(b) {
    b.onResolve({ filter: /^comfy-gen:/ }, (args) => ({ path: args.path, namespace: "comfy-gen" }));
    b.onLoad({ filter: /.*/, namespace: "comfy-gen" }, (args) => {
      if (args.path === "comfy-gen:web") {
        const webDist = join(root, "web", "dist");
        const files = Object.fromEntries(walk(webDist).map((f) => [
          "/" + relative(webDist, f).split("\\").join("/"),
          { type: TYPES[extname(f)] ?? "application/octet-stream", body: readFileSync(f).toString("base64") },
        ]));
        return { contents: `export default ${JSON.stringify(files)};`, loader: "js" };
      }
      if (args.path === "comfy-gen:wait-extension") {
        const src = readFileSync(join(root, "packages/modal_app/src/comfy_gen_modal/comfy_node/__init__.py"), "utf8");
        return { contents: `export default ${JSON.stringify(src)};`, loader: "js" };
      }
      if (args.path === "comfy-gen:icons") {
        // Tray icons by state color (assets/make_tray_icons.py): .ico for Windows, .png elsewhere.
        const ext = (f) => readFileSync(join(here, "assets", f)).toString("base64");
        const icons = Object.fromEntries(["yellow", "green", "red"].map((c) => [c, { ico: ext(`tray-${c}.ico`), png: ext(`tray-${c}.png`) }]));
        return { contents: `export default ${JSON.stringify(icons)};`, loader: "js" };
      }
    });
  },
};

const common = { bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "none", logLevel: "warning" };

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });

const bundleOut = join(dist, "comfy-gen.mjs");
await build({
  ...common,
  entryPoints: [join(here, "src", "bundle.ts")],
  outfile: bundleOut,
  plugins: [embedded],
  define: { __VERSION__: JSON.stringify(tag) },
  // Some dependencies' CommonJS paths call require(); give the ESM bundle one.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});

await build({ ...common, entryPoints: [join(here, "src", "shim.ts")], outfile: join(stage, "server", "shim.mjs") });
cpSync(join(stage, "server", "shim.mjs"), join(dist, "shim.mjs"));
if (tag !== "dev") {
  mkdirSync(join(stage, "server", "bundle", tag), { recursive: true });
  cpSync(bundleOut, join(stage, "server", "bundle", tag, "comfy-gen.mjs"));
}
cpSync(join(here, "assets", "icon.png"), join(stage, "icon.png"));
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
manifest.version = tag === "dev" ? "0.0.0-dev" : version;
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// The packer is a pinned devDependency (npm ci installs it): nothing is fetched at build time.
execFileSync("npx", ["--no", "mcpb", "pack", stage, join(dist, "Comfy-Gen-MCP.mcpb")], { stdio: "inherit", shell: process.platform === "win32" });
console.log(`built ${tag}: ${relative(root, bundleOut)} (${(statSync(bundleOut).size / 1e6).toFixed(2)} MB), ${relative(root, join(dist, "Comfy-Gen-MCP.mcpb"))}`);
