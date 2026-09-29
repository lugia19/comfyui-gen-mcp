"""ComfyUI extension installed in the Modal image and in the MCPB's local ComfyUI.

GET /comfy-gen/wait/{prompt_id}?timeout=S:

Holds the request until the prompt finishes or S seconds pass, then answers
{"state": "done", "status": ..., "outputs": ...}, {"state": "running"},
{"state": "pending", "position": n} or {"state": "unknown"}. The Worker waits with one held request
instead of polling /history and /queue: each request it makes costs it CPU, and a finished image is
seen at once instead of at the next poll. Clients fall back to polling on a 404, so a ComfyUI
without this extension still works.

Parent watchdog: with COMFY_GEN_PARENT_PID set (the MCPB sets it), ComfyUI exits when that process
is gone. Claude Desktop may end the extension without a chance to stop its ComfyUI (on Windows a
killed process leaves its children running), which would otherwise hold the GPU until reboot.

No nodes; only the route and the watchdog. Loaded by ComfyUI from custom_nodes/, where it can
import `server`.
"""

import asyncio
import os
import sys
import threading
import time

NODE_CLASS_MAPPINGS = {}
MAX_WAIT_S = 120
CHECK_EVERY_S = 0.25


def job_state(queue, prompt_id: str) -> dict:
    """The prompt's state from ComfyUI's PromptQueue. The queue is read before the history: a job
    leaves the running set and enters the history under one lock, so it is always seen in one."""
    running, pending = queue.get_current_queue_volatile()
    if any(len(item) > 1 and item[1] == prompt_id for item in running):
        return {"state": "running"}
    ordered = sorted(pending, key=lambda item: item[0])
    for position, item in enumerate(ordered, 1):
        if len(item) > 1 and item[1] == prompt_id:
            return {"state": "pending", "position": position}
    entry = queue.get_history(prompt_id=prompt_id).get(prompt_id)
    if entry is None:
        return {"state": "unknown"}
    return {"state": "done", "status": entry.get("status"), "outputs": entry.get("outputs", {})}


async def wait_for(queue, prompt_id: str, timeout: float) -> dict:
    deadline = time.monotonic() + min(max(timeout, 0.0), MAX_WAIT_S)
    while True:
        state = job_state(queue, prompt_id)
        if state["state"] in ("done", "unknown") or time.monotonic() >= deadline:
            return state
        await asyncio.sleep(CHECK_EVERY_S)


def pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)  # POSIX only: on Windows this would terminate the process
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def watch_parent(pid: int, alive=pid_alive, every_s: float = 5.0, exit=os._exit) -> None:
    """Exit the process once *pid* is gone. Blocks; run it in a daemon thread."""
    while alive(pid):
        time.sleep(every_s)
    print(f"[comfy-gen] parent process {pid} is gone; exiting", flush=True)
    exit(0)


def _start_watchdog() -> None:
    pid = os.environ.get("COMFY_GEN_PARENT_PID", "")
    if pid.isdigit():
        threading.Thread(target=watch_parent, args=(int(pid),), daemon=True, name="comfy-gen-watchdog").start()


def _register() -> None:
    from aiohttp import web
    from server import PromptServer

    server = PromptServer.instance

    @server.routes.get("/comfy-gen/wait/{prompt_id}")
    async def wait(request):
        try:
            timeout = float(request.query.get("timeout", "0"))
        except ValueError:
            return web.json_response({"error": "timeout must be a number"}, status=400)
        return web.json_response(await wait_for(server.prompt_queue, request.match_info["prompt_id"], timeout))


try:
    import server as _comfy_server  # noqa: F401  (only importable inside ComfyUI)
except ImportError:
    pass
else:
    _register()
    _start_watchdog()
