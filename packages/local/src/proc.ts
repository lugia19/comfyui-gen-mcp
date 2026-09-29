// Child processes: run a command to completion, start a long-running one, stop a process tree.

import { spawn, type ChildProcess } from "node:child_process";

const WIN = process.platform === "win32";

/** The environment for Python tools: ours, minus any venv or conda env we were started from, and
 * with UTF-8 output (Windows' default code page crashes Python on the first non-Latin-1 char). */
export function pythonEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...extra };
  delete env.VIRTUAL_ENV;
  delete env.CONDA_PREFIX;
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  return env;
}

export type RunResult = { code: number | null; output: string };

/** Run to completion. *onLine* gets each output line (stdout and stderr merged). Never throws for a
 * non-zero exit; a command that cannot start gives code null and the error as output. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = "";
    let partial = "";
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, detached: !WIN });
    const timer = opts.timeoutMs ? setTimeout(() => killTree(child), opts.timeoutMs) : null;
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      if (output.length > 1 << 20) output = output.slice(-(1 << 19)); // keep the tail
      if (!opts.onLine) return;
      const lines = (partial + text).split(/\r?\n|\r/);
      partial = lines.pop()!;
      for (const l of lines) if (l.trim()) opts.onLine(l);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, output: `${cmd}: ${e.message}` });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (partial.trim() && opts.onLine) opts.onLine(partial);
      resolve({ code, output });
    });
  });
}

/** Start a long-running process in its own process group (POSIX), with no console window
 * (Windows), writing its output to *logFd*. */
export function start(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; logFd: number }): ChildProcess {
  return spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", opts.logFd, opts.logFd],
    windowsHide: true,
    detached: !WIN,
  });
}

/** Stop a process and everything it started. Resolves once it has exited (or 10 s have passed). */
export async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  if (WIN) {
    await run("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeoutMs: 10_000 });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  const late = setTimeout(() => {
    try {
      if (WIN) child.kill();
      else process.kill(-child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }, 5_000);
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  clearTimeout(late);
}
