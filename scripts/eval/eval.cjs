#!/usr/bin/env node
/**
 * Eval launcher: bundles the TypeScript eval CLI and the backend worker, then runs the CLI
 * under Electron's Node runtime so native modules match the app's ABI.
 *
 *   npm run eval -- run --suite smoke --k 1
 *   npm run eval:validate
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "../..");
const BUILD = path.join(ROOT, "tests/.runtime/build");
fs.mkdirSync(BUILD, { recursive: true });

const common = { bundle: true, platform: "node", target: "node22", format: "cjs", packages: "external", logLevel: "error", define: { "import.meta.url": "undefined" } };
buildSync({ ...common, entryPoints: [path.join(ROOT, "tests/eval/cli.ts")], outfile: path.join(BUILD, "eval-cli.cjs") });
// The worker is the real backend; always rebuild so the eval never measures a stale bundle.
buildSync({ ...common, entryPoints: [path.join(ROOT, "tests/harness/cli.ts")], outfile: path.join(BUILD, "worker.cjs") });

const electron = require("electron");
const child = spawn(electron, [path.join(BUILD, "eval-cli.cjs"), ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: process.env.NODE_ENV || "development" },
});
child.on("error", (err) => {
  console.error("Eval process error:", err);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
