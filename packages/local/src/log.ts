// One log for the process: stderr (never stdout, which carries MCP over stdio) and logs/server.log.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

let file: string | null = null;

export function logTo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  file = join(dir, "server.log");
  try {
    if (statSync(file).size > 5 << 20) renameSync(file, file + ".1"); // one old log kept
  } catch {
    // no log yet
  }
}

function write(level: string, parts: unknown[]): void {
  const text = parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  const line = `${new Date().toISOString()} ${level} ${text}\n`;
  process.stderr.write(line);
  if (file) {
    try {
      appendFileSync(file, line);
    } catch {
      // a full disk or a locked file must not take the server down
    }
  }
}

export const log = {
  info: (...parts: unknown[]) => write("INFO", parts),
  warn: (...parts: unknown[]) => write("WARN", parts),
  error: (...parts: unknown[]) => write("ERROR", parts),
};
