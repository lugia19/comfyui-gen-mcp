import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";

// build-bundle.mjs turns wrangler.jsonc into the release's worker-manifest.json (core cfapi
// WorkerManifest): what it reads must be there, in the shape it expects.
describe("wrangler.jsonc, as the release's Worker manifest reads it", () => {
  const cfg: any = experimental_readRawConfig({ config: join(import.meta.dirname, "..", "wrangler.jsonc") }).rawConfig;

  it("has the bindings, migrations, assets and crons the manifest carries", () => {
    expect(cfg.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cfg.durable_objects.bindings.map((b: any) => b.class_name).sort()).toEqual(["Relay", "State"]);
    expect(cfg.r2_buckets).toHaveLength(1);
    expect(cfg.assets.binding).toBe("ASSETS");
    expect(cfg.triggers.crons.length).toBeGreaterThan(0);
  });

  it("migrations are new_sqlite_classes steps with unique tags, every DO class created by one", () => {
    const tags = cfg.migrations.map((m: any) => m.tag);
    expect(new Set(tags).size).toBe(tags.length);
    const created = cfg.migrations.flatMap((m: any) => m.new_sqlite_classes ?? []);
    for (const b of cfg.durable_objects.bindings) expect(created).toContain(b.class_name);
    // Only steps cfapi.versionMetadata knows to send; a rename or delete step needs it taught first.
    for (const m of cfg.migrations) expect(Object.keys(m).sort()).toEqual(["new_sqlite_classes", "tag"]);
  });
});
