import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["backend/tests/**/*.test.ts", "ai/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
  },
});
