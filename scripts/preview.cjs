// Preview launcher. Runs the packaged-style static file-loading Electron lifecycle
// without running electron-builder.
// Builds the Electron bundles and spawns Electron with NODE_ENV=production.
// Run: `npm run preview` from the repository root.

const path = require("node:path");
const { spawn } = require("node:child_process");
const { build } = require("./build-electron.cjs");

const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "node_modules", ".bin");

function bin(name) {
  return process.platform === "win32" ? path.join(BIN, `${name}.cmd`) : path.join(BIN, name);
}

async function main() {
  build();
  const env = { ...process.env, NODE_ENV: "production" };
  const electron = spawn(bin("electron"), ["."], {
    cwd: ROOT,
    stdio: "inherit",
    env,
  });
  electron.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => electron.kill("SIGINT"));
}

main().catch((err) => {
  console.error(`[preview] failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
