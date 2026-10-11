// Run the smoke bundle inside a native unpacked Electron package.
const path = require("node:path");
const { readdirSync, existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const version = require("../package.json").version;
const release = path.join(ROOT, "release", version);
const candidates = [];
for (const directory of readdirSync(release, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
  const base = path.join(release, directory.name);
  if (process.platform === "darwin" && directory.name.startsWith("mac")) {
    const app = path.join(base, "Local Workbench.app", "Contents");
    candidates.push({ binary: path.join(app, "MacOS", "Local Workbench"), resources: path.join(app, "Resources") });
  } else if (process.platform === "win32" && directory.name === "win-unpacked") {
    candidates.push({ binary: path.join(base, "Local Workbench.exe"), resources: path.join(base, "resources") });
  } else if (process.platform === "linux" && directory.name === "linux-unpacked") {
    candidates.push({ binary: path.join(base, "local-workbench"), resources: path.join(base, "resources") });
  }
}
const target = candidates.find(candidate => existsSync(candidate.binary));
if (!target) throw new Error("Native unpacked package missing. Build with WORKBENCH_BUILD_SMOKE=1 npm run package:dir first.");
const smoke = path.join(target.resources, "app.asar", "electron", "dist-electron", "portability-smoke.cjs");
const result = spawnSync(target.binary, [smoke], { cwd: ROOT, stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
