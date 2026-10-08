/**
 * Phase 2 Benchmark: Dynamic Capability Dispatch & Execution Envelope
 * Measures Turn 1 schema token counts across execution modes and verifies token reduction.
 */
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const testScript = path.join(ROOT, "scripts", "test.cjs");
const testFile = "backend/tests/benchmark-phase2.test.ts";

const child = spawn(process.execPath, [testScript, testFile], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
