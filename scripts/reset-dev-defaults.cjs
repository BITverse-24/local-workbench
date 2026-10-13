const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

function appDataPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA || path.join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME || path.join(home, ".config");
}

function checkProfileClosed(profile) {
  let lock;
  try {
    lock = fs.readlinkSync(path.join(profile, "SingletonLock"));
  } catch (error) {
    if (["ENOENT", "EINVAL"].includes(error.code)) return;
    throw error;
  }
  const pid = Number(lock.match(/-(\d+)$/)?.[1]);
  if (!pid) throw new Error("Close the development app before packaging.");
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw new Error("Close the development app before packaging.");
  }
  throw new Error("Close the development app before packaging.");
}

function resetDevDefaults({ repoRoot, appData = appDataPath() }) {
  const profile = path.join(appData, "local-workbench", "development");
  checkProfileClosed(profile);

  // Desktop persistence adds a second data segment. CLI runs and older builds
  // also use the database directly under data. Reset settings in both stores.
  const databases = ["data/data/workbench.db", "data/workbench.db"];
  let settingsDeleted = 0;
  for (const relative of databases) {
    const filename = path.join(repoRoot, relative);
    if (!fs.existsSync(filename)) continue;
    const Database = require("better-sqlite3");
    const db = new Database(filename, { fileMustExist: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()) {
        settingsDeleted += db.prepare("DELETE FROM settings").run().changes;
      }
    } finally {
      db.close();
    }
  }

  // Both the source registry and onboarding backup can contain saved model IDs.
  const registry = `${JSON.stringify({ models: [] }, null, 2)}\n`;
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "models.json"), registry);
  fs.rmSync(path.join(repoRoot, "data", "models.json"), { force: true });

  // Chromium stores the selected model, execution mode, and panel preferences.
  for (const directory of ["Local Storage", "Session Storage"]) {
    fs.rmSync(path.join(profile, directory), { recursive: true, force: true });
  }
  return { settingsDeleted };
}

function main() {
  // Native SQLite is built for Electron. Use its Node runtime for the reset.
  if (!process.versions.electron) {
    const result = spawnSync(require("electron"), [__filename], {
      stdio: "inherit",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }
  const { settingsDeleted } = resetDevDefaults({ repoRoot: path.resolve(__dirname, "..") });
  console.log(`[package] Cleared development defaults (${settingsDeleted} saved settings), model registries, and browser preferences.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[package] Cannot clear development defaults: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { resetDevDefaults, appDataPath };
