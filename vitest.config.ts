import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/test/*.test.js"],
    // Test files run in parallel, each with fake ComfyUIs: any free port, not all racing for 8188.
    env: { COMFY_GEN_COMFY_PORT: "0" },
  },
});
