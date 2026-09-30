// The agent ends with its launcher. On Windows, ending the launcher (Task Manager, or a script)
// leaves its child running, so Node, the tray and ComfyUI would carry on with nothing to restart
// or stop them. The launcher sets COMFY_GEN_LAUNCHER_PID; launchers from before that are the
// parent process, which is the same thing.

/** The launcher's pid, or null when not started by one (development, the extension). */
export function launcherPid(env: NodeJS.ProcessEnv = process.env, ppid = process.ppid): number | null {
  if (env.COMFY_GEN_OPEN_SETTINGS === undefined) return null; // every launcher sets it
  const pid = Number(env.COMFY_GEN_LAUNCHER_PID) || ppid;
  return pid > 1 ? pid : null;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: only checks that it exists (Windows too)
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, but not ours to signal
  }
}

/** Call *onGone* once, when *pid* is no longer alive. Returns a stop function. */
export function watchParent(pid: number, onGone: () => void, alive = processAlive, everyMs = 5000): () => void {
  const timer = setInterval(() => {
    if (alive(pid)) return;
    clearInterval(timer);
    onGone();
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
