import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { bindWhenFree, launcherPid, processAlive, watchParent } from "../src/watchdog.ts";

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

describe("binding the settings port", () => {
  const listenOn = (port: number) =>
    new Promise<import("node:net").Server>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve(srv));
    });

  it("waits for a previous agent to free the port, but not for one that keeps it", async () => {
    const old = await listenOn(0);
    const port = (old.address() as any).port;
    setTimeout(() => old.close(), 300); // the old agent stopping
    let waits = 0;
    const srv = await bindWhenFree(() => listenOn(port), () => waits++, 3000, 100);
    expect(srv).not.toBeNull();
    expect(waits).toBe(1);
    // Another agent that stays: give up after the wait.
    expect(await bindWhenFree(() => listenOn(port), () => {}, 300, 100)).toBeNull();
    srv!.close();
  });
});
