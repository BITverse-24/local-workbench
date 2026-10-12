// Build every app icon from root icon.png. Temporary size variants stay outside
// the project; only the platform files and frontend PNG are retained.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// canvas is installed for Electron's native ABI, as used by the desktop app.
if (!process.versions.electron) {
  const result = spawnSync(require("electron"), [__filename], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { createCanvas, loadImage } = require("canvas");
const { runIconsTool } = require("app-builder-lib/out/toolsets/icons");
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "build", "icons");

async function build() {
  const source = await loadImage(path.join(ROOT, "icon.png"));
  const original = createCanvas(source.width, source.height);
  const originalContext = original.getContext("2d");
  originalContext.drawImage(source, 0, 0);
  const pixels = originalContext.getImageData(0, 0, source.width, source.height).data;
  let left = source.width, top = source.height, right = 0, bottom = 0;
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      // Ignore near-invisible export specks when finding the artwork bounds.
      if (pixels[(y * source.width + x) * 4 + 3] < 8) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
  }
  if (right <= left || bottom <= top) throw new Error("icon.png has no visible artwork");
  left = Math.max(0, left - 2); top = Math.max(0, top - 2);
  right = Math.min(source.width, right + 2); bottom = Math.min(source.height, bottom + 2);
  const width = right - left, height = bottom - top;
  const canvas = createCanvas(1024, 1024);
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  const scale = 960 / Math.max(width, height);
  const targetWidth = width * scale, targetHeight = height * scale;
  context.drawImage(source, left, top, width, height,
    (1024 - targetWidth) / 2, (1024 - targetHeight) / 2, targetWidth, targetHeight);
  fs.mkdirSync(OUTPUT, { recursive: true });
  const png = canvas.toBuffer("image/png");
  fs.writeFileSync(path.join(OUTPUT, "icon.png"), png);
  const frontendIcon = path.join(ROOT, "frontend", "public", "icon.png");
  fs.mkdirSync(path.dirname(frontendIcon), { recursive: true });
  fs.writeFileSync(frontendIcon, png);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-icons-"));
  try {
    for (const format of ["icns", "ico"]) {
      const directory = path.join(temporary, format);
      fs.mkdirSync(directory);
      await runIconsTool({ inputFile: path.join(OUTPUT, "icon.png"), outputFormat: format, outDir: directory });
      fs.copyFileSync(path.join(directory, `icon.${format}`), path.join(OUTPUT, `icon.${format}`));
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log("App icons updated from icon.png: transparent, centered, with original proportions.");
}

build().catch(error => { console.error(error); process.exitCode = 1; });
