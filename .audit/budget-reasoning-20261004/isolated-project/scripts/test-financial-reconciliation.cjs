/**
 * Strict evaluation of Custom Financial Reconciliation Scenario:
 * "Read these two reports, identify conflicting financial figures, use Python to reconcile the discrepancies, and generate a DOCX containing the findings."
 */
const fs = require("node:fs");
const path = require("node:path");
const { FlowRunner, ROOT } = require("./run-demo-flows.cjs");

async function runFinancialReconciliation() {
  console.log("================================================================================");
  console.log("⚡ STARTING CUSTOM TEST: Multi-Report Financial Reconciliation & DOCX Generation");
  console.log("================================================================================");

  const sandboxDir = path.join(ROOT, "tests/.runtime/sandboxes/financial_reconcile_live");
  const runner = new FlowRunner("Financial Reconcile", sandboxDir);

  // 1. Stage fixtures
  console.log("1. Staging financial report fixtures...");
  const report1 = path.join(ROOT, "tests/fixtures/financial_reconciliation/q3_internal_financial_summary.md");
  const report2 = path.join(ROOT, "tests/fixtures/financial_reconciliation/q3_external_audit_report.md");

  const configFile = runner.setupSandbox([]);

  // Copy attachments into sandbox
  fs.copyFileSync(report1, path.join(sandboxDir, "attachments/q3_internal_financial_summary.md"));
  fs.copyFileSync(report2, path.join(sandboxDir, "attachments/q3_external_audit_report.md"));

  // 2. Start worker
  console.log("2. Starting CLI worker...");
  await runner.startWorker(configFile);

  // 3. Send message
  const prompt = "Read these two reports, identify conflicting financial figures, use Python to reconcile the discrepancies, and generate a DOCX containing the findings.";
  console.log(`3. Sending prompt: "${prompt}"`);
  console.log("   Attachments: q3_internal_financial_summary.md, q3_external_audit_report.md");

  const sendResult = await runner.callCommand("send", {
    chat: "financial-chat",
    text: prompt,
    files: [
      "q3_internal_financial_summary.md",
      "q3_external_audit_report.md"
    ]
  });

  const runId = sendResult.runId;
  console.log(`   Run started with ID: ${runId}`);

  // 4. Wait for completion
  console.log("4. Awaiting run completion...");
  const startTime = Date.now();
  const outcome = await runner.waitForTerminalState(runId, 600000);
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n🏁 Run reached terminal state: ${outcome} in ${durationSec}s`);

  // 5. Query inspection state
  const inspection = await runner.callCommand("inspect");
  if (process.env.FLOW_AUDIT_OUTDIR) fs.writeFileSync(path.join(process.env.FLOW_AUDIT_OUTDIR, "events.json"), JSON.stringify(runner.events, null, 2));
  await runner.shutdown();

  // 6. Strict Evaluation
  console.log("\n================================================================================");
  console.log("🔍 STRICT EVALUATION REPORT FOR FINANCIAL RECONCILIATION");
  console.log("================================================================================");

  const checks = [];
  function evaluate(name, passed, details = "") {
    checks.push({ name, passed, details });
    console.log(`${passed ? "✅ PASS" : "❌ FAIL"}: ${name} ${details ? "(" + details + ")" : ""}`);
  }

  // Check 1: Terminal outcome must be "completed"
  evaluate("Run Outcome is 'completed'", outcome === "completed", `actual: ${outcome}`);

  // Check 2: Modal confirmations count <= 1
  evaluate("Modal Confirmations <= 1", runner.confirmationsCount <= 1, `actual: ${runner.confirmationsCount}`);

  // Check 3: Assistant message produced
  const chatMessages = inspection.messages.filter((m) => m.role === "assistant");
  const assistantText = chatMessages.map((m) => m.content).join("\n\n");
  evaluate("Assistant message produced", assistantText.length > 200, `length: ${assistantText.length} chars`);

  // Check 4: Revenue discrepancy identified ($850k or 18.45M vs 17.6M)
  const hasRevenueDiscrepancy = (/850/i.test(assistantText) || /18,450/i.test(assistantText) || /17,600/i.test(assistantText)) &&
    (/revenue/i.test(assistantText) || /gross/i.test(assistantText) || /defer/i.test(assistantText) || /titan/i.test(assistantText));
  evaluate("Identified Revenue discrepancy (-$850,000 / Titan project)", hasRevenueDiscrepancy);

  // Check 5: COGS or Operating Income discrepancy identified ($420k / $1.4M / EBIT / loss)
  const hasCogsOrEbitDiscrepancy = (/420/i.test(assistantText) || /11,200/i.test(assistantText) || /11,620/i.test(assistantText) ||
    /1,400/i.test(assistantText) || /1,350/i.test(assistantText) || /50,000/i.test(assistantText) || /shipping/i.test(assistantText));
  evaluate("Identified COGS / Operating Income discrepancy ($420k COGS / $1.4M EBIT)", hasCogsOrEbitDiscrepancy);

  // Check 6: Net Income discrepancy identified ($1.05M or $877.5k vs -$172.5k)
  const hasNetIncomeDiscrepancy = (/1,050/i.test(assistantText) || /877/i.test(assistantText) || /172/i.test(assistantText) || /loss/i.test(assistantText));
  evaluate("Identified Net Income discrepancy (-$1,050,000 delta / swing to loss)", hasNetIncomeDiscrepancy);

  // Check 7: Python tool was invoked for computation (execute_python or run_command)
  const pythonEvents = runner.events.filter((e) =>
    e.type === "tool_call" && (e.tool === "execute_python" || e.tool === "run_command")
  );
  evaluate("Python tool invoked for reconciliation computation", pythonEvents.length > 0, `invocations: ${pythonEvents.length}`);

  // Check 8: Valid .docx deliverable compiled on disk
  const runOutputDir = path.join(sandboxDir, `data/runs/${runId}/output`);
  let docxArtifactFound = false;
  let artifactName = "";
  let artifactSize = 0;
  if (fs.existsSync(runOutputDir)) {
    const files = fs.readdirSync(runOutputDir);
    const docxFiles = files.filter((f) => f.endsWith(".docx"));
    if (docxFiles.length > 0) {
      artifactName = docxFiles[0];
      const docxPath = path.join(runOutputDir, artifactName);
      artifactSize = fs.statSync(docxPath).size;
      const header = fs.readFileSync(docxPath, { flag: "r" }).subarray(0, 4);
      const isZip = header[0] === 0x50 && header[1] === 0x4b;
      docxArtifactFound = isZip && artifactSize > 1000;
    }
  }
  evaluate("Valid .docx Deliverable on Disk", docxArtifactFound, `file: ${artifactName || "none"}, size: ${artifactSize} bytes`);

  const allPassed = checks.every((c) => c.passed);
  console.log("--------------------------------------------------------------------------------");
  console.log(`Financial Reconciliation Summary: ${allPassed ? "🎉 ALL CHECKS PASSED (100%)" : "⚠️ SOME CHECKS FAILED"}`);
  console.log("================================================================================\n");

  if (!allPassed) {
    console.log("Assistant Text Excerpt:\n", assistantText.slice(0, 1500));
    process.exitCode = 1;
  }
}

runFinancialReconciliation().catch((err) => {
  console.error("FATAL ERROR in Financial Reconciliation:", err);
  process.exitCode = 2;
});
