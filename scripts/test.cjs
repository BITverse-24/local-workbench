const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "node_modules", ".bin");

function bin(name) {
  return process.platform === "win32" ? path.join(BIN, `${name}.cmd`) : path.join(BIN, name);
}

const electron = bin("electron");
const vitest = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const args = [vitest, "run", ...process.argv.slice(2)];

const child = spawn(electron, args, {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    WORKBENCH_AGENT_V2: process.env.WORKBENCH_AGENT_V2 ?? "false",
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
