/** Live CLI campaign. Fixture assertions stay here, outside production code. */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const JSZip = require("jszip");
const { FlowRunner, ROOT, REGISTRY } = require("./run-demo-flows.cjs");

const variants = {
  A: [
    "Read these inspection reports, pull out the key findings, and draft an approval note for the plant manager.",
    "Can you put together a Word approval note for the plant manager from these two reports? Include the findings and any conditions from our SOP.",
    "I need a formal note in Word for the manager. Review both inspection reports and say what needs to happen before clearance, using our inspection procedure.",
    "Please make an approval note for my manager from the attached inspections. Keep it in a Word file.",
    "Turn both reports into a formal clearance note. Include the readings, defects and conditions we need to meet, and give me the Word document.",
    "Could you draft the plant manager's approval note after reviewing these reports with our SOP? I want the .docx too.",
  ],
  B: [
    "This is crashing on our vendor log files. Fix it and make sure it actually works.",
    "Can you repair this parser and check it with the attached CSV? Keep the same interface and give me the corrected Python file.",
    "The script stops when it reads our log. Please sort out the bugs, run the corrected version on this data and return the working script.",
    "The vendor parser blows up on this CSV. Can you get it working and send back the fixed script after testing it?",
    "Please patch the bugs in this Python script and verify the result on the attached log. Return the repaired file.",
    "I can't process the attached log with this script. Fix the source, run it once on the data and give me the version that works.",
  ],
  C: [
    "Check this against our piping spec and tell me if anything's non-compliant.",
    "Does this skid drawing meet our piping standard? Point out any mismatches and the changes needed before sign-off.",
    "Please review the drawing against the spec in our knowledge base. Give me the observed values, required values and corrective actions.",
    "Anything in this drawing that would stop sign-off under our piping spec? Tell me what to fix.",
    "Compare the attached skid drawing with the standard we uploaded and show me the discrepancies and required corrections.",
    "Please check the valve rating and line sizes on this drawing using our piping requirements. Is it compliant, and what changes are needed?",
  ],
};
for (const flow of ["A", "B", "C"]) {
  variants[flow][0] = fs.readFileSync(path.join(ROOT, "demo", `flow_${flow.toLowerCase()}`, "scenario-1", "prompt.md"), "utf8").trim();
}
for (const flow of ["A", "B", "C"]) {
  if (process.env[`FLOW_${flow}_PROMPT`]) variants[flow][0] = process.env[`FLOW_${flow}_PROMPT`];
}
const fixtures = {
  A: { dir: "flow_a/scenario-1", files: ["inspection-report-E201-annotated.pdf", "inspection-report-E202-followup.pdf"], kb: "sop-114-pressure-equipment-inspection.md" },
  B: { dir: "flow_b/scenario-1", files: ["broken-vendor-log-parser.py", "vendor-maintenance-log.csv"] },
  C: { dir: "flow_c/scenario-1", files: ["pump-skid-P204.svg"], kb: "piping-spec-SOP-220.md" },
};

async function evaluate(flow, text, artifacts, runner, outcome) {
  const checks = { terminalState: ["completed", "partial"].includes(outcome), singleApproval: runner.confirmationsCount <= 1,
    noToolErrors: runner.events.filter(e => e.type === "tool_result").every(e => e.ok !== false),
    response: text.length > 100 };
  if (flow === "A") {
    const doc = artifacts.find(a => a.filename.endsWith(".docx"));
    checks.wordArtifact = Boolean(doc);
    let xml = "";
    if (doc) {
      const zip = await JSZip.loadAsync(fs.readFileSync(path.join(runner.sandboxDir, "data", doc.relativePath)));
      xml = await zip.file("word/document.xml").async("string");
    }
    // Check both the exported document and the final chat. No invented 2.1 mm fixture assertion.
    // Work returns a concise status message in chat. The saved DOCX is the
    // user-requested deliverable and carries the source evidence.
    for (const [scope, content] of Object.entries({ document: xml })) {
      checks[scope + "BothReports"] = /E-?201/i.test(content) && /E-?202/i.test(content);
      checks[scope + "WallRange"] = /3\.8/.test(content) && /4\.2/.test(content) && /4\.6/.test(content);
      checks[scope + "Pitting"] = /pitting/i.test(content) && /1\.8/.test(content);
      checks[scope + "InspectorNote"] = /4B/i.test(content) && /recheck/i.test(content);
      checks[scope + "FollowUpNote"] = /verify after repair/i.test(content);
      checks[scope + "GroundedCondition"] = /SOP-?114/i.test(content) && /retub/i.test(content) && /conditional|pending|withheld/i.test(content);
      checks[scope + "Gasket"] = /gasket/i.test(content);
      const readable = content.replace(/<\/w:p>/g, "\n").replace(/<[^>]*>/g, "");
      for (const id of [201, 202]) {
        const start = readable.search(new RegExp(`(?:Approval Note for E-?${id}|E-?${id}:)`, "i"));
        const section = start < 0 ? "" : readable.slice(start, start + 1400);
        checks[scope + "Decision" + id] = /conditional|pending|withheld/i.test(section) && /SOP-?114/i.test(section) && /retub/i.test(section);
      }
    }
  } else if (flow === "B") {
    const source = artifacts.find(a => a.filename.endsWith(".py"));
    checks.sourceArtifact = Boolean(source);
    checks.validatedByApp = runner.events.some(e => e.type === "tool_result" && e.tool === "execute_python" && e.ok);
    if (source) {
      const sourcePath = path.join(runner.sandboxDir, "data", source.relativePath);
      const result = spawnSync("python3", [sourcePath, path.join(runner.sandboxDir, "attachments", fixtures.B.files[1])], { encoding: "utf8", timeout: 10000 });
      checks.independentCounts = result.status === 0 && /['"]ok['"]\s*:\s*4/.test(result.stdout) && /['"]malformed['"]\s*:\s*1/.test(result.stdout) && /['"]high['"]\s*:\s*2/.test(result.stdout);
      checks.chatCounts = /\b4\b/.test(text) && /\b1\b/.test(text) && /\b2\b/.test(text);
      // A new dataset checks that output comes from the inputs, with the same interface.
      const probe = path.join(runner.sandboxDir, "boundary-probe.csv");
      fs.writeFileSync(probe, "timestamp,asset_id,temperature_c,event\nx,a,350.0,limit\nx,a,349.9,normal\nx,a,,gap\nx,a,bad,bad\nx,a,400,high\n");
      const alternate = spawnSync("python3", [sourcePath, probe], { encoding: "utf8", timeout: 10000 });
      checks.unseenData = alternate.status === 0 && /['"]ok['"]\s*:\s*3/.test(alternate.stdout) && /['"]malformed['"]\s*:\s*2/.test(alternate.stdout) && /['"]high['"]\s*:\s*2/.test(alternate.stdout);
    }
  } else {
    checks.valve = /XV-204/i.test(text) && /150/.test(text) && /300/.test(text);
    checks.line = /DN\s*80/i.test(text) && /DN\s*100/i.test(text);
    checks.citations = /SOP-?220/i.test(text) && /4\.2/.test(text) && /4\.3/.test(text);
    checks.withheld = /non.?compliant|not approved|withhold|withheld|before.*sign.?off/i.test(text);
    checks.actions = /replace|upgrad|repair/i.test(text) && /upsize|increase|diameter|DN100/i.test(text);
    checks.noInventedScaleRule = !/drawing must.{0,30}scale|must be (?:to )?scale|scaled to meet/i.test(text);
    const tableRows = text.split("\n").filter(line => /^\s*\|/.test(line));
    checks.noRatingTransferredToPump = !tableRows.some(line => /^\s*\|\s*P-204\b/i.test(line) && !/discharge|line|valve/i.test(line.split("|")[1] ?? "") && /(?:class|rating)\s*150/i.test(line));
    checks.dischargeObservation = tableRows.some(line => /DN\s*80/i.test(line) && /discharge|line/i.test(line) && /4\.3/.test(line) && /non.?compliant/i.test(line)) ||
      /(?:discharge|line)[\s\S]{0,80}DN\s*80[\s\S]{0,160}(?:4\.3|SOP-?220)[\s\S]{0,80}non.?compliant/i.test(text) ||
      /DN\s*80[\s\S]{0,160}(?:4\.3|SOP-?220)[\s\S]{0,80}non.?compliant/i.test(text);
    checks.retrieved = runner.events.some(e => e.type === "tool_result" && e.tool === "retrieve_knowledge" && e.ok);
  }
  return checks;
}

async function run(flow, variant, campaignDir) {
  const flowStart = performance.now();
  const f = fixtures[flow];
  const sandbox = path.join(campaignDir, `${flow}-${variant + 1}`);
  const runner = new FlowRunner(`${flow}-${variant + 1}`, sandbox);
  const boot = runner.setupSandbox(f.kb ? [{ path: f.kb, kind: "markdown" }] : []);
  for (const file of f.files) fs.copyFileSync(path.join(ROOT, "demo", f.dir, file), path.join(sandbox, "attachments", file));
  if (f.kb) fs.copyFileSync(path.join(ROOT, "demo", f.dir, f.kb), path.join(sandbox, "kb", f.kb));
  try {
    await runner.startWorker(boot);
    const start = performance.now(); // Includes send/attachment setup, classification, tools and final response.
    const preparationSec = (start - flowStart) / 1000;
    const { runId } = await runner.callCommand("send", { mode: flow === "C" ? "chat" : "work", chat: `${flow}-${variant}`, text: variants[flow][variant], files: f.files, groundingEnabled: Boolean(f.kb) });
    let outcome;
    try { outcome = await runner.waitForTerminalState(runId, 300000); }
    catch { outcome = "timeout"; await runner.callCommand("invoke", { channel: "workbench:cancelRun", input: { runId } }); }
    const durationSec = (performance.now() - start) / 1000;
    const fullFlowSec = (performance.now() - flowStart) / 1000;
    const inspection = await runner.callCommand("inspect");
    const text = inspection.messages.filter(m => m.role === "assistant").map(m => m.content).join("\n");
    const artifacts = inspection.artifacts.filter(a => a.run_id === runId || a.runId === runId).map(a => ({ ...a, filename: a.filename, relativePath: a.relativePath ?? a.relative_path }));
    const checks = await evaluate(flow, text, artifacts, runner, outcome);
    const telemetryPath = path.join(sandbox, "data", "runs", runId, "logs", "run-telemetry-summary.json");
    const telemetry = fs.existsSync(telemetryPath) ? JSON.parse(fs.readFileSync(telemetryPath)) : null;
    const result = { flow, variant: variant + 1, prompt: variants[flow][variant], runId, durationSec, preparationSec, fullFlowSec, outcome, checks, passed: Object.values(checks).every(Boolean), text, artifacts, telemetry };
    fs.writeFileSync(path.join(sandbox, "evaluation.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(sandbox, "events.json"), JSON.stringify(runner.events, null, 2));
    console.log(`${flow}-${variant + 1}: ${result.passed ? "PASS" : "FAIL"} ${durationSec.toFixed(1)}s; failed checks: ${Object.entries(checks).filter(([,ok]) => !ok).map(([key]) => key).join(", ")}`);
    return result;
  } finally { await runner.shutdown(); }
}

async function main() {
  const rounds = Number(process.env.DEMO_ROUNDS || 6);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 6) throw new Error("DEMO_ROUNDS must be between 1 and 6");
  const selected = (process.env.DEMO_FLOWS || "A,B,C").split(",");
  if (selected.some(f => !fixtures[f])) throw new Error("DEMO_FLOWS must contain A, B or C");
  const campaignDir = path.join(ROOT, "tests/.runtime/latency", process.env.DEMO_CAMPAIGN || new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(campaignDir, { recursive: true });
  const results = [];
  for (let i = 0; i < rounds; i++) for (const flow of selected) {
    results.push(await run(flow, i, campaignDir));
    fs.writeFileSync(path.join(campaignDir, "results.json"), JSON.stringify({ registry: REGISTRY, results }, null, 2));
  }
  const meanSec = results.reduce((sum, r) => sum + r.durationSec, 0) / results.length;
  const fullFlowMeanSec = results.reduce((sum, r) => sum + r.fullFlowSec, 0) / results.length;
  const report = { registry: REGISTRY, meanSec, maximumSec: Math.max(...results.map(r => r.durationSec)), fullFlowMeanSec,
    fullFlowMaximumSec: Math.max(...results.map(r => r.fullFlowSec)), passed: results.every(r => r.passed), results };
  fs.writeFileSync(path.join(campaignDir, "results.json"), JSON.stringify(report, null, 2));
  console.log(`Campaign ${report.passed ? "PASS" : "FAIL"}: mean ${meanSec.toFixed(1)}s. Evidence: ${campaignDir}`);
  process.exitCode = report.passed ? 0 : 1;
}
main().catch(error => { console.error(error); process.exitCode = 2; });
