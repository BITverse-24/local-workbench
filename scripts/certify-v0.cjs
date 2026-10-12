/** V0 model-quality suite. All scenario data and scoring stay outside production. */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const JSZip = require("jszip");
const { createHash } = require("node:crypto");
const { FlowRunner, ROOT, REGISTRY } = require("./run-demo-flows.cjs");

const scenarios = [
  { id: "document-normal", family: "document", fixture: "demo/flow_a/scenario-1", files: ["inspection-report-E201-annotated.pdf", "inspection-report-E202-followup.pdf"], kb: "sop-114-pressure-equipment-inspection.md", format: "docx",
    prompt: "Read these inspection reports, pull out the key findings, and draft an approval note for the plant manager." },
  { id: "document-paraphrase", family: "document", fixture: "demo/flow_a/scenario-1", files: ["inspection-report-E201-annotated.pdf", "inspection-report-E202-followup.pdf"], kb: "sop-114-pressure-equipment-inspection.md", format: "docx",
    prompt: "Can you put together a Word approval note for the plant manager from these two reports? Include the findings and any conditions from our SOP." },
  { id: "document-unrelated", family: "document", fixture: "tests/fixtures/v0", files: ["training-records.md"], kb: "training-policy.md", format: "md",
    prompt: "Make a Markdown review note from these training records and our policy. For each staff identifier, say whether the person may handle records independently on the review date, give the reason, and include the required next actions and policy references. Return the note as a file." },
  { id: "code-normal", family: "code", fixture: "demo/flow_b/scenario-1", files: ["broken-vendor-log-parser.py", "vendor-maintenance-log.csv"], format: "py",
    prompt: "This is crashing on our vendor log files. Fix it and make sure it actually works." },
  { id: "code-paraphrase", family: "code", fixture: "demo/flow_b/scenario-1", files: ["broken-vendor-log-parser.py", "vendor-maintenance-log.csv"], format: "py",
    prompt: "Can you repair this parser and check it with the attached CSV? Keep the same interface and give me the corrected Python file." },
  { id: "code-unrelated", family: "code", fixture: "tests/fixtures/v0", files: ["word-count.py", "words.txt"], format: "py",
    prompt: "This word counter loses repeated words. Fix the attached source, keep its function and command-line interface, run it on the attached text, and return the working Python file." },
  { id: "inspection-normal", family: "inspection", fixture: "demo/flow_c/scenario-1", files: ["pump-skid-P204.svg"], kb: "piping-spec-SOP-220.md",
    prompt: "Check this against our piping spec and tell me if anything's non-compliant." },
  { id: "inspection-paraphrase", family: "inspection", fixture: "demo/flow_c/scenario-1", files: ["pump-skid-P204.svg"], kb: "piping-spec-SOP-220.md",
    prompt: "Does this skid drawing meet our piping standard? Point out any mismatches and the changes needed before sign-off." },
  { id: "inspection-unrelated", family: "inspection", fixture: "tests/fixtures/v0", files: ["package-labels.md"], kb: "dispatch-policy.md",
    prompt: "Check these parcel labels against our dispatch policy. Use the exact box identifiers, identify any defects and required corrections, and say which parcels can be dispatched. Cite the relevant policy sections." },
];

async function artifactText(artifact, sandbox) {
  const filename = path.join(sandbox, "data", artifact.relativePath);
  if (!artifact.filename.endsWith(".docx")) return fs.readFileSync(filename, "utf8");
  const zip = await JSZip.loadAsync(fs.readFileSync(filename));
  const xml = await zip.file("word/document.xml").async("string");
  return xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&");
}

function codeOutput(source, input) {
  const run = spawnSync("python3", [source, input], { encoding: "utf8", timeout: 10000 });
  if (run.status !== 0) return { error: run.stderr || run.error?.message || `Exit ${run.status}` };
  const parsed = spawnSync("python3", ["-c", "import ast,json,sys; print(json.dumps(ast.literal_eval(sys.argv[1])))", run.stdout.trim()], { encoding: "utf8", timeout: 10000 });
  try { return { value: JSON.parse(parsed.stdout) }; } catch { return { error: `Cannot read CLI result: ${run.stdout}` }; }
}
const equalCounts = (a, b) => a && Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => a[k] === v);
function containsDate(text, iso) {
  if (text.includes(iso)) return true;
  const [year, month, day] = iso.split('-');
  const name = ['January','February','March','April','May','June','July','August','September','October','November','December'][Number(month)-1];
  return new RegExp(`(?:${name}\\s+${Number(day)}(?:st|nd|rd|th)?[,]?\\s+${year}|${Number(day)}(?:st|nd|rd|th)?\\s+${name}[,]?\\s+${year})`, 'i').test(text);
}

async function assess(scenario, result, runner) {
  const requirements = [];
  const check = (name, severity, ok, reason) => requirements.push({ name, severity, passed: Boolean(ok), ...(ok ? {} : { reason }) });
  const tools = runner.events.filter(e => e.type === "tool_call").map(e => e.tool);
  const errors = runner.events.filter(e => e.type === "error");
  const harnessErrors = errors.filter(e => /tool_loop_detected|artifact_verification|permission|unauthorized|persistence/.test(e.code));
  check("Harness did not deadlock or violate integrity", "harness", !harnessErrors.length, JSON.stringify(harnessErrors));
  check("Task reached completion with a useful response", "critical", ["completed", "partial"].includes(result.terminalState) && result.text.trim().length > 40, `State: ${result.terminalState}; ${errors.map(e => `${e.code}: ${e.message}`).join("; ")}`);
  for (const artifact of result.artifacts) {
    const actual = path.join(runner.sandboxDir, "data", artifact.relativePath);
    check(`Artifact exists: ${artifact.filename}`, "harness", fs.existsSync(actual) && fs.statSync(actual).size > 0, "Runtime referenced an absent or empty file");
  }
  check("Original supplied source files are unchanged", "harness", scenario.files.every(file => fs.readFileSync(path.join(ROOT, scenario.fixture, file)).equals(fs.readFileSync(path.join(runner.sandboxDir, "attachments", file)))), "A supplied source was changed");
  if (scenario.kb) check("Real knowledge retrieval completed", "critical", runner.events.some(e => e.type === "tool_result" && e.tool === "retrieve_knowledge" && e.ok), "No successful knowledge retrieval");
  const artifact = result.artifacts.find(a => a.filename.endsWith(`.${scenario.format}`));
  if (scenario.format) check("Requested artifact exists in the requested format", "critical", artifact, `No .${scenario.format} artifact`);
  const text = artifact ? await artifactText(artifact, runner.sandboxDir) : result.text;
  result.artifactText = artifact && scenario.family !== "code" ? text : undefined;
  if (scenario.family === "code") {
    check("Runtime executed the repaired source", "critical", runner.events.some(e => e.type === "tool_result" && e.tool === "execute_python" && e.ok), "No successful real execution");
    if (artifact) {
      const source = path.join(runner.sandboxDir, "data", artifact.relativePath);
      const supplied = codeOutput(source, path.join(runner.sandboxDir, "attachments", scenario.files[1]));
      const unrelated = scenario.id.endsWith("unrelated");
      const expected = unrelated ? { robin: 3, maple: 2, ash: 1 } : { ok: 4, malformed: 1, high: 2 };
      check("Saved program meets source-derived behavior on supplied input", "critical", equalCounts(supplied.value, expected), JSON.stringify(supplied));
      const probe = path.join(runner.sandboxDir, unrelated ? "additional.txt" : "additional.csv");
      // The source contract describes missing values and an inclusive boundary.
      // Arbitrary non-numeric values are a robustness diagnostic in the old
      // strict campaign, not an additional business rule for this V0 task.
      fs.writeFileSync(probe, unrelated ? "OAK oak... Pine! pine PINE.\n" : "timestamp,asset_id,temperature_c,event\nx,a,350.0,limit\nx,a,349.9,normal\nx,a,,gap\nx,a,400,high\n");
      const alternate = codeOutput(source, probe);
      check("Saved program preserves behavior on independent input", "critical", equalCounts(alternate.value, unrelated ? { oak: 2, pine: 3 } : { ok: 3, malformed: 1, high: 2 }), JSON.stringify(alternate));
      const fn = unrelated ? "count_words" : "summarize";
      const callable = spawnSync("python3", ["-c", "import importlib.util,sys; s=importlib.util.spec_from_file_location('candidate',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); assert callable(getattr(m,sys.argv[2]))", source, fn], { encoding: "utf8", timeout: 10000 });
      check("Public callable interface is retained", "critical", callable.status === 0, callable.stderr);
    }
  } else if (scenario.id === "document-unrelated") {
    check("Both staff identifiers are preserved", "major", /STAFF-LARK/.test(text) && /STAFF-FERN/.test(text), "A staff identifier is absent");
    check("Training dates and review date are grounded", "major", ['2026-09-10','2025-08-02','2026-09-30'].every(date=>containsDate(text,date)), "Relevant date absent");
    check("Eligibility decisions and evidence are supplied", "critical", /acknowledg/i.test(text) && /independent/i.test(text) && /refresher|expired|twelve|12 months/i.test(text), "Core eligibility conditions absent; inspect subject attribution manually");
    check("Source actions and policy references are preserved", "major", /attendance/i.test(text) && /refresher/i.test(text) && /TRAIN-POLICY|training-policy/i.test(text), "An action or governing source is absent");
  } else if (scenario.family === "document") {
    check("Both reviewed subjects are included", "major", /E-?201/.test(text) && /E-?202/.test(text), "A subject is absent");
    check("Important measurements and defect are preserved", "major", /3\.8/.test(text) && /4\.2/.test(text) && /4\.6/.test(text) && /pitting/i.test(text) && /1\.8/.test(text), "An important source finding is absent");
    check("Core decision is grounded and conditional on required work", "critical", /retub/i.test(text) && /conditional|pending|withheld/i.test(text) && /SOP-?114/i.test(text), "Core decision or evidence is absent");
    check("Source follow-up actions are included", "major", /gasket/i.test(text) && /degrad|deteriorat|wear/i.test(text) && /replac/i.test(text) && /verify after repair|verif.{0,30}repair/i.test(text), "An important follow-up finding or action is absent");
    check("Source annotation is carried through", "minor", /4B/i.test(text) && /recheck/i.test(text), "Annotation is absent");
  } else if (scenario.id === "inspection-unrelated") {
    check("Both box identifiers are preserved", "major", /BOX-ORCHID/.test(text) && /BOX-CEDAR/.test(text), "A box identifier is absent");
    check("Missing return address and unreadable barcode are identified", "critical", /return address/i.test(text) && /missing/i.test(text) && /unreadable/i.test(text) && /barcode/i.test(text), "A core defect is absent");
    check("Required corrections and dispatch decision are supplied", "critical", /add|provide|include/i.test(text) && /reprint|replace|readable/i.test(text) && /not|withhold|pending|before|cannot/i.test(text), "A core action or release decision is absent; inspect subject attribution manually");
    check("Policy reference is supplied", "major", /DISPATCH-POLICY|dispatch-policy/i.test(text), "Governing source is absent");
  } else {
    check("Major observed and required valve ratings are included", "critical", /150/.test(text) && /300/.test(text), "Valve mismatch is absent");
    check("Valve source identifier is retained for traceability", "major", /XV-204/.test(text), "Valve identifier is absent");
    check("Major observed and required line sizes are included", "critical", /DN\s*80/i.test(text) && /DN\s*100/i.test(text), "Line mismatch is absent");
    check("Correction requirement is clear", "critical", /correct|change|replace|increase|upgrad|upsize|must|need/i.test(text), "No supported correction requirement");
    check("Retrieved governing clauses are cited", "major", /SOP-?220/i.test(text) && /4\.2/.test(text) && /4\.3/.test(text), "Governing clauses absent");
    check("No invented scale requirement", "critical", !/drawing must.{0,30}scale|must be (?:to )?scale|scaled to meet/i.test(text), "Invented scale rule");
  }
  result.requirements = requirements;
  result.classification = requirements.some(r => !r.passed && r.severity === "harness") ? "HARNESS FAILURE" : requirements.some(r => !r.passed && r.severity === "critical") ? "FAIL" : requirements.some(r => !r.passed && r.severity === "major") ? "PARTIAL" : "PASS";
  result.manualReviewRequired = true;
  result.toolPath = tools;
}

async function run(scenario, campaignDir) {
  const runner = new FlowRunner(scenario.id, path.join(campaignDir, scenario.id));
  const boot = runner.setupSandbox(scenario.kb ? [{ path: scenario.kb, kind: "markdown" }] : []);
  const config = JSON.parse(fs.readFileSync(boot));
  config.registry = REGISTRY.filter(entry => entry.model === "qwen2.5-coder-7b-instruct-mlx" && !entry.fallbackOnly);
  if (config.registry.length !== 1) throw new Error("V0 certification requires the configured Qwen2.5 Coder lead");
  fs.writeFileSync(boot, JSON.stringify(config, null, 2));
  for (const file of scenario.files) fs.copyFileSync(path.join(ROOT, scenario.fixture, file), path.join(runner.sandboxDir, "attachments", file));
  if (scenario.kb) fs.copyFileSync(path.join(ROOT, scenario.fixture, scenario.kb), path.join(runner.sandboxDir, "kb", scenario.kb));
  try {
    await runner.startWorker(boot);
    const start = performance.now();
    const { runId } = await runner.callCommand("send", { mode: scenario.family === "inspection" ? "chat" : "work", chat: scenario.id, text: scenario.prompt, files: scenario.files, groundingEnabled: Boolean(scenario.kb) });
    let terminalState;
    try { terminalState = await runner.waitForTerminalState(runId, 600000); }
    catch { terminalState = "timeout"; await runner.callCommand("invoke", { channel: "workbench:cancelRun", input: { runId } }); }
    const latencySec = (performance.now() - start) / 1000;
    const inspection = await runner.callCommand("inspect");
    const artifacts = inspection.artifacts.filter(a => a.run_id === runId || a.runId === runId).map(a => ({ ...a, relativePath: a.relativePath ?? a.relative_path }));
    const telemetryFile = path.join(runner.sandboxDir, "data", "runs", runId, "logs", "run-telemetry-summary.json");
    const result = { id: scenario.id, family: scenario.family, prompt: scenario.prompt, runId, terminalState, latencySec, text: inspection.messages.filter(m => m.role === "assistant").map(m => m.content).join("\n"), artifacts,
      telemetry: fs.existsSync(telemetryFile) ? JSON.parse(fs.readFileSync(telemetryFile)) : null };
    await assess(scenario, result, runner);
    fs.writeFileSync(path.join(runner.sandboxDir, "evaluation.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(runner.sandboxDir, "events.json"), JSON.stringify(runner.events, null, 2));
    console.log(`${result.id}: ${result.classification}; ${latencySec.toFixed(1)}s; ${result.requirements.filter(r => !r.passed).map(r => r.name).join("; ")}`);
    return result;
  } finally { await runner.shutdown(); }
}

async function main() {
  const requestedIds = process.argv.slice(2);
  if (requestedIds.some(id => !scenarios.some(scenario => scenario.id === id))) throw new Error("Unknown V0 task ID");
  const selected = requestedIds.length ? scenarios.filter(scenario => requestedIds.includes(scenario.id)) : scenarios;
  const campaignDir = path.join(ROOT, "tests/.runtime/v0", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(campaignDir, { recursive: true });
  const results = [];
  fs.writeFileSync(path.join(campaignDir, "provenance.json"), JSON.stringify({
    workerSha256: createHash("sha256").update(fs.readFileSync(path.join(ROOT, "tests/.runtime/build/worker.cjs"))).digest("hex"),
    lead: "qwen2.5-coder-7b-instruct-mlx", profile: process.env.SW_AGENT_GENERATION_PROFILE ?? "default",
    gitHead: spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim(),
    startedAt: new Date().toISOString(),
  }, null, 2));
  for (const scenario of selected) {
    results.push(await run(scenario, campaignDir));
    fs.writeFileSync(path.join(campaignDir, "results.json"), JSON.stringify({ results }, null, 2));
  }
  const byFamily = Object.fromEntries(["document", "code", "inspection"].map(family => [family, results.filter(r => r.family === family && r.classification === "PASS").length]));
  const report = { model: "qwen2.5-coder-7b-instruct-mlx", profile: "Standard/default", byFamily,
    fullPasses: results.filter(r => r.classification === "PASS").length, harnessFailures: results.filter(r => r.classification === "HARNESS FAILURE").length,
    manualReviewRequired: true, subset: selected.length !== scenarios.length, results };
  fs.writeFileSync(path.join(campaignDir, "results.json"), JSON.stringify(report, null, 2));
  console.log(`V0 ${report.subset ? "subset" : "provisional"} result: ${report.fullPasses}/${selected.length} PASS; ${report.harnessFailures} harness failures. Review saved outputs before certification. Evidence: ${campaignDir}`);
  process.exitCode = (report.subset ? report.fullPasses === selected.length : report.fullPasses >= 6 && Object.values(byFamily).every(n => n >= 2)) && report.harnessFailures === 0 ? 0 : 1;
}
main().catch(error => { console.error(error); process.exitCode = 2; });
