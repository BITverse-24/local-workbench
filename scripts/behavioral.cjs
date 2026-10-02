const { spawn } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const electron = require("electron");
const command = process.argv[2] ?? "help";
if (command === "bridge-smoke") {
  const child = spawn(electron, [path.join(root, "tests/.runtime/build/bridge-smoke.cjs")], { cwd: root, stdio: "inherit", env: { PATH: process.env.PATH, LANG: process.env.LANG, WORKBENCH_AGENT_V2: "true" } });
  child.on("error", (error) => { console.error(error.message); process.exitCode = 2; });
  child.on("exit", (code) => { process.exitCode = code ?? 2; });
  return;
}
const isTest = command === "test";
const args = isTest ? [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "tests/vitest.config.ts", ...process.argv.slice(3)] : [path.join(root, "tests/.runtime/build/supervisor.cjs"), command, ...process.argv.slice(3)];
const child = spawn(electron, args, { cwd: root, stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", WORKBENCH_AGENT_V2: "true" } });
child.on("error", (error) => { console.error(error.message); process.exitCode = 2; });
child.on("exit", (code) => { process.exitCode = code ?? 2; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child.kill(signal); });
