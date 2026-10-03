// The tray icon, through our tray helper (packages/tray: a small Go program on fyne.io/systray,
// speaking JSON lines on stdio). The release has all three platforms' helpers in one archive; the
// bundle names it and the hashes, and this computer's helper is extracted from it once per release.
// A tray that cannot start (no D-Bus session on Linux) is logged and skipped, and one waiting for
// the desktop's tray says so in the log: the settings page is also reachable from every "not ready"
// tool answer.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fetchFile } from "./fetchfile.ts";
import { log } from "./log.ts";
import type { Machine } from "./machine.ts";
import type { Paths } from "./paths.ts";
import { openExternal, run } from "./proc.ts";

/** This platform's tray helper in the bundle's release: the archive's URL and SHA-256, and the
 * helper's file name in it and SHA-256. */
export type TrayHelper = { url: string; archiveSha256: string; name: string; sha256: string };

/** What a program's tray looks like: the icons by state color (.ico on Windows, .png elsewhere)
 * and the helper that shows them (null: none for this platform, or a dev build). */
export type TrayLook = { icons: Record<TrayColor, Uint8Array>; helper: TrayHelper | null };

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The helper binary, extracting it from the release's archive the first time; null where there is none.
 * COMFY_GEN_TRAY names a binary to use instead (dev builds, testing). */
export async function trayBinary(p: Paths, helper: TrayHelper | null): Promise<string | null> {
  if (process.env.COMFY_GEN_TRAY) return process.env.COMFY_GEN_TRAY;
  if (!helper) return null;
  const dir = join(p.home, "tray");
  // Named by its hash, so a newer helper never has to replace a running one (Windows refuses that).
  const file = `${helper.sha256.slice(0, 12)}-${helper.name}`;
  const bin = join(dir, file);
  mkdirSync(dir, { recursive: true });
  // Anything else there is an older helper (or systray2's, before v1.8.0); one still running
  // (Windows) goes next time.
  for (const name of readdirSync(dir)) {
    if (name === file) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {}
  }
  if (existsSync(bin) && sha256(bin) === helper.sha256) return bin;
  const tmp = join(dir, "download");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    await fetchFile(helper.url, join(tmp, "tray.tgz"), { sha256: helper.archiveSha256 });
    // Relative paths only, in the folder (a GNU tar on Windows reads "C:" as a remote host).
    const { code, output } = await run("tar", ["-xzf", "tray.tgz", helper.name], { cwd: tmp, timeoutMs: 60_000 });
    const extracted = join(tmp, helper.name);
    if (code !== 0 || !existsSync(extracted) || sha256(extracted) !== helper.sha256) throw new Error(`Unpacking the tray helper failed: ${output.trim()}`);
    if (process.platform !== "win32") chmodSync(extracted, 0o755);
    renameSync(extracted, bin);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return bin;
}

export type TrayItem = { title: string; tooltip?: string; enabled?: boolean; onClick?: () => void };

export class Tray {
  private child: ChildProcess | null = null;
  private shown = false; // the helper came up once: from then on, it is started again if it ends
  private stopped = false;
  private restarts: number[] = [];
  private bin: string;
  private items: TrayItem[];
  private menu: Record<string, unknown>;

  private constructor(bin: string, items: TrayItem[], menu: Record<string, unknown>) {
    this.bin = bin;
    this.items = items;
    this.menu = menu;
  }

  /** Show the icon with *items*; null if the helper is unavailable or does not come up. */
  static async start(p: Paths, helper: TrayHelper | null, icon: Uint8Array, tooltip: string, items: TrayItem[]): Promise<Tray | null> {
    let bin: string | null;
    try {
      bin = await trayBinary(p, helper);
    } catch (e) {
      log.warn("No tray icon:", (e as Error).message);
      return null;
    }
    if (!bin) return null;
    const tray = new Tray(bin, items, { icon: Buffer.from(icon).toString("base64"), title: "", tooltip });
    if (!(await tray.spawn())) return null;
    tray.shown = true;
    return tray;
  }

  /** Start the helper and send it the menu; false if it does not come up. */
  private async spawn(): Promise<boolean> {
    const child = spawn(this.bin, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    // Its reasons, such as "no tray on this desktop", go to the log.
    createInterface({ input: child.stderr! }).on("line", (line) => line.trim() && log.warn("Tray helper:", line.trim()));
    // Writing to a helper that is gone fails with EPIPE, which crashed the agent while it stopped
    // (a Terminal window closed on macOS, 2026-10-02): a lost tray message is no matter.
    child.stdin?.on("error", () => {});
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      child.once("error", (e) => (log.warn("No tray icon:", e.message), clearTimeout(timer), resolve(false)));
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(false);
        log.warn(`The tray helper exited (${code})`);
        this.exited(child);
      });
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "ready") {
          clearTimeout(timer);
          resolve(true);
        } else if (msg.type === "clicked") {
          const item = this.items[Number(msg.__id) - 1];
          try {
            item?.onClick?.();
          } catch (e) {
            log.error("Tray action failed:", e);
          }
        }
      });
    });
    if (!ready) {
      child.kill();
      return false;
    }
    this.send({ ...this.menu, items: this.items.map((item, i) => this.wire(item, i)) });
    child.unref();
    (child.stdout as any)?.unref?.();
    (child.stderr as any)?.unref?.();
    (child.stdin as any)?.unref?.();
    return true;
  }

  /** The helper ended by itself (on a Mac, once 25 minutes after login, leaving no icon to pause
   * or quit with): start it again, at most five times an hour. */
  private exited(child: ChildProcess): void {
    if (this.stopped || !this.shown || child !== this.child) return;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 3600_000);
    if (this.restarts.length >= 5) {
      log.warn("The tray helper keeps ending: no tray icon until the next start");
      return;
    }
    this.restarts.push(now);
    setTimeout(() => {
      if (!this.stopped) void this.spawn().then((ok) => ok && log.info("The tray icon is back"));
    }, 5000).unref();
  }

  private wire(item: TrayItem, i: number) {
    return { title: item.title, tooltip: item.tooltip ?? item.title, enabled: item.enabled ?? true, __id: i + 1 };
  }

  private send(msg: unknown): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** Change an item's title or state, by index. */
  update(index: number, changes: Partial<TrayItem>): void {
    const item = this.items[index];
    if (!item || (changes.title === item.title && changes.enabled === item.enabled)) return;
    Object.assign(item, changes);
    this.send({ type: "update-item", item: this.wire(item, index) });
  }

  /** Change the icon (and its tooltip). */
  setIcon(icon: Uint8Array, tooltip: string): void {
    this.menu = { ...this.menu, icon: Buffer.from(icon).toString("base64"), tooltip };
    this.send({ type: "update-menu", menu: { ...this.menu, items: this.items.map((item, i) => this.wire(item, i)) } });
  }

  stop(): void {
    this.stopped = true;
    this.send({ type: "exit" });
    const child = this.child;
    setTimeout(() => child?.kill(), 500).unref();
  }
}

export type TrayColor = "yellow" | "green" | "red";
const STATE_COLORS: Record<string, TrayColor> = {
  running: "green", external: "green", stopped: "yellow", starting: "yellow", failed: "red", not_installed: "red",
};

/** An extra tray item for one program (the agent's pause), and the note it adds to the status. */
export type TrayExtra = { title: () => string; onClick: () => void; note: () => string | null; name?: string };

/** A menu separator, in the tray helper's protocol. */
const SEPARATOR: TrayItem = { title: "<SEPARATOR>", tooltip: "", enabled: true };

/**
 * The tray for a machine: Open settings, Open images folder (the generated images, kept on this
 * machine), the status (greyed: it is information, not an action),
 * then Stop ComfyUI and *extra*, a program's own item (the agent's Pause agent). No Start or
 * Restart: ComfyUI starts by itself with the first image. The icon's color is the state at a
 * glance: green running, yellow stopped or starting, red when something needs the user (ComfyUI
 * failed or is not installed, a download failed, or whatever *trouble* reports, such as the
 * agent's lost connection). A requested Stop shows "Stopping…" at once, not the old state until it
 * is done; *extra*'s note shows in the status and turns green yellow.
 */
export async function machineTray(
  machine: Machine,
  look: TrayLook,
  settingsUrl: string | (() => string), // a function: decided at the click (the agent's Worker)
  trouble: () => string | null = () => null,
  extra?: TrayExtra,
): Promise<Tray | null> {
  const { comfy, downloads } = machine;
  let action: string | null = null; // "starting" or "stopping" while a tray action runs
  const status = () => {
    const note = trouble() ?? (downloads.failed() ? "a model download failed" : null) ?? extra?.note() ?? null;
    const state = action ? `${action}…` : comfy.state.replace("_", " ");
    return `ComfyUI: ${state}${note ? ` (${note})` : ""}`;
  };
  const color = (): TrayColor => {
    if (trouble() || downloads.failed()) return "red";
    if (action) return "yellow";
    const byState = STATE_COLORS[comfy.state] ?? "yellow";
    return byState === "green" && extra?.note() ? "yellow" : byState;
  };
  let shown = color();
  const name = extra?.name ?? "Comfy-Gen-MCP"; // the tooltip's, to tell two agents apart
  let shownTip = `${name}: ${status()}`;
  const stoppable = () => !action && (comfy.state === "running" || comfy.state === "starting");
  const hasImages = () => "output" in machine.folders(); // ComfyUI installed (its output folder kept)
  const items: TrayItem[] = [
    { title: "Open settings", onClick: () => openExternal(typeof settingsUrl === "function" ? settingsUrl() : settingsUrl) },
    { title: "Open images folder", enabled: hasImages(), onClick: () => machine.openFolder("output") },
    { title: status(), enabled: false }, // greyed (2026-10-02: the user's choice, over legibility on Windows)
    SEPARATOR,
    { title: "Stop ComfyUI", enabled: stoppable(), onClick: () => run("stopping", () => comfy.stop()) },
    ...(extra ? [{ title: extra.title(), onClick: () => (extra.onClick(), refresh()) }] : []),
  ];
  const { icons, helper } = look;
  const t = await Tray.start(machine.p, helper, icons[shown], shownTip, items);

  function refresh(): void {
    if (!t) return;
    t.update(1, { title: "Open images folder", enabled: hasImages() });
    t.update(2, { title: status(), enabled: false });
    t.update(4, { title: "Stop ComfyUI", enabled: stoppable() });
    if (extra) t.update(5, { title: extra.title() });
    const now = color();
    const tip = `${name}: ${status()}`;
    if (now !== shown || tip !== shownTip) t.setIcon(icons[(shown = now)], (shownTip = tip));
  }

  function run(label: string, act: () => Promise<unknown>): void {
    action = label;
    refresh();
    act()
      .catch((e) => log.error(`${label} ComfyUI failed:`, e))
      .finally(() => {
        action = null;
        refresh();
      });
  }

  if (t) setInterval(refresh, 2000).unref();
  return t;
}
