import { describe, expect, it, vi } from "vitest";
import { launcherPid, processAlive, watchParent } from "../src/watchdog.ts";

describe("ending with the launcher", () => {
  it("knows its launcher only when started by one", () => {
    expect(launcherPid({}, 4321)).toBeNull(); // development, the extension
    expect(launcherPid({ COMFY_GEN_OPEN_SETTINGS: "0" }, 4321)).toBe(4321); // a launcher from before the pid variable
    expect(launcherPid({ COMFY_GEN_OPEN_SETTINGS: "1", COMFY_GEN_LAUNCHER_PID: "77" }, 4321)).toBe(77);
    expect(launcherPid({ COMFY_GEN_OPEN_SETTINGS: "0" }, 1)).toBeNull(); // orphaned already: init
  });

  it("calls back once, when the parent is gone", () => {
    vi.useFakeTimers();
    let alive = true;
    const gone = vi.fn();
    watchParent(77, gone, () => alive, 5000);
    vi.advanceTimersByTime(12_000);
    expect(gone).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(20_000);
    expect(gone).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("checks a real process", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12345)).toBe(false);
  });
});
