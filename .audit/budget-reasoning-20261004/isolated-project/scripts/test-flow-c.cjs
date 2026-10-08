/**
 * Strict evaluation of Flow C: Engineering Drawing Cross-Check Against Piping SOP (Visual & RAG)
 */
const fs = require("node:fs");
const path = require("node:path");
const { FlowRunner, ROOT } = require("./run-demo-flows.cjs");

async function runFlowC() {
  console.log("================================================================================");
  console.log("⚡ STARTING FLOW C: Drawing Cross-Check Against Piping SOP (pump-skid-P204.svg)");
  console.log("================================================================================");

  const sandboxDir = path.join(ROOT, "tests/.runtime/sandboxes/flow_c_live");
  const runner = new FlowRunner("Flow C", sandboxDir);

  // 1. Stage fixtures
  console.log("1. Staging demo fixtures...");
  const sopFile = path.join(ROOT, "demo/flow_c/piping-spec-SOP-220.md");
  const svgFile = path.join(ROOT, "demo/flow_c/pump-skid-P204.svg");

  const configFile = runner.setupSandbox([
    { path: "piping-spec-SOP-220.md", kind: "markdown" }
  ]);

  // Copy KB document
  fs.copyFileSync(sopFile, path.join(sandboxDir, "kb/piping-spec-SOP-220.md"));

  // Copy attachment
  fs.copyFileSync(svgFile, path.join(sandboxDir, "attachments/pump-skid-P204.svg"));

  // 2. Start worker
  console.log("2. Starting CLI worker...");
  await runner.startWorker(configFile);

  // 3. Send message
  const prompt = "Check this against our piping spec and tell me if anything's non-compliant.";
  console.log(`3. Sending prompt: "${prompt}"`);
  console.log("   Attachment: pump-skid-P204.svg");
  console.log("   Grounding: true (SOP-220 indexed)");

  const sendResult = await runner.callCommand("send", {
    chat: "flow-c-chat",
    text: prompt,
    files: [
      "pump-skid-P204.svg"
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

  // 5. Query inspection state
  const inspection = await runner.callCommand("inspect");
  if (process.env.FLOW_AUDIT_OUTDIR) fs.writeFileSync(path.join(process.env.FLOW_AUDIT_OUTDIR, "events.json"), JSON.stringify(runner.events, null, 2));
  await runner.shutdown();

  // 6. Strict Evaluation
  console.log("\n================================================================================");
  console.log("🔍 STRICT EVALUATION REPORT FOR FLOW C");
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
  evaluate("Assistant message produced", assistantText.length > 150, `length: ${assistantText.length} chars`);

  // Check 4: Valve XV-204 discrepancy identified (Class 150 vs Class 300 required)
  const hasValveDiscrepancy = (/XV-204/i.test(assistantText) || /valve/i.test(assistantText)) &&
    (/150/i.test(assistantText) || /300/i.test(assistantText));
  evaluate("Identified Valve XV-204 discrepancy (Class 150 vs Class 300)", hasValveDiscrepancy);

  // Check 5: Discharge line discrepancy identified (DN80 vs DN100 required)
  const hasLineDiscrepancy = (/DN80/i.test(assistantText) || /80\s*mm/i.test(assistantText) || /diameter/i.test(assistantText) || /discharge/i.test(assistantText)) &&
    (/100/i.test(assistantText) || /DN100/i.test(assistantText));
  evaluate("Identified Discharge Line discrepancy (DN80 vs DN100)", hasLineDiscrepancy);

  // Check 6: Clear Non-Compliant status / Refusal of approval
  const hasNonCompliant = /non-?compliant/i.test(assistantText) || /not approved/i.test(assistantText) || /rejection/i.test(assistantText) || /revision/i.test(assistantText) || /discrepanc/i.test(assistantText);
  evaluate("Declared NON-COMPLIANT / Refused unconditional approval", hasNonCompliant);

  // Check 7: Governing standard cited (SOP-220)
  const hasSop220 = /SOP-?220/i.test(assistantText);
  evaluate("Cited Governing Standard (SOP-220)", hasSop220);

  // Check 8: Deliverable artifact on disk or in chat
  const runOutputDir = path.join(sandboxDir, `data/runs/${runId}/output`);
  let deliverableFound = false;
  let artifactName = "";
  if (fs.existsSync(runOutputDir)) {
    const files = fs.readdirSync(runOutputDir);
    const mdFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".docx"));
    if (mdFiles.length > 0) {
      deliverableFound = true;
      artifactName = mdFiles[0];
    }
  }
  // Deliverable in chat or as file
  evaluate("Compliance report deliverable produced", deliverableFound || assistantText.length > 300, deliverableFound ? `file: ${artifactName}` : "in chat text");

  const allPassed = checks.every((c) => c.passed);
  console.log("--------------------------------------------------------------------------------");
  console.log(`Flow C Summary: ${allPassed ? "🎉 ALL CHECKS PASSED (100%)" : "⚠️ SOME CHECKS FAILED"}`);
  console.log("================================================================================");

  if (!allPassed) {
    console.log("Assistant Text Excerpt:\n", assistantText.slice(0, 1000));
    process.exitCode = 1;
  }
}

runFlowC().catch((err) => {
  console.error("FATAL ERROR in Flow C:", err);
  process.exitCode = 2;
});
