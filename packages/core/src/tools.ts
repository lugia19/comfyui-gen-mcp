// The MCP tool list: names, descriptions, input schemas.
//
// Computed from packs and config alone (no generator, no server), because the MCPB's stdio shim
// must answer tools/list before its local server is up.
//
// Two image modes, because the two brains see images differently:
//   "paths"  MCPB. Claude Desktop runs on the same machine, so edit_image takes local paths.
//   "refs"   Worker. Claude never sees a filesystem: images are opaque ids, and attached images
//            come in through request_upload and the code-execution sandbox.

import type { Config } from "./config.ts";
import { canRedraw, family, groupByTool, packLoras, REDRAW_STYLES, select, TOOLS, type Pack } from "./packs.ts";

export type ImageMode = "paths" | "refs";
export type ToolSpec = { name: string; description: string; inputSchema: Record<string, any> };

const ASPECT_PROP = {
  type: "string",
  enum: ["square", "portrait", "landscape", "tall", "wide"],
  default: "square",
  description: "Image shape: square (1:1), portrait (3:4), landscape (4:3), tall (9:16), wide (16:9).",
};

const BACKGROUND_PROP = {
  type: "boolean",
  default: false,
  description:
    "true for a transparent background (stickers, sprites, cut-outs), only when the user wants one. " +
    "Then ask for a plain grey or coloured background in the prompt, not white: white parts of the " +
    "subject would turn transparent too. Editing a transparent image fills its background in: pass " +
    "this again to keep it transparent.",
};

export const GENERATION_SCHEMA = {
  type: "object",
  properties: { prompt: { type: "string" }, aspect_ratio: ASPECT_PROP, remove_background: BACKGROUND_PROP },
  required: ["prompt"],
};

export const EDIT_SCHEMA_PATHS = {
  type: "object",
  properties: { prompt: { type: "string" }, image_path: { type: "string" }, second_image_path: { type: "string" }, remove_background: BACKGROUND_PROP },
  required: ["prompt", "image_path"],
};

export const EDIT_SCHEMA_REFS = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    image: { type: "string", description: "An image id, or a public https URL." },
    second_image: { type: "string", description: "Optional second image id or https URL." },
    remove_background: BACKGROUND_PROP,
  },
  required: ["prompt", "image"],
};

const REDRAW_PROPS = {
  prompt: { type: "string", description: "The whole image's prompt, with the change written in." },
  box: {
    type: "array",
    items: { type: "number" },
    minItems: 4,
    maxItems: 4,
    description: "[left, top, right, bottom] as fractions (0 to 1) of the image's width and height. Leave it out to redraw the largest face.",
  },
  strength: { type: "number", minimum: 0.3, maximum: 1, default: 0.9, description: "How far the redrawn part may stray from what is there now." },
  style: { type: "string", enum: Object.keys(REDRAW_STYLES), default: "illustrated", description: "The image's style: illustrated (drawn, anime) or realistic (photographic)." },
};

export const REDRAW_SCHEMA_PATHS = {
  type: "object",
  properties: { image_path: { type: "string" }, ...REDRAW_PROPS },
  required: ["prompt", "image_path"],
};

export const REDRAW_SCHEMA_REFS = {
  type: "object",
  properties: { image: { type: "string", description: "An image id, or a public https URL." }, ...REDRAW_PROPS },
  required: ["prompt", "image"],
};

export const FETCH_SCHEMA = {
  type: "object",
  properties: { request_token: { type: "string" } },
  required: ["request_token"],
};

export const UPLOAD_SCHEMA = {
  type: "object",
  properties: {
    filename: { type: "string", description: "Name of the attached file, as it appears in your code execution environment." },
  },
  required: ["filename"],
};

export const FETCH_DESC =
  "Fetch the result of an image generation that is still in progress. " +
  "Use this when a generation tool returns a request_token instead of an image.";

const EDIT_SIZING =
  "Optionally pass a second image as reference material. When using two images, refer to them as " +
  "'image1' and 'image2' in the prompt.\n\n" +
  "The output keeps the size and aspect ratio of the FIRST image (image1): it comes back at the " +
  "resolution it went in at, unless it is very large, in which case it is scaled down to fit the " +
  "model's budget. The second image only serves as reference material. So when combining images " +
  "(e.g. putting image2's subject into image1's scene), pass the one whose framing should be kept " +
  "first.\n\n";

const EDIT_TIPS =
  "Prompting tips:\n" +
  "- Be precise and verbatim when describing desired changes (e.g. 'change the text to say \"Hello World\"')\n" +
  "- For targeted edits, say 'change nothing else' and mention what should stay the same\n" +
  "- Describe what you want the result to look like, not the editing operation";

export const EDIT_DESC_PATHS =
  "Edit an image using a text prompt. " +
  "image_path can be a local file path (e.g. C:/Users/me/photo.png) or a publicly accessible URL. " +
  "Previously generated images return their saved_path; use that.\n\n" +
  "An image the user pasted or attached in the chat cannot be passed directly. Offer two ways:\n" +
  "1. They give you the image file's path on their computer. On Windows: hold Shift, right-click the " +
  "file, 'Copy as path'.\n" +
  "2. You upload it to Litterbox (litterbox.catbox.moe), a temporary public file host, for one hour, " +
  "and pass the returned URL. Before doing this, tell the user plainly that the image will be public " +
  "for that hour to anyone who has or guesses the link, and upload only after they explicitly agree. " +
  "Never offer or use it for anything else. It needs code execution with network access to " +
  "litterbox.catbox.moe (in Claude's settings, the default 'package managers only' blocks it). " +
  "Upload the attached file from the code environment (usually under /mnt/user-data/uploads) with:\n" +
  "curl -sS -F reqtype=fileupload -F time=1h -F fileToUpload=@<file> https://litterbox.catbox.moe/resources/internals/api.php\n" +
  "It prints the image's URL (https://litter.catbox.moe/...); pass that as image_path. If the upload " +
  "fails, say why (most likely the network setting) and ask for the file's path instead.\n\n" +
  EDIT_SIZING +
  EDIT_TIPS;

export const EDIT_DESC_REFS =
  "Edit an image using a text prompt. `image` is an image id or a public https URL. Every image " +
  "these tools return comes with its image id, and request_upload returns one for an image the user " +
  "attached.\n\n" +
  "To edit an image the user attached to the chat, call request_upload with its filename, run the " +
  "code it returns in your code execution environment, and pass the image id it prints. If code " +
  "execution is unavailable, ask the user to enable it (Settings > Capabilities > Code execution " +
  "and file creation) or to give a public URL.\n\n" +
  EDIT_SIZING +
  EDIT_TIPS;

export const UPLOAD_DESC =
  "Get a one-time upload link for an image the user attached to the chat, so edit_image or redraw can " +
  "use it. Returns Python code to run in your code execution environment; it uploads the file and " +
  "prints the image id to pass on. The link expires after 10 minutes, so call this right before the " +
  "edit.";

const REDRAW_BODY =
  "Redraw one part of an image and leave the rest untouched, pixel for pixel: fix a mangled hand or " +
  "face, change an expression, change a small detail. The rest of the image keeps its exact look, " +
  "which edit_image does not promise.\n\n" +
  "box is the area as [left, top, right, bottom] fractions of the image's width and height (0 to 1, " +
  "from the top left); leave it out to redraw the largest face. Measure the box with tooling if you " +
  "can (crop the image or lay a grid over it); otherwise estimate it, erring larger. The area is " +
  "padded and its edge blended, so a loose box works where a tight one may miss.\n\n" +
  "The prompt describes the whole image, not only the area: the model repaints the area to fit the " +
  "picture the prompt describes. If you made the image, reuse its prompt and change only what should " +
  "differ (for another expression, swap the expression tags; for a broken hand, say what the hand is " +
  "doing). Otherwise describe the whole image the way generate_illustrated_image's prompts are " +
  "written.\n\n" +
  "strength is how far the result may stray from what is there: the default 0.9 keeps the pose and " +
  "colours; use 1 for an area that is broken. Look at the result: if the problem is still there, call " +
  "again, with a larger box or another wording. Returns a new image; the original is kept.";

export const REDRAW_DESC_PATHS =
  "image_path is the image's saved_path, a local file path or a public URL, as for edit_image.\n\n" + REDRAW_BODY;

export const REDRAW_DESC_REFS =
  "image is an image id (every image these tools return comes with one; request_upload gives one for " +
  "an image the user attached) or a public https URL.\n\n" + REDRAW_BODY;

// Tools defined here rather than by a generation pack. A pack whose tool_name is one of these (the
// edit packs back edit_image) is data for that tool, not a tool of its own.
export const STATIC_TOOLS = new Set(["edit_image", "fetch_result", "request_upload"]);

// The end of every generation tool's description.
const GENERATION_TAIL =
  "The aspect_ratio parameter controls image shape: square (1:1), portrait (3:4), landscape (4:3), tall (9:16), wide (16:9). Default is square.\n\n" +
  "IMPORTANT: The generated image may not appear inline in the conversation, but it IS sent to the user. Do not assume the generation failed just because you cannot see the image.";

/**
 * Final tool description for a selected generation pack: the tool's routing line, the pack's
 * prompt_guide (else the tool's default_guide), then the shared tail. In the guide, {artist_list}
 * is filled from the configured artists (else the pack's defaults), {lora_triggers} from the
 * configured trigger-gated LoRAs.
 */
export function describe(pack: Pack, cfg: Config): string {
  const key = family(pack);
  const tool = TOOLS[pack.tool_name] ?? { title: pack.tool_name };
  const guide = pack.prompt_guide ?? tool.default_guide ?? "";
  let desc = [tool.description, guide].filter(Boolean).join("\n") + "\n\n" + GENERATION_TAIL;

  if (pack.default_artist_list) {
    let artists: string = cfg.pack_settings?.[key]?.artist_list || pack.default_artist_list;
    const parts = artists.split(",").map((a) => a.trim()).filter(Boolean);
    if (parts.length) artists = `preferred default: ${parts[0]}, others available: ${parts.slice(1).join(", ") || "none"}`;
    desc = desc.replaceAll("{artist_list}", artists);
  }

  // The trigger words of the pack's switched-on, not hidden LoRAs: where the guide asks for them
  // ({lora_triggers}, as Anima's does), else after the guide, for any pack with a LoRA group.
  const triggers: string[] = [];
  for (const e of packLoras(pack, cfg)) {
    if (e.hidden) continue; // hidden: gated, not advertised
    const trig = String(e.trigger || "").trim();
    if (trig && !triggers.includes(trig)) triggers.push(trig);
  }
  const text = triggers.length
    ? "\n\nThe following trigger words will cause a LoRA to be applied to the prompt " +
      "(these can be either artist styles, usually prefixed with @, or concept tags). " +
      "These triggers must be used verbatim: " + triggers.join(", ") + "."
    : "";
  if (desc.includes("{lora_triggers}")) desc = desc.replaceAll("{lora_triggers}", text);
  else if (text) desc = desc.replace("\n\n" + GENERATION_TAIL, text + "\n\n" + GENERATION_TAIL);
  return desc;
}

/** [{name, description, inputSchema}] for every tool this brain serves. */
export function toolSpecs(allPacks: Pack[], cfg: Config, imageMode: ImageMode): ToolSpec[] {
  if (imageMode !== "paths" && imageMode !== "refs") throw new Error("image_mode must be 'paths' or 'refs'");
  const groups = groupByTool(allPacks);
  const selected = select(groups, cfg.pack_selections ?? {});
  const specs: ToolSpec[] = selected
    .filter((p) => !STATIC_TOOLS.has(p.tool_name))
    .map((p) => ({ name: p.tool_name, description: describe(p, cfg), inputSchema: GENERATION_SCHEMA }));
  if (selected.some((p) => p.tool_name === "edit_image")) {
    if (imageMode === "paths") {
      specs.push({ name: "edit_image", description: EDIT_DESC_PATHS, inputSchema: EDIT_SCHEMA_PATHS });
    } else {
      specs.push({ name: "edit_image", description: EDIT_DESC_REFS, inputSchema: EDIT_SCHEMA_REFS });
      specs.push({ name: "request_upload", description: UPLOAD_DESC, inputSchema: UPLOAD_SCHEMA });
    }
  }
  if (selected.some(canRedraw)) {
    specs.push(imageMode === "paths"
      ? { name: "redraw", description: REDRAW_DESC_PATHS, inputSchema: REDRAW_SCHEMA_PATHS }
      : { name: "redraw", description: REDRAW_DESC_REFS, inputSchema: REDRAW_SCHEMA_REFS });
  }
  specs.push({ name: "fetch_result", description: FETCH_DESC, inputSchema: FETCH_SCHEMA });
  return specs;
}
