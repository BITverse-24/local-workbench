/**
 * Strict evaluation of Flow A: Scanned Inspection Bundle to Formal Approval Note (.docx)
 */
const fs = require("node:fs");
const path = require("node:path");
const { FlowRunner, ROOT } = require("./run-demo-flows.cjs");

async function runFlowA() {
  console.log("================================================================================");
  console.log("⚡ STARTING FLOW A: Scanned Inspection Reports -> Approval Note (.docx)");
  console.log("================================================================================");

  const sandboxDir = path.join(ROOT, "tests/.runtime/sandboxes/flow_a_live");
  const runner = new FlowRunner("Flow A", sandboxDir);

  // 1. Stage fixtures
  console.log("1. Staging demo fixtures...");
  const sopFile = path.join(ROOT, "demo/flow_a/sop-114-pressure-equipment-inspection.md");
  const pdf1 = path.join(ROOT, "demo/flow_a/inspection-report-E201-annotated.pdf");
  const pdf2 = path.join(ROOT, "demo/flow_a/inspection-report-E202-followup.pdf");

  const configFile = runner.setupSandbox([
    { path: "sop-114-pressure-equipment-inspection.md", kind: "markdown" }
  ]);

  // Copy KB document
  fs.copyFileSync(sopFile, path.join(sandboxDir, "kb/sop-114-pressure-equipment-inspection.md"));

  // Copy attachments
  fs.copyFileSync(pdf1, path.join(sandboxDir, "attachments/inspection-report-E201-annotated.pdf"));
  fs.copyFileSync(pdf2, path.join(sandboxDir, "attachments/inspection-report-E202-followup.pdf"));

  // 2. Start worker
  console.log("2. Starting CLI worker...");
  await runner.startWorker(configFile);

  // 3. Send message
  const prompt = "Read these inspection reports, pull out the key findings, and draft an approval note for the plant manager.";
  console.log(`3. Sending prompt: "${prompt}"`);
  console.log("   Attachments: inspection-report-E201-annotated.pdf, inspection-report-E202-followup.pdf");
  console.log("   Grounding: true (SOP-114 indexed)");

  const sendResult = await runner.callCommand("send", {
    chat: "flow-a-chat",
    text: prompt,
    files: [
      "inspection-report-E201-annotated.pdf",
      "inspection-report-E202-followup.pdf"
    ],
    groundingEnabled: true
  });

  const runId = sendResult.runId;
  console.log(`   Run started with ID: ${runId}`);

  // 4. Wait for completion
  console.log("4. Awaiting run completion...");
  const startTime = Date.now();
  const outcome = await runner.waitForTerminalState(runId, 480000);
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n🏁 Run reached terminal state: ${outcome} in ${durationSec}s`);

  // 5. Query inspection state (messages, artifacts)
  const inspection = await runner.callCommand("inspect");
  await runner.shutdown();

  // 6. Strict Evaluation
  console.log("\n================================================================================");
  console.log("🔍 STRICT EVALUATION REPORT FOR FLOW A");
  console.log("================================================================================");

  const checks = [];
  function evaluate(name, passed, details = "") {
    checks.push({ name, passed, details });
    console.log(`${passed ? "✅ PASS" : "❌ FAIL"}: ${name} ${details ? "(" + details + ")" : ""}`);
  }

  // Check 1: Terminal outcome must be "completed"
  evaluate("Run Outcome is 'completed'", outcome === "completed", `actual: ${outcome}`);

  // Check 2: Upfront confirmation count should be reasonable (at most 1)
  evaluate("Modal Confirmations <= 1", runner.confirmationsCount <= 1, `actual: ${runner.confirmationsCount}`);

  // Check 3: Messages in chat
  const chatMessages = inspection.messages.filter((m) => m.role === "assistant");
  const assistantText = chatMessages.map((m) => m.content).join("\n\n");
  evaluate("Assistant message produced", assistantText.length > 200, `length: ${assistantText.length} chars`);

  // Check 4: Finding extraction: Tube wall thickness (2.1 mm)
  const hasTubeWall = /2\.1\s*(?:mm)?/i.test(assistantText) || /tube\s*wall/i.test(assistantText);
  evaluate("Identified Tube Wall Thickness measurement (2.1 mm)", hasTubeWall);

  // Check 5: Finding extraction: Pitting
  const hasPitting = /pitting/i.test(assistantText);
  evaluate("Identified Pitting anomaly", hasPitting);

  // Check 6: Finding extraction: Handwritten annotation "RECHECK WELD JOINT 4B"
  const hasWeld4B = /4B/i.test(assistantText) || /weld/i.test(assistantText);
  evaluate("Identified Handwritten Inspector Note (Weld Joint 4B)", hasWeld4B);

  // Check 7: Governing standard cited (SOP-114)
  const hasSop114 = /SOP-?114/i.test(assistantText);
  evaluate("Cited Governing Standard (SOP-114)", hasSop114);

  // Check 8: Safety condition / caveat (Conditional clearance / not unconditionally approved)
  const hasConditional = /conditional/i.test(assistantText) || /withhold/i.test(assistantText) || /not approved/i.test(assistantText) || /pending/i.test(assistantText) || /recheck/i.test(assistantText) || /subject to/i.test(assistantText);
  evaluate("Refused unconditional approval / Flagged safety requirement", hasConditional);

  // Check 9: Deliverable artifact on disk
  const runOutputDir = path.join(sandboxDir, `data/runs/${runId}/output`);
  let docxArtifactFound = false;
  let artifactSize = 0;
  if (fs.existsSync(runOutputDir)) {
    const files = fs.readdirSync(runOutputDir);
    const docxFiles = files.filter((f) => f.endsWith(".docx"));
    if (docxFiles.length > 0) {
      const docxPath = path.join(runOutputDir, docxFiles[0]);
      artifactSize = fs.statSync(docxPath).size;
      const header = fs.readFileSync(docxPath, { flag: "r" }).subarray(0, 4);
      // PK zip magic header is 0x50, 0x4B, 0x03, 0x04
      const isZip = header[0] === 0x50 && header[1] === 0x4b;
      docxArtifactFound = isZip && artifactSize > 1000;
      evaluate("Valid .docx Deliverable on Disk", docxArtifactFound, `file: ${docxFiles[0]}, size: ${artifactSize} bytes`);
    } else {
      evaluate("Valid .docx Deliverable on Disk", false, `no .docx in ${files.join(", ")}`);
    }
  } else {
    evaluate("Valid .docx Deliverable on Disk", false, `output dir does not exist`);
  }

  const allPassed = checks.every((c) => c.passed);
  console.log("--------------------------------------------------------------------------------");
  console.log(`Flow A Summary: ${allPassed ? "🎉 ALL CHECKS PASSED (100%)" : "⚠️ SOME CHECKS FAILED"}`);
  console.log("================================================================================\n");

  if (!allPassed) {
    console.log("Assistant Text Excerpt:\n", assistantText.slice(0, 1000));
    process.exitCode = 1;
  }
}

runFlowA().catch((err) => {
  console.error("FATAL ERROR in Flow A:", err);
  process.exitCode = 2;
});
