const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const filesToPatch = [
  path.join(ROOT, "node_modules", "vectra", "lib", "LocalIndex.js"),
  path.join(ROOT, "node_modules", "vectra", "lib", "LocalDocumentIndex.js"),
  path.join(ROOT, "node_modules", "vectra", "lib", "server", "handlers", "itemHandlers.js"),
];

for (const file of filesToPatch) {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, "utf8");
    if (content.includes('const uuid_1 = require("uuid");')) {
      content = content.replace(
        'const uuid_1 = require("uuid");',
        'const uuid_1 = { v4: require("node:crypto").randomUUID };'
      );
      fs.writeFileSync(file, content, "utf8");
      console.log(`[patch-vectra] Patched ${path.relative(ROOT, file)}`);
    }
  }
}
