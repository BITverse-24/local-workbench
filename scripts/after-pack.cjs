const path = require("node:path");
const { spawnSync } = require("node:child_process");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const root = path.resolve(__dirname, "..");
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const result = spawnSync("xcrun", [
    "swift", path.join(__dirname, "apply-macos-icon.swift"),
    appPath, path.join(root, "build", "icons", "icon.icns"),
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Failed to apply the transparent macOS app icon.");
};
