"""Windows only: psutil.virtual_memory() from GlobalMemoryStatusEx, which costs nothing whatever the
system holds.

ComfyUI 0.37.0 reads the free RAM at least twice for every weight it pins (comfy/pinned_memory.py:
extra_ram_release, then ensure_pin_budget, both through comfy.system_memory and
psutil.virtual_memory()), hundreds of times per model. On Windows psutil (6.x to 7.2.2, at least)
builds virtual_memory() from GetPerformanceInfo, which also counts every handle, thread and process
on the system. After some games a driver leaks handles (Ace Combat 8: the System process at 184k, the
system at 346k) and each call took about 200 ms until a reboot, so a model's first load sat at
"Model Initializing" for minutes instead of about 10 s (measured 2026-10-22: GetPerformanceInfo
196 ms a call, psutil.virtual_memory() 223 ms, GlobalMemoryStatusEx 0.00 ms, the same total and
available physical RAM).

The platform backend is replaced, not ComfyUI's function: comfy_execution/caching.py imports
virtual_memory_available by name, and psutil.virtual_memory() looks up
psutil._psplatform.virtual_memory at each call, so this reaches every caller. The result keeps
psutil's shape on Windows: (total, available, percent, used, free), free being available.

Anything that doesn't match (no _psplatform, another shape, a failed call, a total that disagrees)
leaves psutil as it is, with a warning; it never stops ComfyUI from starting. COMFY_GEN_FAST_MEMINFO=0
in the environment ComfyUI starts in (the agent's or Claude Desktop's) switches it off.
"""

import logging
import os

ENV = "COMFY_GEN_FAST_MEMINFO"
FIELDS = ("total", "available", "percent", "used", "free")  # psutil's svmem on Windows


def global_memory_status():
    """(total, available) physical RAM in bytes, from GlobalMemoryStatusEx; None if it fails."""
    import ctypes
    from ctypes import wintypes

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD),
            ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
            ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
            ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
            ("ullAvailExtendedVirtual", ctypes.c_uint64),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(MEMORYSTATUSEX)]
    kernel32.GlobalMemoryStatusEx.restype = wintypes.BOOL

    def status():
        ms = MEMORYSTATUSEX()  # one per call: ComfyUI reads memory from more than one thread
        ms.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if not kernel32.GlobalMemoryStatusEx(ctypes.byref(ms)):
            return None
        return ms.ullTotalPhys, ms.ullAvailPhys

    return status


def fast_virtual_memory(svmem, status, fallback):
    """psutil's virtual_memory() from *status*, as psutil computes it from its own numbers; psutil's
    own (*fallback*) whenever *status* fails."""

    def virtual_memory():
        got = status()
        if not got or not got[0]:
            return fallback()
        total, avail = got
        used = total - avail
        return svmem(total, avail, round(used / total * 100, 1), used, avail)

    return virtual_memory


def install(psutil=None, status=None, env=os.environ) -> bool:
    """Replace psutil's virtual_memory() backend with GlobalMemoryStatusEx's. Whether it did."""
    if env.get(ENV, "").strip().lower() in ("0", "false", "no", "off"):
        logging.info(f"[comfy-gen] {ENV} is off: psutil.virtual_memory() left as it is")
        return False
    try:
        if psutil is None:
            import psutil
        platform = psutil._psplatform
        original = platform.virtual_memory
        if getattr(original, "comfy_gen_original", None):
            return True  # already in place (the module loaded twice)
        status = status or global_memory_status()
        got = status()
        if not got or not got[0]:
            raise OSError("GlobalMemoryStatusEx failed")
        before = original()
        svmem = type(before)
        fields = tuple(getattr(svmem, "_fields", ()))
        if fields != FIELDS or before.free != before.available:
            raise ValueError(f"psutil {getattr(psutil, '__version__', '?')}'s virtual_memory() is {fields}, not the shape this replaces")
        if abs(got[0] - before.total) > before.total * 0.01:
            raise ValueError(f"GlobalMemoryStatusEx's total ({got[0]}) isn't psutil's ({before.total})")
        fast = fast_virtual_memory(svmem, status, original)
        fast.comfy_gen_original = original  # for comparing the two
        platform.virtual_memory = fast
    except Exception:
        logging.warning("[comfy-gen] could not switch psutil.virtual_memory() to GlobalMemoryStatusEx; left as it is", exc_info=True)
        return False
    logging.info(f"[comfy-gen] psutil.virtual_memory() reads GlobalMemoryStatusEx now (Windows: fast however many handles are open; {ENV}=0 switches it off)")
    return True
