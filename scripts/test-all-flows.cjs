/**
 * Master Verification: Runs Flow A, Flow B, and Flow C sequentially.
 * Verifies 100% pass rate across all three canonical demonstration flows.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const flows = [
  { name: "Flow A (Scanned Inspection -> Approval Note .docx)", script: "scripts/test-flow-a.cjs" },
  { name: "Flow B (Python Sandbox Repair broken-vendor-log-parser.py)", script: "scripts/test-flow-b.cjs" },
  { name: "Flow C (Drawing Cross-Check Against Piping SOP-220)", script: "scripts/test-flow-c.cjs" },
  { name: "Custom Scenario (Multi-Report Financial Reconciliation & DOCX)", script: "scripts/test-financial-reconciliation.cjs" },
];

console.log("================================================================================");
console.log("🚀 RUNNING MASTER VERIFICATION SUITE: FLOW A, FLOW B, FLOW C");
console.log("================================================================================\n");

const results = [];

for (const flow of flows) {
  console.log(`\n▶ Starting ${flow.name}...`);
  const startTime = Date.now();
  const res = spawnSync("node", [flow.script], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 600000,
  });
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const passed = res.status === 0;
  results.push({ ...flow, passed, durationSec, status: res.status });
  console.log(`\n◀ Completed ${flow.name}: ${passed ? "✅ PASS" : "❌ FAIL"} in ${durationSec}s\n`);
}

console.log("\n================================================================================");
console.log("📊 MASTER DEMO VERIFICATION SCORECARD");
console.log("================================================================================");

let allPassed = true;
for (const r of results) {
  console.log(`${r.passed ? "✅ PASS" : "❌ FAIL"} - ${r.name} (${r.durationSec}s)`);
  if (!r.passed) allPassed = false;
}

console.log("--------------------------------------------------------------------------------");
console.log(`Final Outcome: ${allPassed ? "🎉 100% PASS - ALL 3 FLOWS SUCCEEDED!" : "⚠️ ONE OR MORE FLOWS FAILED"}`);
console.log("================================================================================\n");

process.exit(allPassed ? 0 : 1);
