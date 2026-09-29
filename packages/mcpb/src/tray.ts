// The tray icon, through systray2's helper binary (a small Go program speaking JSON lines on stdio).
// The binary is downloaded once from systray2's npm tarball, both pinned by SHA-256. A tray that
// cannot start (headless Linux, no Rosetta on Apple silicon) is logged and skipped: the settings
// page is also reachable from every "not ready" tool answer.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fetchFile, log, run, type Paths } from "@comfy-gen/local";

const TARBALL = "https://registry.npmjs.org/systray2/-/systray2-2.1.4.tgz";
const TARBALL_SHA256 = "24a176933952c4db79026dcec25c7acf48e5c1cee5d94bc6b87740060bc8ed00";
const BINARIES: Record<string, [string, string]> = {
  win32: ["tray_windows_release.exe", "ae61c63ece1392fc64abbfbd40de782f5b2a7b7d83e93f8b640a20395ae6e8a0"],
  darwin: ["tray_darwin_release", "b406fe6d13d1ba66f901a07267ecfcf1b615e9c8b3410287be576706bd737791"],
  linux: ["tray_linux_release", "f61eee19036c0af93e2bb0e5b9fff0bd413469aff5ea1261b8fcfe9e2c027c04"],
};

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The helper binary for this platform, downloading it the first time; null where there is none. */
export async function trayBinary(p: Paths): Promise<string | null> {
  const entry = BINARIES[process.platform];
  if (!entry || (process.platform === "linux" && process.arch !== "x64")) return null;
  const [name, digest] = entry;
  const dir = join(p.home, "tray");
  const bin = join(dir, name);
  if (existsSync(bin) && sha256(bin) === digest) return bin;
  const tmp = join(dir, "download");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tgz = join(tmp, "systray2.tgz");
  await fetchFile(TARBALL, tgz, { sha256: TARBALL_SHA256 });
  const { code, output } = await run("tar", ["-xzf", tgz, "-C", tmp, `package/traybin/${name}`], { timeoutMs: 60_000 });
  const extracted = join(tmp, "package", "traybin", name);
  if (code !== 0 || !existsSync(extracted) || sha256(extracted) !== digest) throw new Error(`Unpacking the tray helper failed: ${output.trim()}`);
  if (process.platform !== "win32") chmodSync(extracted, 0o755);
  rmSync(bin, { force: true });
  renameSync(extracted, bin);
  rmSync(tmp, { recursive: true, force: true });
  return bin;
}

export type TrayItem = { title: string; tooltip?: string; enabled?: boolean; onClick?: () => void };

export class Tray {
  private child: ChildProcess;
  private items: TrayItem[];
  private menu: Record<string, unknown> = {};

  private constructor(child: ChildProcess, items: TrayItem[]) {
    this.child = child;
    this.items = items;
  }

  /** Show the icon with *items*; null if the helper is unavailable or does not come up. */
  static async start(p: Paths, icon: Uint8Array, tooltip: string, items: TrayItem[]): Promise<Tray | null> {
    let bin: string | null;
    try {
      bin = await trayBinary(p);
    } catch (e) {
      log.warn("No tray icon:", (e as Error).message);
      return null;
    }
    if (!bin) return null;
    const child = spawn(bin, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const tray = new Tray(child, items);
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      child.once("error", (e) => (log.warn("No tray icon:", e.message), clearTimeout(timer), resolve(false)));
      child.once("exit", (code) => (clearTimeout(timer), resolve(false), log.warn(`The tray helper exited (${code})`)));
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
          const item = tray.items[Number(msg.__id) - 1];
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
      return null;
    }
    tray.menu = { icon: Buffer.from(icon).toString("base64"), title: "", tooltip, isTemplateIcon: false };
    tray.send({ ...tray.menu, items: items.map((item, i) => tray.wire(item, i)) });
    child.unref();
    (child.stdout as any)?.unref?.();
    (child.stdin as any)?.unref?.();
    return tray;
  }

  private wire(item: TrayItem, i: number) {
    return { title: item.title, tooltip: item.tooltip ?? item.title, enabled: item.enabled ?? true, checked: false, __id: i + 1 };
  }

  private send(msg: unknown): void {
    if (this.child.stdin?.writable) this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** Change an item's title or state, by index. */
  update(index: number, changes: Partial<TrayItem>): void {
    const item = this.items[index];
    if (!item || (changes.title === item.title && changes.enabled === item.enabled)) return;
    Object.assign(item, changes);
    this.send({ type: "update-item", item: this.wire(item, index), seq_id: -1 });
  }

  /** Change the icon (and its tooltip). */
  setIcon(icon: Uint8Array, tooltip: string): void {
    this.menu = { ...this.menu, icon: Buffer.from(icon).toString("base64"), tooltip };
    this.send({ type: "update-menu", menu: { ...this.menu, items: this.items.map((item, i) => this.wire(item, i)) } });
  }

  stop(): void {
    this.send({ type: "exit" });
    setTimeout(() => this.child.kill(), 500).unref();
  }
}
