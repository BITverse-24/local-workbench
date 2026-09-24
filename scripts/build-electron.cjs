// Build the Electron main + preload bundles with esbuild (no new tooling).
// Output: electron/dist-electron/main.cjs (CJS, node platform) and preload.mjs.
// Native/unbundlable modules stay external and resolve from root node_modules
// at runtime. Run: `node scripts/build-electron.cjs` from the repository root.

const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUTDIR = path.join(ROOT, "electron", "dist-electron");

const shared = {
  bundle: true,
  platform: "node",
  target: "node18",
  logLevel: "info",
  external: ["electron", "better-sqlite3", "canvas", "@huggingface/transformers", "pdfjs-dist", "pdfjs-dist/*"],
};

function build() {
  buildSync({
    ...shared,
    entryPoints: [path.join(ROOT, "electron", "main.ts")],
    format: "cjs",
    outfile: path.join(OUTDIR, "main.cjs"),
  });
  buildSync({
    ...shared,
    entryPoints: [path.join(ROOT, "electron", "preload.ts")],
    // Preload must be CJS: Electron does not reliably load ESM preload
    // scripts, and a silently-skipped preload leaves the renderer with no
    // bridge (app falls back to local-only mode).
    format: "cjs",
    outfile: path.join(OUTDIR, "preload.cjs"),
  });
}

if (require.main === module) build();

module.exports = { build };
