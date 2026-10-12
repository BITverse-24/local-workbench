/** Live CLI checks for the additional, filmable demo scenarios in demo/. */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const JSZip = require("jszip");
const { FlowRunner, ROOT } = require("./run-demo-flows.cjs");

const scenarios = [
  { id: "A-2", dir: "flow_a/scenario-2", mode: "work", files: ["gauge-calibration-register.md"], kb: "maintenance-procedure.md", output: ".docx" },
  { id: "A-3", dir: "flow_a/scenario-3", mode: "work", files: ["repair-closeout-packet.md"], kb: "closeout-procedure.md", output: ".docx" },
  { id: "B-2", dir: "flow_b/scenario-2", mode: "chat", files: ["cold-room-readings.csv"], kb: "monitoring-rule.md", output: null },
  { id: "B-3", dir: "flow_b/scenario-3", mode: "agent", files: [], output: null },
  { id: "C-2", dir: "flow_c/scenario-2", mode: "chat", files: ["relief-valve-register.csv"], kb: "process-safety-standard.md", output: null, terms: ["RV-301", "RV-302", "RV-303", "10.2", "9.5", "unknown", "6.1", "6.2"] },
  { id: "C-3", dir: "flow_c/scenario-3", mode: "chat", files: ["utility-manifold-U18.svg"], kb: "utility-standard-UT-9.md", output: null, terms: ["U18-A", "U18-B", "DN40", "DN50", "Class 150", "Class 300", "5.1", "5.2", "5.3"] },
];

const collect = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? collect(full) : [full];
});

async function run(scenario, campaignDir) {
  const sourceDir = path.join(ROOT, "demo", scenario.dir);
  const prompt = fs.readFileSync(path.join(sourceDir, "prompt.md"), "utf8").trim();
  const expected = JSON.parse(fs.readFileSync(path.join(sourceDir, "expected-results.json"), "utf8"));
  const files = scenario.files;
  const kbDocs = scenario.kb ? [{ path: scenario.kb, kind: "markdown" }] : [];
  const runner = new FlowRunner(scenario.id, path.join(campaignDir, scenario.id));
  const boot = runner.setupSandbox(kbDocs);
  if (scenario.agentModel) {
    const bootConfig = JSON.parse(fs.readFileSync(boot, "utf8"));
    const lead = bootConfig.registry.find((model) => model.id === "primary-model");
    if (!lead) throw new Error("Agent scenario requires the local primary model profile");
    lead.model = scenario.agentModel;
    fs.writeFileSync(boot, JSON.stringify(bootConfig, null, 2));
  }
  for (const file of files) fs.copyFileSync(path.join(sourceDir, file), path.join(runner.sandboxDir, "attachments", file));
  if (scenario.kb) fs.copyFileSync(path.join(sourceDir, scenario.kb), path.join(runner.sandboxDir, "kb", scenario.kb));
  if (scenario.mode === "agent") {
    const workspace = path.join(sourceDir, "workspace");
    for (const file of collect(workspace)) {
      const rel = path.relative(workspace, file);
      const target = path.join(runner.sandboxDir, "workspace", rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
    }
  }
  try {
    await runner.startWorker(boot);
    const { runId } = await runner.callCommand("send", { mode: scenario.mode, chat: scenario.id, text: prompt, files, groundingEnabled: Boolean(scenario.kb) });
    let outcome;
    try { outcome = await runner.waitForTerminalState(runId, 300000); }
    catch { outcome = "timeout"; await runner.callCommand("invoke", { channel: "workbench:cancelRun", input: { runId } }); }
    const inspection = await runner.callCommand("inspect");
    const text = inspection.messages.filter((message) => message.role === "assistant").map((message) => message.content).join("\n");
    const artifacts = inspection.artifacts.filter((artifact) => artifact.run_id === runId || artifact.runId === runId).map((artifact) => ({ ...artifact, relativePath: artifact.relativePath ?? artifact.relative_path }));
    const source = scenario.output && artifacts.find((artifact) => artifact.filename.endsWith(scenario.output));
    let artifactText = "";
    if (source) {
      const artifactPath = path.join(runner.sandboxDir, "data", source.relativePath);
      if (source.filename.endsWith(".docx")) {
        const zip = await JSZip.loadAsync(fs.readFileSync(artifactPath));
        const xml = await zip.file("word/document.xml").async("string");
        artifactText = xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      } else artifactText = fs.readFileSync(artifactPath, "utf8");
    }
    const workspace = path.join(runner.sandboxDir, "workspace");
    const sourceCode = scenario.mode === "agent" ? fs.readFileSync(path.join(workspace, "coldroom.py"), "utf8") : "";
    const tests = scenario.mode === "agent" ? fs.readFileSync(path.join(workspace, "tests/test_coldroom.py"), "utf8") : "";
    const independentTestRun = scenario.mode === "agent" ? spawnSync("python3", ["-m", "unittest", "discover", "-s", "tests", "-v"], { cwd: workspace, encoding: "utf8", timeout: 30000 }) : null;
    const reviewedText = (text + "\n" + artifactText).toLowerCase();
    const checks = {
      terminalState: ["completed", "partial"].includes(outcome),
      responseOrSavedOutput: text.trim().length > 40 || Boolean(source),
      usefulResponse: text.trim().length > 40,
      expectedTerms: expected.requiredTerms.every((term) => reviewedText.includes(term.toLowerCase())),
      requestedArtifact: !scenario.output || Boolean(source),
      knowledgeUsed: !scenario.kb || runner.events.some((event) => event.type === "tool_result" && event.tool === "retrieve_knowledge" && event.ok),
      agentInspectedCode: scenario.mode !== "agent" || ["coldroom.py", "test_coldroom.py"].every((file) => runner.events.some((event) => event.type === "tool_result" && event.tool === "read_file" && event.ok && event.summary?.includes(file))),
      agentFoundBug: scenario.mode !== "agent" || /value\s*>\s*limit/.test(sourceCode) && /test_exact_boundary_is_alert/.test(tests),
      agentExplainedFix: scenario.mode !== "agent" || />=/.test(text) && /test_exact_boundary_is_alert/.test(text),
      agentConfirmedExpectedFailure: scenario.mode !== "agent" || independentTestRun.status === 1 && /test_exact_boundary_is_alert/.test(independentTestRun.stderr) && /AssertionError/.test(independentTestRun.stderr),
      calibrationDecisions: scenario.id !== "A-2" || /PG-G17[\s\S]{0,180}(eligible|approved|pass|current)/i.test(text + artifactText) && /PG-G18[\s\S]{0,180}(expired|not approved|out of date|pending)/i.test(text + artifactText) && /PG-G19[\s\S]{0,180}(unknown|missing|not approved|not found)/i.test(text + artifactText),
      reliefValveDecisions: scenario.id !== "C-2" || /RV-301[\s\S]{0,180}(non.?compliant|above|replace|reset)/i.test(text) && /RV-302[\s\S]{0,180}(unknown|missing|out of service|pending)/i.test(text) && /RV-303[\s\S]{0,180}(compliant|meets|within|pass)/i.test(text),
      manifoldDecisions: scenario.id !== "C-3" || /U18-A[\s\S]{0,180}(non.?compliant|below|correct|increase|upsize)/i.test(text) && /U18-B[\s\S]{0,180}(compliant|meets|pass)/i.test(text),
      coldRoomRowCount: scenario.id !== "B-2" || (text.match(/2026-10-11T\d{2}:\d{2}:\d{2}Z,CR-A,/g) ?? []).length === 3,
      coldRoomRows: scenario.id !== "B-2" || [["5.1", "08:30:00Z"], ["1.9", "09:00:00Z"], ["6.4", "09:45:00Z"]].every(([value, stamp]) => {
        const valueAt = text.indexOf(value);
        const stampAt = text.indexOf(stamp);
        return valueAt >= 0 && stampAt >= 0 && Math.abs(valueAt - stampAt) < 120;
      }),
      noUnexpectedToolErrors: runner.events.filter((event) => event.type === "tool_result").every((event) => event.ok !== false),
    };
    const result = { id: scenario.id, mode: scenario.mode, model: scenario.agentModel ?? null, prompt, outcome, expected, checks, passed: Object.values(checks).every(Boolean), text, artifact: source ?? null, independentTestOutput: independentTestRun?.stdout + independentTestRun?.stderr };
    fs.writeFileSync(path.join(runner.sandboxDir, "evaluation.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(runner.sandboxDir, "events.json"), JSON.stringify(runner.events, null, 2));
    console.log(`${scenario.id}: ${result.passed ? "PASS" : "FAIL"}; failed checks: ${Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key).join(", ")}`);
    return result;
  } finally { await runner.shutdown(); }
}

async function main() {
  const requestedIds = process.env.DEMO_SCENARIOS ? process.env.DEMO_SCENARIOS.split(",") : null;
  const selected = requestedIds ? scenarios.filter((scenario) => requestedIds.includes(scenario.id)) : scenarios;
  if (requestedIds && selected.length !== requestedIds.length) throw new Error("Unknown demo scenario ID");
  const campaignDir = path.join(ROOT, "tests/.runtime/demo-scenarios", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(campaignDir, { recursive: true });
  const results = [];
  for (const scenario of selected) {
    results.push(await run(scenario, campaignDir));
    fs.writeFileSync(path.join(campaignDir, "results.json"), JSON.stringify(results, null, 2));
  }
  const passed = results.every((result) => result.passed);
  console.log(`Additional demo scenarios ${passed ? "PASS" : "FAIL"}. Evidence: ${campaignDir}`);
  process.exitCode = passed ? 0 : 1;
}
main().catch((error) => { console.error(error); process.exitCode = 2; });
