// Development bundles for testing setup without a release (design §6): builds the Worker bundle from
// this checkout (packages/worker/build-bundle.mjs) into site/dev/<tag>/, with source.tar.gz (the
// Modal app's source at HEAD, which a Worker's Modal Sandbox deploys, as GitHub's tag tarball
// serves a release's), and names it in site/dev/latest.txt. Deployed with the setup Worker's static files; a setup Worker whose
// COMFY_GEN_RELEASES is https://<its host>/dev creates Workers from these, and those Workers update
// from the next one. site/dev/ is not committed.
// Usage: node packages/setup/build-dev.mjs v9.0.0   (web/dist must be built). A plain version:
// Workers only update between those, so number dev bundles past the real releases.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("usage: build-dev.mjs vX.Y.Z");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
execFileSync("node", [join(root, "packages/worker/build-bundle.mjs"), tag], { stdio: "inherit" });
const out = join(root, "site/dev", tag);
mkdirSync(out, { recursive: true });
for (const f of ["worker-bundle.js", "worker-assets.json", "worker-manifest.json"]) copyFileSync(join(root, "packages/worker/dist-release", f), join(out, f));
execFileSync("git", ["archive", "--format=tar.gz", "--prefix=comfy-gen/", "-o", join(out, "source.tar.gz"), "HEAD", "pyproject.toml", "uv.lock", "packages/modal_app"], { cwd: root });
writeFileSync(join(root, "site/dev/latest.txt"), tag + "\n");
console.log(`site/dev/${tag}/ and latest.txt`);
