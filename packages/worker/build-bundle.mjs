// Builds the Worker for the API path (design §6, "Setup without a repository") into dist-release/:
//   worker-bundle.js      the bundled module (wrangler's own bundling, no deploy)
//   worker-assets.json    the settings app's files: {hash: base64 content}
//   worker-manifest.json  everything else an upload needs, read from wrangler.jsonc (core cfapi
//                         WorkerManifest): bindings, migrations, assets config and files, crons
// The setup Worker creates a Worker from these; a Worker updates itself from a newer release's.
// Usage: node packages/worker/build-bundle.mjs [vX.Y.Z]   (web/dist must be built)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";

const here = dirname(fileURLToPath(import.meta.url));
const version = process.argv[2] || "dev";
const out = join(here, "dist-release");
const web = join(here, "..", "..", "web", "dist");

// wrangler.jsonc as wrangler itself reads it (comments, and "/*" inside strings).
const cfg = experimental_readRawConfig({ config: join(here, "wrangler.jsonc") }).rawConfig;

// The module, bundled exactly as `wrangler deploy` would.
const tmp = mkdtempSync(join(tmpdir(), "comfy-gen-bundle-"));
execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", tmp], { cwd: here, stdio: ["ignore", "ignore", "inherit"] });
const module = readFileSync(join(tmp, "index.js"));
rmSync(tmp, { recursive: true, force: true });

// Static assets. _headers isn't a file to serve: wrangler passes its text in the assets config.
const files = {};
const content = {};
let headers = null;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (dir === web && name === "_headers") headers = readFileSync(path, "utf8");
    else {
      const data = readFileSync(path);
      const b64 = data.toString("base64");
      // Content-addressed, as wrangler does (base64 plus extension, 32 hex characters).
      const hash = createHash("sha256").update(b64 + extname(name).slice(1)).digest("hex").slice(0, 32);
      files["/" + relative(web, path).split("\\").join("/")] = { hash, size: data.length };
      content[hash] = b64;
    }
  }
};
walk(web);

const { directory: _dir, binding, ...assetConfig } = cfg.assets;
const manifest = {
  version,
  module: { name: "index.js", sha256: createHash("sha256").update(module).digest("hex"), size: module.length },
  compatibility_date: cfg.compatibility_date,
  compatibility_flags: cfg.compatibility_flags ?? [],
  durable_objects: cfg.durable_objects.bindings.map(({ name, class_name }) => ({ name, class_name })),
  migrations: cfg.migrations,
  r2_binding: cfg.r2_buckets[0].binding,
  assets: { binding, config: { ...assetConfig, ...(headers ? { _headers: headers } : {}) }, files },
  crons: cfg.triggers?.crons ?? [],
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "worker-bundle.js"), module);
writeFileSync(join(out, "worker-assets.json"), JSON.stringify(content));
writeFileSync(join(out, "worker-manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`worker ${version}: module ${module.length} bytes, ${Object.keys(files).length} assets -> ${relative(process.cwd(), out)}`);
