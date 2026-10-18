// The built-in packs, in file-name order (group order, defaults and the tool list follow it).
// test/workflow-packs.test.ts checks every JSON file here is listed.

import tools from "./tools.json" with { type: "json" };
import anima from "./anima.json" with { type: "json" };
import anima_turbo from "./anima_turbo.json" with { type: "json" };
import flux2klein from "./flux2klein.json" with { type: "json" };
import flux2klein_9b from "./flux2klein_9b.json" with { type: "json" };
import flux2klein_9b_edit from "./flux2klein_9b_edit.json" with { type: "json" };
import flux2klein_edit from "./flux2klein_edit.json" with { type: "json" };
import krea2_turbo from "./krea2_turbo.json" with { type: "json" };
import qwen_image_21 from "./qwen_image_21.json" with { type: "json" };
import qwen_image_21_edit from "./qwen_image_21_edit.json" with { type: "json" };
import z_image_turbo from "./z_image_turbo.json" with { type: "json" };

/** The tools packs back: each one's title on the settings page, the line that routes between them
 * (illustration or photo), and the prompting guide for packs without their own. */
export const TOOL_FILE: unknown = tools;

export const PACK_FILES: [string, unknown][] = [
  ["anima.json", anima],
  ["anima_turbo.json", anima_turbo],
  ["flux2klein.json", flux2klein],
  ["flux2klein_9b.json", flux2klein_9b],
  ["flux2klein_9b_edit.json", flux2klein_9b_edit],
  ["flux2klein_edit.json", flux2klein_edit],
  ["krea2_turbo.json", krea2_turbo],
  ["qwen_image_21.json", qwen_image_21],
  ["qwen_image_21_edit.json", qwen_image_21_edit],
  ["z_image_turbo.json", z_image_turbo],
];
