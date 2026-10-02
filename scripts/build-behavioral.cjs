const path = require("node:path");
const { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "..");
for (const [source, name] of [["tests/harness/cli.ts", "worker"], ["tests/supervisor.ts", "supervisor"], ["tests/bridge-smoke/main.ts", "bridge-smoke"], ["electron/preload.ts", "preload"]]) {
  buildSync({ entryPoints: [path.join(root, source)], outfile: path.join(root, "tests/.runtime/build", `${name}.cjs`), bundle: true, platform: "node", target: "node20", format: "cjs", packages: "external", logLevel: "error", define: { "import.meta.url": "undefined" } });
}
