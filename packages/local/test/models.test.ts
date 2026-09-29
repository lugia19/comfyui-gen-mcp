import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonPath, findModel, publish, sharedModelDirs, writeExtraModelPaths } from "../src/models.ts";

const dir = () => mkdtempSync(join(tmpdir(), "models-"));

describe("registry", () => {
  it("publishes an entry the other apps read, and reads theirs", () => {
    const root = join(dir(), "installs");
    const base = dir();
    const ours = join(base, "ours", "models");
    const vn = join(base, "vn", "models");
    mkdirSync(ours, { recursive: true });
    mkdirSync(vn, { recursive: true });
    publish(join(base, "ours"), ours, [vn], root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "visual-novelist-12345678.json"), JSON.stringify({ app: "visual-novelist", models_dir: vn }));
    writeFileSync(join(root, "gone-00000000.json"), JSON.stringify({ models_dir: join(base, "gone") }));
    writeFileSync(join(root, "broken.json"), "{");

    const [name] = readdirSync(root).filter((n) => n.startsWith("comfy-gen-mcp-"));
    expect(name).toMatch(/^comfy-gen-mcp-[0-9a-f]{8}\.json$/);
    const entry = JSON.parse(readFileSync(join(root, name), "utf8"));
    expect(entry).toMatchObject({ app: "comfy-gen-mcp", install_path: join(base, "ours"), models_dir: ours, sees: [vn] });
    expect(entry.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);

    const extra = join(base, "extra");
    mkdirSync(extra);
    expect(sharedModelDirs(ours, extra, root)).toEqual([vn, extra]); // own excluded, missing skipped
    expect(sharedModelDirs(ours, vn, root)).toEqual([vn]); // deduplicated
  });

  it("names the entry as the old Python registry did", () => {
    // sha1 of the canonical install path, first 8 hex digits
    const root = join(dir(), "installs");
    publish("/opt/x", "/opt/x/models", [], root);
    expect(readdirSync(root)).toEqual(["comfy-gen-mcp-" + createHash("sha1").update(canonPath("/opt/x")).digest("hex").slice(0, 8) + ".json"]);
  });
});

describe("extra_model_paths.yaml", () => {
  it("lists every shared folder with the standard subfolders, quoted", () => {
    const d = dir();
    writeExtraModelPaths(d, ["/a/models", "C:\\Users\\me\\ComfyUI\\models"]);
    const yaml = readFileSync(join(d, "extra_model_paths.yaml"), "utf8");
    expect(yaml).toContain('shared-1:\n    base_path: "/a/models"\n    checkpoints: checkpoints\n');
    expect(yaml).toContain('shared-2:\n    base_path: "C:\\\\Users\\\\me\\\\ComfyUI\\\\models"\n');
    expect(yaml).toContain("    loras: loras\n");
    writeExtraModelPaths(d, []);
    expect(existsSync(join(d, "extra_model_paths.yaml"))).toBe(false);
  });

  it("finds a model in any folder, ours first", () => {
    const a = dir();
    const b = dir();
    mkdirSync(join(b, "vae"));
    writeFileSync(join(b, "vae", "x.safetensors"), "");
    expect(findModel([a, b], "vae", "x.safetensors")).toBe(join(b, "vae", "x.safetensors"));
    expect(findModel([a], "vae", "x.safetensors")).toBeNull();
  });
});
