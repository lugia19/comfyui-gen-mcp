"""A scripted in-memory ComfyUI, as a Transport. Shaped after Visual-Novelist's FakeComfy."""

from __future__ import annotations

import json
import re

from comfy_gen_core.comfyui import Response

OUTPUT = {"filename": "comfy-gen_00001_.png", "subfolder": "", "type": "output"}


class FakeComfy:
    """
    boot_503s        how many /prompt calls answer 503 before one is accepted
    reject           if set, /prompt answers 400 with this JSON body
    history          per /history call, what the job looks like; when exhausted, "done":
                       "running"  not in history, running in the queue
                       "pending"  not in history, second in the pending queue
                       "done"     in history with an output image
                       "error"    in history with an execution error
                       "gone"     in neither history nor queue
                       <int>      that HTTP status
    """

    def __init__(self):
        self.boot_503s = 0
        self.reject: dict | None = None
        self.history: list = []
        self.prompts: list[dict] = []
        self.calls: list[tuple[str, str, dict | None]] = []
        self.uploads: list[bytes] = []
        self.view_body = b"RIFF\x00\x00\x00\x00WEBPVP8 fake"
        self._state = "running"

    async def request(self, method, path, *, params=None, headers=None, body=None, timeout=30.0) -> Response:
        self.calls.append((method, path, params))
        if path == "/prompt":
            if self.boot_503s:
                self.boot_503s -= 1
                return Response(503)
            if self.reject is not None:
                return Response(400, json.dumps(self.reject).encode())
            self.prompts.append(json.loads(body)["prompt"])
            self._state = "running"
            return Response(200, json.dumps({"prompt_id": f"p{len(self.prompts)}"}).encode())
        if m := re.fullmatch(r"/history/(\w+)", path):
            step = self.history.pop(0) if self.history else "done"
            if isinstance(step, int):
                return Response(step)
            self._state = step
            pid = m.group(1)
            if step == "done":
                return _json({pid: {"status": {"status_str": "success", "completed": True},
                                    "outputs": {"9": {"images": [OUTPUT]}}}})
            if step == "error":
                return _json({pid: {"status": {"status_str": "error", "messages": [
                    ["execution_error", {"node_type": "KSampler", "exception_message": "out of memory"}]]},
                    "outputs": {}}})
            return _json({})
        if path == "/queue":
            pid = f"p{len(self.prompts)}"
            running = [[0, pid, {}, {}, []]] if self._state == "running" else []
            pending = [[1, "other", {}, {}, []], [2, pid, {}, {}, []]] if self._state == "pending" else []
            return _json({"queue_running": running, "queue_pending": pending})
        if path == "/view":
            return Response(200, self.view_body, {"content-type": "image/webp"})
        if path == "/upload/image":
            self.uploads.append(body)
            name = re.search(rb'filename="([^"]+)"', body).group(1).decode()
            sub = re.search(rb'name="subfolder"\r\n\r\n([^\r]*)\r\n', body)
            return _json({"name": name, "subfolder": sub.group(1).decode() if sub else "", "type": "input"})
        if path == "/object_info":
            return _json({"KSampler": {}, "SaveImage": {}, "CLIPTextEncode": {}})
        return Response(404)


def _json(data) -> Response:
    return Response(200, json.dumps(data).encode(), {"content-type": "application/json"})
