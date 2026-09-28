"""How edit_image arguments reach ComfyUI from the Worker.

An image id resolves to a file ComfyUI already has (an output, or an earlier upload): nothing is
transferred. An https URL is fetched and uploaded to ComfyUI's input folder.
"""

from __future__ import annotations

import secrets

from comfy_gen_core import refs
from comfy_gen_core.brain import Hooks
from comfy_gen_core.comfyui import ComfyUIClient, ComfyUIError
from comfy_gen_core.images import image_size

from comfy_gen_worker.http import Fetch
from comfy_gen_worker.uploads import BadImage, store_input


class WorkerHooks(Hooks):
    def __init__(self, client: ComfyUIClient, hmac_key: bytes, fetch: Fetch):
        self.client = client
        self.hmac_key = hmac_key
        self.fetch = fetch

    async def resolve_image(self, arg: str) -> tuple[str, tuple[int, int] | None]:
        arg = arg.strip()
        if arg.startswith(("https://", "http://")):
            return await self._from_url(arg)
        if arg.lower().startswith("image_id:"):  # the model sometimes copies the label along
            arg = arg.split(":", 1)[1].strip()
        try:
            image = refs.verify(arg, self.hmac_key)
        except refs.RefError as e:
            raise ComfyUIError(
                f"{e} Pass an image_id from an earlier result or from request_upload, or a public https URL."
            ) from e
        return image.load_value(), None  # ComfyUI has it; outputs from our packs are within budget

    async def _from_url(self, url: str) -> tuple[str, tuple[int, int] | None]:
        try:
            resp = await self.fetch(url, method="GET")
        except Exception as e:
            raise ComfyUIError(f"Could not download {url}: {e}") from e
        if resp.status != 200:
            raise ComfyUIError(f"Could not download {url} (HTTP {resp.status}). The URL must be public.")
        try:
            uploaded, _ = await store_input(self.client, resp.content, secrets.token_urlsafe(9))
        except BadImage as e:
            raise ComfyUIError(f"{url}: {e}.") from e
        return uploaded.load_value(), image_size(resp.content)
