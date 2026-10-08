import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/.runtime/**"],
    environment: "node",
    testTimeout: 30000,
    fileParallelism: false,
  },
});
