// The built-in packs, in file-name order (group order, defaults and the tool list follow it).
// test/workflow-packs.test.ts checks every JSON file here is listed.

import anima from "./anima.json" with { type: "json" };
import anima_turbo from "./anima_turbo.json" with { type: "json" };
import flux2klein from "./flux2klein.json" with { type: "json" };
import flux2klein_9b from "./flux2klein_9b.json" with { type: "json" };
import flux2klein_9b_edit from "./flux2klein_9b_edit.json" with { type: "json" };
import flux2klein_edit from "./flux2klein_edit.json" with { type: "json" };
import z_image_turbo from "./z_image_turbo.json" with { type: "json" };

export const PACK_FILES: [string, unknown][] = [
  ["anima.json", anima],
  ["anima_turbo.json", anima_turbo],
  ["flux2klein.json", flux2klein],
  ["flux2klein_9b.json", flux2klein_9b],
  ["flux2klein_9b_edit.json", flux2klein_9b_edit],
  ["flux2klein_edit.json", flux2klein_edit],
  ["z_image_turbo.json", z_image_turbo],
];
