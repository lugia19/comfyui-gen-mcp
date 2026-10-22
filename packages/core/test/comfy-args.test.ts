import { describe, expect, it } from "vitest";
import { checkComfyArgs, joinArgs, splitArgs } from "../src/comfy-args.ts";

describe("a GPU's ComfyUI flags, typed as one line", () => {
  it("split as a terminal would, keeping Windows paths and quoted spaces", () => {
    expect(splitArgs("  --reserve-vram 2   --fast ")).toEqual({ args: ["--reserve-vram", "2", "--fast"] });
    expect(splitArgs(`--x "C:\\My Models\\a b" --y 'it''s' --z ""`)).toEqual({ args: ["--x", "C:\\My Models\\a b", "--y", "its", "--z", ""] });
    expect(splitArgs("")).toEqual({ args: [] });
    expect(splitArgs('--x "C:\\My Models')).toEqual({ error: "A \" quote is not closed." });
  });

  it("shown again as a line that splits back the same", () => {
    for (const args of [["--reserve-vram", "2"], ["--x", "C:\\My Models\\a b", "--z", ""], ["--y", 'say "hi"'], []]) {
      expect(splitArgs(joinArgs(args))).toEqual({ args });
    }
    expect(joinArgs(["--x", "C:\\My Models"])).toBe('--x "C:\\My Models"');
  });

  it("refuse where ComfyUI listens and keeps its files, abbreviated or with =", () => {
    expect(checkComfyArgs(["--lowvram", "--reserve-vram", "2", "--cache-ram", "8"])).toBeNull();
    expect(checkComfyArgs([])).toBeNull();
    expect(checkComfyArgs(["--listen", "0.0.0.0"])).toMatch(/^--listen can't be set/);
    expect(checkComfyArgs(["--liste"])).toMatch(/^--listen/);
    expect(checkComfyArgs(["--output-directory=D:\\out"])).toMatch(/^--output-directory/);
    expect(checkComfyArgs(["--tls-keyfile", "k"])).toMatch(/^--tls-keyfile/);
  });

  it("refuse what isn't a list of plain arguments", () => {
    expect(checkComfyArgs("--lowvram")).toMatch(/list/);
    expect(checkComfyArgs([1])).toMatch(/list/);
    expect(checkComfyArgs(["--a\nb"])).toMatch(/control character/);
    expect(checkComfyArgs(["lowvram"])).toMatch(/start with a flag/);
    expect(checkComfyArgs(Array(41).fill("--fast"))).toMatch(/At most 40/);
    expect(checkComfyArgs(["--x", "a".repeat(301)])).toMatch(/longer than 300/);
  });
});
