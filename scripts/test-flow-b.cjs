/**
 * Strict evaluation of Flow B: Repair & Verify Internal Vendor-Log Utility (Python Sandbox)
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { FlowRunner, ROOT } = require("./run-demo-flows.cjs");

async function runFlowB() {
  console.log("================================================================================");
  console.log("⚡ STARTING FLOW B: Python Sandbox Repair (broken-vendor-log-parser.py)");
  console.log("================================================================================");

  const sandboxDir = path.join(ROOT, "tests/.runtime/sandboxes/flow_b_live");
  const runner = new FlowRunner("Flow B", sandboxDir);

  // 1. Stage fixtures
  console.log("1. Staging demo fixtures...");
  const scriptFile = path.join(ROOT, "demo/flow_b/broken-vendor-log-parser.py");
  const csvFile = path.join(ROOT, "demo/flow_b/vendor-maintenance-log.csv");

  const configFile = runner.setupSandbox([]);

  // Copy attachments
  fs.copyFileSync(scriptFile, path.join(sandboxDir, "attachments/broken-vendor-log-parser.py"));
  fs.copyFileSync(csvFile, path.join(sandboxDir, "attachments/vendor-maintenance-log.csv"));

  // Also stage in workspace so that if model looks in workspace or output, it finds it
  fs.copyFileSync(scriptFile, path.join(sandboxDir, "workspace/broken-vendor-log-parser.py"));
  fs.copyFileSync(csvFile, path.join(sandboxDir, "workspace/vendor-maintenance-log.csv"));

  // 2. Start worker
  console.log("2. Starting CLI worker...");
  await runner.startWorker(configFile);

  // 3. Send message
  const prompt = process.env.FLOW_B_PROMPT || "This is crashing on our vendor log files. Fix it and make sure it actually works.";
  console.log(`3. Sending prompt: "${prompt}"`);
  console.log("   Attachments: broken-vendor-log-parser.py, vendor-maintenance-log.csv");

  const sendResult = await runner.callCommand("send", {
    chat: "flow-b-chat",
    text: prompt,
    files: [
      "broken-vendor-log-parser.py",
      "vendor-maintenance-log.csv"
    ]
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
  await runner.shutdown();

  // 6. Strict Evaluation
  console.log("\n================================================================================");
  console.log("🔍 STRICT EVALUATION REPORT FOR FLOW B");
  console.log("================================================================================");

  const checks = [];
  function evaluate(name, passed, details = "") {
    checks.push({ name, passed, details });
    console.log(`${passed ? "✅ PASS" : "❌ FAIL"}: ${name} ${details ? "(" + details + ")" : ""}`);
  }

  // Check 1: Terminal outcome must be "completed"
  evaluate("Run Outcome is 'completed'", outcome === "completed", `actual: ${outcome}`);

  // Check 2: Modal confirmation count should be EXACTLY 1 (No repeated popup churn)
  evaluate("Modal Confirmations <= 1", runner.confirmationsCount <= 1, `actual: ${runner.confirmationsCount}`);

  // Check 3: Assistant messages produced
  const chatMessages = inspection.messages.filter((m) => m.role === "assistant");
  const assistantText = chatMessages.map((m) => m.content).join("\n\n");
  evaluate("Assistant message produced", assistantText.length > 100, `length: ${assistantText.length} chars`);

  // Check 4: Diagnosis of empty string / float cast defect
  const hasFloatDiagnosis = /float/i.test(assistantText) || /empty/i.test(assistantText) || /ValueError/i.test(assistantText) || /missing/i.test(assistantText);
  evaluate("Diagnosed float conversion / missing value bug", hasFloatDiagnosis);

  // Check 5: Diagnosis of 350.0 boundary defect
  const hasBoundaryDiagnosis = /350/i.test(assistantText) || /threshold/i.test(assistantText) || /inclusive/i.test(assistantText) || />=/i.test(assistantText);
  evaluate("Diagnosed 350.0 boundary condition bug", hasBoundaryDiagnosis);

  // Check 6: Check for repaired Python script on disk
  const runOutputDir = path.join(sandboxDir, `data/runs/${runId}/output`);
  const intermediateDir = path.join(sandboxDir, `data/runs/${runId}/intermediate`);
  const workspaceDir = path.join(sandboxDir, "workspace");

  let repairedScriptPath = null;
  // Look in output, intermediate, or workspace
  const candidateDirs = [runOutputDir, intermediateDir, workspaceDir];
  for (const cDir of candidateDirs) {
    if (fs.existsSync(cDir)) {
      const pyFiles = fs.readdirSync(cDir).filter((f) => f.endsWith(".py") && !f.startsWith("test_"));
      for (const pyFile of pyFiles) {
        const fullPath = path.join(cDir, pyFile);
        const code = fs.readFileSync(fullPath, "utf8");
        // Check if code contains fix (handles ValueError or empty check, and >= 350)
        if ((code.includes("try") || code.includes("strip") || code.includes("if not") || code.includes("ValueError") || code.includes("is not None") || code.includes('== ""') || code.includes("is None")) &&
            (code.includes("350") || code.includes(">="))) {
          repairedScriptPath = fullPath;
          break;
        }
      }
    }
    if (repairedScriptPath) break;
  }

  // Also check if code was provided in the assistant message as a code block
  let codeFromChat = null;
  const codeBlockMatch = assistantText.match(/```(?:python)?\s*([\s\S]*?def[\s\S]*?)```/i);
  if (codeBlockMatch && !repairedScriptPath) {
    const extractedCode = codeBlockMatch[1];
    const targetPath = path.join(sandboxDir, "repaired_from_chat.py");
    fs.writeFileSync(targetPath, extractedCode);
    repairedScriptPath = targetPath;
    codeFromChat = true;
  }

  evaluate("Repaired Python script located", Boolean(repairedScriptPath), repairedScriptPath ? path.basename(repairedScriptPath) : "not found");

  // Check 7: Execute repaired script independently against vendor-maintenance-log.csv
  let executionPassed = false;
  let execDetails = "";
  if (repairedScriptPath) {
    const csvDest = path.join(path.dirname(repairedScriptPath), "vendor-maintenance-log.csv");
    if (!fs.existsSync(csvDest)) {
      fs.copyFileSync(csvFile, csvDest);
    }

    const execResult = spawnSync("python3", [repairedScriptPath, csvDest], {
      cwd: path.dirname(repairedScriptPath),
      encoding: "utf8",
      timeout: 10000
    });

    if (execResult.status === 0) {
      executionPassed = true;
      execDetails = `Exit 0; stdout: ${execResult.stdout.trim().replace(/\n/g, "; ")}`;
    } else {
      // Maybe script expects no argument or hardcoded file
      const execResult2 = spawnSync("python3", [repairedScriptPath], {
        cwd: path.dirname(repairedScriptPath),
        encoding: "utf8",
        timeout: 10000
      });
      if (execResult2.status === 0) {
        executionPassed = true;
        execDetails = `Exit 0 (no args); stdout: ${execResult2.stdout.trim().replace(/\n/g, "; ")}`;
      } else {
        execDetails = `Exit ${execResult.status}; stderr: ${execResult.stderr.trim().slice(0, 150)}`;
      }
    }
  }

  evaluate("Independent execution exits 0 on vendor log", executionPassed, execDetails);

  const allPassed = checks.every((c) => c.passed);
  console.log("--------------------------------------------------------------------------------");
  console.log(`Flow B Summary: ${allPassed ? "🎉 ALL CHECKS PASSED (100%)" : "⚠️ SOME CHECKS FAILED"}`);
  console.log("================================================================================\n");

  if (!allPassed) {
    console.log("Assistant Text Excerpt:\n", assistantText.slice(0, 1000));
    process.exitCode = 1;
  }
}

runFlowB().catch((err) => {
  console.error("FATAL ERROR in Flow B:", err);
  process.exitCode = 2;
});
