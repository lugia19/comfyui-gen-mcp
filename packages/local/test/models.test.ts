import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverModelSources, ModelLocator } from "../src/discover.ts";
import { canonPath, findModel, parseExtraModelPaths, publish, writeExtraModelPaths } from "../src/models.ts";

const dir = () => mkdtempSync(join(tmpdir(), "models-"));
const mk = (...parts: string[]) => {
  const p = join(...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
/** A ComfyUI folder with a models folder holding *subs*. */
const comfy = (path: string, subs: string[] = ["checkpoints"]) => {
  mk(path);
  writeFileSync(join(path, "main.py"), "");
  for (const s of subs) mk(path, "models", s);
  return path;
};

describe("registry", () => {
  it("names and writes the entry as the old Python registry did", () => {
    const root = join(dir(), "installs");
    publish("/opt/x", "/opt/x/models", ["/vn/models"], root);
    const name = "comfy-gen-mcp-" + createHash("sha1").update(canonPath("/opt/x")).digest("hex").slice(0, 8) + ".json";
    expect(readdirSync(root)).toEqual([name]);
    const entry = JSON.parse(readFileSync(join(root, name), "utf8"));
    expect(entry).toMatchObject({ app: "comfy-gen-mcp", install_path: "/opt/x", models_dir: "/opt/x/models", sees: ["/vn/models"] });
    expect(entry.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
  });
});

describe("extra_model_paths.yaml", () => {
  it("parses ComfyUI's format: base_path, relative paths, block lists, comments", () => {
    const d = dir();
    const drive = dir();
    mk(drive, "Lora");
    mk(drive, "LyCORIS");
    mk(drive, "Stable-diffusion");
    mk(d, "rel", "vae");
    const yaml = `# a comment
a111:
    base_path: ${drive}
    checkpoints: Stable-diffusion   # trailing comment
    loras: |
        Lora
        LyCORIS
    missing: nowhere
    is_default: true
other:
    base_path: rel
    vae: vae
    custom_nodes: custom_nodes
`;
    const [a, b] = parseExtraModelPaths(yaml, d);
    expect(a).toEqual({ checkpoints: [join(drive, "Stable-diffusion")], loras: [join(drive, "Lora"), join(drive, "LyCORIS")] });
    expect(b).toEqual({ vae: [join(d, "rel", "vae")] });
  });

  it("writes one section per source, and reads back the same", () => {
    const d = dir();
    const x = mk(dir(), "loras");
    const y = mk(dir(), "unet");
    writeExtraModelPaths(d, [{ loras: [x] }, {}, { unet: [y], loras: [x] }]);
    const text = readFileSync(join(d, "extra_model_paths.yaml"), "utf8");
    expect(parseExtraModelPaths(text, d)).toEqual([{ loras: [x] }, { unet: [y], loras: [x] }]);
    writeExtraModelPaths(d, []);
    expect(existsSync(join(d, "extra_model_paths.yaml"))).toBe(false);
  });

  it("finds models under ComfyUI's aliases too", () => {
    const unet = mk(dir(), "unet");
    writeFileSync(join(unet, "m.gguf"), "");
    expect(findModel({ unet: [unet] }, "diffusion_models", "m.gguf")).toBe(join(unet, "m.gguf"));
    expect(findModel({ unet: [unet] }, "vae", "m.gguf")).toBeNull();
  });
});

describe("discovery", () => {
  it("finds other installs, their extra folders, the Desktop app and registry entries, never ours", () => {
    const home = dir();
    const registry = mk(home, ".comfy-registry", "installs");
    // ours, which a scan of home would also find
    const ours = comfy(join(home, ".comfy-gen-mcp", "comfyui"), ["loras"]);
    // comfy-cli, through its config
    const cli = comfy(join(home, "work", "cli-comfy"), ["vae"]);
    mk(home, ".config", "comfy-cli");
    writeFileSync(join(home, ".config", "comfy-cli", "config.ini"), `[DEFAULT]\ndefault_workspace = ${cli}\n`);
    // a portable build found by the scan, whose yaml names a big model drive
    const portable = comfy(join(home, "Downloads", "ComfyUI_windows_portable", "ComfyUI"), ["checkpoints"]);
    const drive = mk(dir(), "models", "diffusion_models");
    writeFileSync(join(portable, "extra_model_paths.yaml"), `big:\n    diffusion_models: ${drive}\n    loras: ${join(ours, "models", "loras")}\n`);
    // the Desktop app
    const desktopBase = mk(dir(), "desktop");
    mk(desktopBase, "models", "loras");
    mk(home, ".config", "ComfyUI");
    writeFileSync(join(home, ".config", "ComfyUI", "config.json"), JSON.stringify({ basePath: desktopBase }));
    // Visual-Novelist, through the registry (a models folder whose install has no main.py here)
    const vn = mk(dir(), "vn", "models", "text_encoders");
    writeFileSync(join(registry, "visual-novelist-1.json"), JSON.stringify({ app: "visual-novelist", install_path: "/gone", models_dir: join(vn, "..") }));
    writeFileSync(join(registry, "comfy-gen-mcp-2.json"), JSON.stringify({ app: "comfy-gen-mcp", install_path: ours, models_dir: join(ours, "models") }));
    const extra = mk(dir(), "extra", "vae");

    const sources = discoverModelSources({ models: join(ours, "models"), comfy: ours }, join(extra, ".."), { home, platform: "linux", env: {}, registry });
    const all = sources.flatMap((s) => Object.values(s.folders).flat());
    expect(all).toContain(join(extra));
    expect(all).toContain(join(vn));
    expect(all).toContain(join(cli, "models", "vae"));
    expect(all).toContain(join(portable, "models", "checkpoints"));
    expect(all).toContain(drive);
    expect(all).toContain(join(desktopBase, "models", "loras"));
    expect(all.some((d) => d.startsWith(ours))).toBe(false); // ours, even through another's yaml
    expect(sources[0].from).toBe("your extra models folder");
    expect(sources.find((s) => s.folders.diffusion_models)?.from).toContain("extra_model_paths.yaml");

    const locator = new ModelLocator(() => ({ models: join(ours, "models"), comfy: ours }), () => "", { home, platform: "linux", env: {}, registry });
    const folders = locator.folders();
    expect(folders.loras[0]).toBe(join(ours, "models", "loras")); // ours first
    expect(folders.diffusion_models).toContain(drive);
  });
});
