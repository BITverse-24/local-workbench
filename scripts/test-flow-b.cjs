const { spawnSync } = require("node:child_process");
const path = require("node:path");
const result = spawnSync(process.execPath, [path.join(__dirname, "benchmark-demo-latency.cjs")], {
  cwd: path.resolve(__dirname, ".."), stdio: "inherit",
  env: { ...process.env, DEMO_FLOWS: "B", DEMO_ROUNDS: process.env.DEMO_ROUNDS || "1" },
});
process.exitCode = result.status ?? 1;
