# Adding a model

A model is a pack: one JSON file in `packages/core/packs/`. It ships with a release: the Worker,
the extension and the agent all build it in. Packs are ours; there are no user workflows.

## The steps

1. **Build the workflow in ComfyUI** and get it working there.
2. **Name the nodes we fill in.** In ComfyUI, rename (title) these nodes:

   | Title | The node | What we set |
   |---|---|---|
   | `cg:prompt` | the prompt's text encoder (exactly one) | `text` |
   | `cg:seed` | each node with a seed (at least one) | `seed`, or `noise_seed` (RandomNoise) |
   | `cg:size` | a node with `width` and `height` (an empty latent) | both, from the aspect ratio and resolution |
   | `cg:width`, `cg:height` | number nodes (PrimitiveInt) feeding the size | `value` |
   | `cg:model` | the model loader LoRAs attach to (needed with a `lora_group`) | LoRA nodes are chained after its output 0 |

   An edit model marks its **first image's** nodes, and a second image is built from them:

   | Title | The node |
   |---|---|
   | `cg:image` | LoadImage |
   | `cg:image scale` | ImageScaleToTotalPixels (its megapixels are set per image) |
   | `cg:image encode` | anything else that belongs to one image (VAEEncode) |
   | `cg:image chain` | the nodes that chain images: their input from outside the image (the conditioning) takes the previous image's matching node |

   Leave the output size on the first image (a GetImageSize reading `cg:image scale`, untitled).
   If a model needs a different shape for several images, `withImages` in `workflow.ts` is the
   place to change.
3. **Export it in API format** (Workflow → Export (API)) and put it under `"workflow"` in a new
   pack file. Set every file name a loader names (`unet_name`, `clip_name`, `vae_name`, …) and the
   SaveImage `filename_prefix` to `comfy-gen`.
4. **Write the rest of the pack:**

   ```json
   {
     "name": "my_model",
     "display_name": "My Model",
     "description": "One line for the settings page (size, speed, VRAM).",
     "tool_name": "generate_realistic_image",
     "is_default": false,
     "prompt_guide": "How to prompt this model, for Claude (optional: else the tool's default guide).",
     "models": [
       { "url": "https://huggingface.co/…/resolve/main/…/model.safetensors", "subfolder": "diffusion_models" }
     ],
     "required_nodes": { "UnetLoaderGGUF": "ComfyUI-GGUF" },
     "max_pixels": 1048576,
     "max_pixels_limit": 4194304,
     "workflow": { … }
   }
   ```

   - `tool_name`: one of the tools in `packs/tools.json` (`generate_illustrated_image`,
     `generate_realistic_image`, `edit_image`). The tool's routing line and the shared ending of
     its description come from there; `prompt_guide` goes between them.
   - `subfolder`: the ComfyUI models folder the file goes in (`diffusion_models`, `text_encoders`,
     `vae`, `loras`, …).
   - `required_nodes`: custom nodes the workflow uses, class → node pack.
   - `max_pixels`: the default resolution budget; `max_pixels_limit` lets the user raise it.
   - Optional: `family` (share settings with another pack, as Anima Turbo does with Anima; the
     stored key, so never rename it), `lora_group` (takes LoRAs: a group from `tools.json`'s
     `lora_groups`, or a new one there with its tab name), `default_artist_list` (Anima's @artists).
5. **Fill in the model sizes and hashes:**

   ```sh
   python3 scripts/fill_pack_models.py packages/core/packs/my_model.json
   ```

6. **List it** in `packages/core/packs/index.ts` (file-name order), then run `npm test` (the pack
   tests check the titles, the tool, the LoRA group, and that every file a loader names is in
   `models`) and `python3 scripts/check_pack_models.py`.
7. **Try it** on a PC and on Modal before a release: one image, and for an edit model one with two
   images.
