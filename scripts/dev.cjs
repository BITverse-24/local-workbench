// Root dev launcher. Electron owns the Vite child-process lifecycle, so this
// script only builds the Electron bundles and spawns Electron itself.
// Run: `npm run dev` from the repository root.

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
  const electron = spawn(bin("electron"), ["."], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  electron.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => electron.kill("SIGINT"));
}

main().catch((err) => {
  console.error(`[dev] failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
