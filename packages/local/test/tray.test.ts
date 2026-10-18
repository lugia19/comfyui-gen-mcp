// The machine tray's menu (packages/local/src/tray.ts machineTray), with the helper replaced: what it
// lists, and that updates land on the right items when the agent adds its own.

import { afterEach, describe, expect, it, vi } from "vitest";
import { machineTray, Tray, type TrayItem } from "../src/tray.ts";

function fakeMachine() {
  return { p: {}, comfy: { state: "running", stop: async () => {} }, downloads: { failed: () => false }, folders: () => ({ output: "/out" }), openFolder: vi.fn() } as any;
}

/** machineTray over a fake Tray: the items it starts with, and each update by index. */
async function menu(extra?: Parameters<typeof machineTray>[4]) {
  let items: TrayItem[] = [];
  const updates: [number, string][] = [];
  vi.spyOn(Tray, "start").mockImplementation(async (_p, _h, _i, _t, list) => {
    items = list;
    return { update: (i: number, it: TrayItem) => updates.push([i, it.title]), setIcon: () => {}, stop: () => {} } as any;
  });
  vi.useFakeTimers();
  const machine = fakeMachine();
  await machineTray(machine, { icons: { green: new Uint8Array(), yellow: new Uint8Array(), red: new Uint8Array() } } as any, "http://127.0.0.1:9247/", () => null, extra);
  vi.advanceTimersByTime(2000);
  return { titles: items.map((i) => i.title), updates };
}

/** Where each update went, by item ("status" for the status line, whose title changes). */
const positions = (updates: [number, string][]) => Object.fromEntries(updates.map(([i, t]) => [t.startsWith("ComfyUI:") ? "status" : t, i]));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the machine tray", () => {
  it("the extension's: settings, images, status, Stop", async () => {
    const { titles, updates } = await menu();
    expect(titles).toEqual(["Open settings", "Open images folder", "ComfyUI: running", "<SEPARATOR>", "Stop ComfyUI"]);
    expect(positions(updates)).toEqual({ "Open images folder": 1, status: 2, "Stop ComfyUI": 4 });
  });

  it("the agent's adds Open this PC's settings (its own page, where it unpairs) and its pause; updates follow", async () => {
    const { titles, updates } = await menu({ title: () => "Pause agent", onClick: () => {}, note: () => null, localPage: "http://127.0.0.1:9248/" });
    expect(titles).toEqual(["Open settings", "Open this PC's settings", "Open images folder", "ComfyUI: running", "<SEPARATOR>", "Stop ComfyUI", "Pause agent"]);
    expect(positions(updates)).toEqual({ "Open images folder": 2, status: 3, "Stop ComfyUI": 5, "Pause agent": 6 });
  });
});
