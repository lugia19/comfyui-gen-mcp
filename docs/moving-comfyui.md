# Moving ComfyUI or PyTorch to a newer version

PCs upgrade themselves to a release's versions once idle, and Modal rebuilds its image at the next
deploy (design §2, "ComfyUI and PyTorch versions"). So a version bump is a release like any other,
but every user's ComfyUI moves with it. Check it first.

1. **Read the new ComfyUI's release notes and README.**
   - Is its torch floor above `TORCH_MIN`? Raise `TORCH_MIN` in `packages/local/src/versions.ts`.
     Every PC below it downloads PyTorch again, about 3 GB.
   - Does it ask for a newer CUDA build? Today it asks cu130 of RTX 20-series and newer. Then
     check `chooseBuild`'s table.
2. **Bump** `COMFYUI_VERSION` (and `TORCH_MIN`) in `versions.ts`, and `MODAL_VERSIONS` in
   `packages/modal_app/src/comfy_gen_modal/app.py`.
   - `uv run pytest` fails until they agree.
   - Modal's torch comes from one index (cu130): it has to run on every GPU in `GPUS`.
   - **The T4 sets the floor** (compute capability 7.5). If a torch drops Turing, the T4 leaves
     `GPUS`, or Modal stays on the last torch with it.
3. **Check what the code relies on.** Search for the old version in `docs/design.md` and the
   code comments. Those are behaviours measured on it: `--cache-ram`, winmem's psutil patch, the
   built-in nodes the packs use. Re-check each.
4. **Run every pack before releasing:**
   - on a PC, through the dev Worker;
   - on Modal: a generation per tool, an edit and a redraw.
   
   Look for nodes that changed their inputs. The packs' workflows name them, and ComfyUI's
   `/object_info` says what the new version takes.
5. **Release.** Say in the notes that ComfyUI upgrades itself once idle, and how big the
   download is (PyTorch only if `TORCH_MIN` moved).
