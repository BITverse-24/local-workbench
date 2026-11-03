const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildSync } = require("esbuild");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "../..");
const BUILD_DIR = path.join(ROOT, "tests/.runtime/build");
fs.mkdirSync(BUILD_DIR, { recursive: true });

const ENTRY_TS = path.join(ROOT, "tests/eval/runner.ts");
const OUT_CJS = path.join(BUILD_DIR, "eval-runner.cjs");

// Parse args
const argv = process.argv.slice(2);
let tier = "smoke";
let k = 1;
let model = "qwen/qwen3.5-9b";
let output = null;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--tier" && argv[i + 1]) tier = argv[++i];
  else if (argv[i] === "--k" && argv[i + 1]) k = parseInt(argv[++i], 10);
  else if (argv[i] === "--model" && argv[i + 1]) model = argv[++i];
  else if (argv[i] === "--output" && argv[i + 1]) output = argv[++i];
}

console.log(`Bundling eval runner (${ENTRY_TS} -> ${OUT_CJS})...`);
buildSync({
  entryPoints: [ENTRY_TS],
  outfile: OUT_CJS,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  packages: "external",
  logLevel: "error"
});

// Create a launcher script to execute runner
const LAUNCHER_CJS = path.join(BUILD_DIR, "launch-eval.cjs");
fs.writeFileSync(
  LAUNCHER_CJS,
  `const { runEvalSuite } = require("./eval-runner.cjs");
runEvalSuite({
  tier: ${JSON.stringify(tier)},
  k: ${k},
  modelId: ${JSON.stringify(model)},
  outputFile: ${JSON.stringify(output)}
}).catch(err => {
  console.error("Eval suite failed:", err);
  process.exit(1);
});
`,
  "utf8"
);

const electron = require("electron");
const child = spawn(electron, [LAUNCHER_CJS], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    WORKBENCH_AGENT_V3: "true",
    NODE_ENV: "development"
  }
});

child.on("error", (err) => {
  console.error("Child process error:", err);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
