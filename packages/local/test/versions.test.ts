import { describe, expect, it } from "vitest";
import { canRun, chooseBuild, compareVersions, parseNvidiaSmi, torchSpec } from "../src/versions.ts";

const nv = (computeCap: number, driver: number) => ({ computeCap, driver });

describe("the PyTorch build for a PC's GPU", () => {
  it("NVIDIA: by the oldest card's compute capability and the driver, not the driver alone", () => {
    const pick = (cap: number, driver: number) => {
      const b = chooseBuild("nvidia", nv(cap, driver));
      return [b.backend, b.spec, Boolean(b.note), Boolean(b.blocked)];
    };
    expect(pick(8.9, 610)).toEqual(["cu130", ">=2.9", false, false]); // RTX 40, a current driver
    expect(pick(12.0, 580)).toEqual(["cu130", ">=2.9", false, false]); // RTX 50
    expect(pick(7.5, 575)).toEqual(["cu128", ">=2.9,<2.12", true, false]); // a driver short of CUDA 13: a note
    expect(pick(8.6, 560)).toEqual(["cu126", ">=2.9,<2.15", true, false]);
    // GTX 10-series on a new driver: uv's auto gave it torch 2.15's CUDA 13 build, without its kernels
    expect(pick(6.1, 610)).toEqual(["cu126", ">=2.9,<2.15", false, false]);
    expect(pick(7.0, 610)[0]).toBe("cu126"); // Volta too
    expect(pick(12.0, 560)).toEqual(["cu128", ">=2.9,<2.12", false, true]); // RTX 50 on a driver too old: blocked
    expect(pick(8.6, 470)[3]).toBe(true); // below 525 no CUDA 12 build runs
    expect(pick(3.7, 470)).toEqual(["cpu", ">=2.9", true, false]); // Kepler: none at all
  });

  it("other GPUs: as before, but AMD on Windows named cpu (auto picks Intel's build beside Intel graphics)", () => {
    expect(chooseBuild("nvidia", null).backend).toBe("auto"); // nvidia-smi didn't say
    expect(chooseBuild("amd", null, "linux").backend).toBe("auto"); // ROCm
    expect(chooseBuild("amd", null, "win32").backend).toBe("cpu");
    expect(chooseBuild("intel", null).backend).toBe("xpu");
    expect(chooseBuild("mac", null).backend).toBe("auto");
    expect(chooseBuild("cpu", null).backend).toBe("cpu");
    expect(torchSpec("cpu")).toBe(">=2.9");
  });

  it("reads nvidia-smi: the lowest compute capability of several cards", () => {
    expect(parseNvidiaSmi("8.9, 580.82.07\n6.1, 580.82.07\n")).toEqual(nv(6.1, 580));
    expect(parseNvidiaSmi("12.0, 610.57.04\r\n")).toEqual(nv(12, 610));
    expect(parseNvidiaSmi("Field \"compute_cap\" is not a valid field to query.")).toBeNull(); // a driver before 510
    expect(parseNvidiaSmi("")).toBeNull();
  });

  it("whether an installed torch runs on the PC's cards", () => {
    expect(canRun("2.15.0+cu132", nv(6.1, 610))).toBe(false); // the GTX 10-series case
    expect(canRun("2.14.1+cu130", nv(6.1, 610))).toBe(false); // CUDA 13 has no Pascal either
    expect(canRun("2.14.1+cu126", nv(6.1, 610))).toBe(true);
    expect(canRun("2.14.1+cu126", nv(12.0, 610))).toBe(false); // Blackwell needs 12.8+
    expect(canRun("2.14.1+cu130", nv(8.9, 575))).toBe(false); // CUDA 13 needs driver 580
    expect(canRun("2.14.1+cu130", nv(8.9, 580))).toBe(true);
    expect(canRun("2.14.1+cpu", nv(8.9, 580))).toBe(true); // runs, on the CPU: not ours to judge here
    expect(canRun("2.14.1", nv(6.1, 610))).toBe(true); // no build tag (macOS, PyPI): nothing to go by
    expect(canRun("2.15.0+cu132", null)).toBe(true);
  });

  it("compares versions, build tags aside", () => {
    expect(compareVersions("2.14.1+cu130", "2.9")).toBe(1);
    expect(compareVersions("2.8.0+cu128", "2.9")).toBe(-1);
    expect(compareVersions("2.9.0", "2.9")).toBe(0);
    expect(compareVersions("0.44.2", "0.37.0")).toBe(1);
  });
});
