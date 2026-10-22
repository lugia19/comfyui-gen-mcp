// A GPU's extra ComfyUI command-line flags (`comfy_args`): a list of arguments, appended after ours
// when ComfyUI starts (on Modal and on a PC), so ours can be overridden (argparse: the last wins).
// Stored and sent as a list, so nothing re-parses it and a path with spaces stays one argument; the
// settings page edits it as one line typed as in a terminal (splitArgs, joinArgs).

/** Where ComfyUI listens and keeps its files is ours to set. --listen most of all: on a PC it would
 * open ComfyUI to the network. */
export const REFUSED_COMFY_FLAGS = [
  "--listen", "--port", "--tls-keyfile", "--tls-certfile", "--enable-cors-header",
  "--input-directory", "--output-directory", "--temp-directory", "--user-directory", "--base-directory",
  "--extra-model-paths-config",
];
const MAX_ARGS = 40;
const MAX_ARG_LENGTH = 300;

/** *s* split as a terminal would: on whitespace, with "…" and '…' quoting. Backslashes are kept as
 * they are (Windows paths). An unclosed quote is an error. */
export function splitArgs(s: string): { args: string[] } | { error: string } {
  const args: string[] = [];
  let cur = "";
  let started = false; // "" is an argument too
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return { error: `A ${quote} quote is not closed.` };
  if (started) args.push(cur);
  return { args };
}

/** *args* as one line splitArgs reads back the same: quoted where they have spaces or quotes. */
export function joinArgs(args: string[]): string {
  return args
    .map((a) => (a === "" || /[\s"']/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a))
    .join(" ");
}

/** Why *args* can't be a GPU's ComfyUI flags, or null if they can. */
export function checkComfyArgs(args: unknown): string | null {
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) return "ComfyUI flags must be a list of arguments";
  if (args.length > MAX_ARGS) return `At most ${MAX_ARGS} ComfyUI arguments`;
  for (const a of args as string[]) {
    if (a.length > MAX_ARG_LENGTH) return `A ComfyUI argument is longer than ${MAX_ARG_LENGTH} characters`;
    if (/[\x00-\x1f\x7f]/.test(a)) return "A ComfyUI argument has a control character in it";
    if (!a.startsWith("--")) continue;
    // argparse takes any unambiguous start of a flag's name: --liste is --listen.
    const name = a.split("=")[0];
    const refused = REFUSED_COMFY_FLAGS.find((f) => name.length > 3 && f.startsWith(name));
    if (refused) return `${refused} can't be set: Comfy-Gen sets where ComfyUI listens and keeps its files`;
  }
  if (args.length && !(args[0] as string).startsWith("-")) return `ComfyUI flags start with a flag (--…), not "${args[0]}"`;
  return null;
}
