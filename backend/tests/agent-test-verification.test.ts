import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { discoverAgentTestPlans, createAgentVerificationRequest, parseAgentTestReport, assessAgentTestExecution, captureAgentVerificationManifest, isCodeVerificationPath, NODE_EXISTING_TEST_REPORTER, type AgentTestExecutionRequest } from "../src/main/agent/test-verification.js";
import { runCommand } from "../src/main/harness/tools/run-command.js";
import { MutationPolicyGuard } from "../src/main/harness/policy-guard.js";
import { executeProcess } from "../src/main/tools/child-process.js";
import { ToolDispatcher } from "../src/main/agent/tool-dispatcher.js";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { createRun } from "../src/main/run/store.js";
import { RunResultStore } from "../src/main/run/result-store.js";

vi.mock("../src/main/tools/child-process.js", () => ({ executeProcess: vi.fn() }));
describe("Agent existing-test verification", () => {
  let root: string;
  const save = (file: string, text: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  const fixture = (script = "vitest run", deps = { vitest: "3" }) => {
    save("package.json", JSON.stringify({ scripts: { test: script }, devDependencies: deps }));
    save("src/value.ts", "export const value=1"); save("src/value.test.ts", "import {test,expect} from 'vitest'; test('value',()=>expect(1).toBe(1));");
  };
  const plan = (changedPaths = ["src/value.ts"]) => {
    const result = discoverAgentTestPlans({ workspaceRoot: root, changedPaths });
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.detail);
    return result.plans[0];
  };
  const report = (request: AgentTestExecutionRequest, cwd = root, status = "passed") => JSON.stringify({ numFailedTests: status === "failed" ? 1 : 0,
    testResults: [{ name: path.join(cwd, "src/value.test.ts"), assertionResults: [{ status }] }] });
  beforeEach(() => { root = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-tests-"))); vi.mocked(executeProcess).mockReset(); });
  afterEach(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

  it("uses related tests for direct Vitest setup and retains a stable plan identity", () => {
    fixture(); const first = plan();
    expect(first.initialPhase).toBe("related"); expect(first.relatedCommand).toContain("vitest.mjs related");
    expect(plan().id).toBe(first.id); expect(first.fullCommand).toContain("npm test -- --run");
  });
  it("uses a full suite for config changes and preserves forwarding wrappers", () => {
    fixture("node scripts/test.cjs"); save("scripts/test.cjs", "const tool='vitest'; const args=process.argv.slice(2);");
    expect(plan().fullCommand).toContain("npm test"); expect(plan().initialPhase).toBe("full");
    fixture(); save("vitest.config.ts", "export default {}"); expect(plan(["vitest.config.ts"]).initialPhase).toBe("full");
  });
  it("does not require execution of documentation, fixture data, or test helpers", () => {
    fixture(); save("tests/README.md", "Test guide"); save("tests/fixtures/input.json", "{}"); save("tests/helpers/fixture.ts", "export const fixture=1");
    const selected = plan(["src/value.ts", "tests/README.md", "tests/fixtures/input.json", "tests/helpers/fixture.ts"]);
    expect(selected.changedTestPaths).toEqual([]);
    expect(selected.testFiles).toEqual(["src/value.test.ts"]);
    expect(isCodeVerificationPath("docs/jest-notes.md")).toBe(false);
    expect(isCodeVerificationPath("config/runtime.yaml")).toBe(true);
  });
  it("preserves an explicit existing npm command and adds its known reporter", () => {
    fixture();
    const discovery = discoverAgentTestPlans({ workspaceRoot: root, changedPaths: ["src/value.ts"], userCommand: "npm test" });
    expect(discovery.ok).toBe(true); if (!discovery.ok) return;
    expect(discovery.plans[0].fullCommand).toContain("npm test -- --run --reporter=json");
    expect(discovery.plans[0].initialPhase).toBe("full");
  });
  it("runs the Node event reporter on an existing test file with no replacement tests", () => {
    save("case.test.cjs", "const {test}=require('node:test');const assert=require('node:assert/strict');test('existing case',()=>assert.equal(1,1));");
    save("reporter.cjs", NODE_EXISTING_TEST_REPORTER);
    const output = path.join(root, "report.json");
    execFileSync(process.execPath, ["--test", path.join(root, "case.test.cjs")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", WORKBENCH_TEST_REPORT: output, NODE_OPTIONS: `--test-reporter=${JSON.stringify(path.join(root, "reporter.cjs"))}` } });
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ executed: 1, failed: 0, testFiles: [path.join(root, "case.test.cjs")] });
  });
  it("discovers every changed package and selects changed test files", () => {
    for (const dir of ["one", "two"]) { save(`${dir}/package.json`, JSON.stringify({ scripts: { test: "jest" } })); save(`${dir}/src/index.ts`, "value"); save(`${dir}/src/index.test.ts`, "test('case',()=>{})"); }
    const result = discoverAgentTestPlans({ workspaceRoot: root, changedPaths: ["one/src/index.ts", "two/src/index.test.ts"] });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plans).toHaveLength(2); expect(result.plans.every(item => item.relatedCommand?.includes("--findRelatedTests"))).toBe(true);
    expect(result.plans[1].changedTestPaths).toEqual(["two/src/index.test.ts"]);
  });
  it("does not replace a missing or unsupported existing test setup", () => {
    save("index.py", "value=1");
    expect(discoverAgentTestPlans({ workspaceRoot: root, changedPaths: ["index.py"] })).toMatchObject({ ok: false, reason: "no_usable_test_setup" });
    fixture("echo test"); expect(discoverAgentTestPlans({ workspaceRoot: root, changedPaths: ["src/value.ts"] })).toMatchObject({ ok: false });
  });
  it("discovers configured pytest and existing unittest suites without adding tests", () => {
    save("pyproject.toml", "[tool.pytest.ini_options]\ntestpaths=['tests']"); save("tests/test_value.py", "def test_value(): assert True"); save("value.py", "value=1");
    const pytest = plan(["value.py"]); expect(pytest.runner).toBe("pytest"); expect(pytest.fullCommand).toContain("--junitxml=");
    rmSync(path.join(root, "pyproject.toml")); save("tests/test_value.py", "import unittest\nclass Test(unittest.TestCase): pass");
    expect(plan(["value.py"]).runner).toBe("unittest");
  });
  it("accepts actual JSON assertion results and rejects malformed reports", () => {
    fixture(); const request = createAgentVerificationRequest(plan());
    expect(parseAgentTestReport(request, report(request), root)).toMatchObject({ executed: 1, failed: 0, testFiles: ["src/value.test.ts"] });
    expect(() => parseAgentTestReport(request, "{}", root)).toThrow(/assertion/);
    expect(() => parseAgentTestReport(request, '{"numFailedTests":4,"testResults":[]}', root)).toThrow(/counts/);
    expect(parseAgentTestReport(request, JSON.stringify({ ...JSON.parse(report(request)), success: false }), root).failed).toBeGreaterThan(0);
    expect(() => parseAgentTestReport(request, JSON.stringify({ ...JSON.parse(report(request)), wasInterrupted: true }), root)).toThrow(/interrupted/);
  });
  it("parses executed JUnit cases and rejects DTDs and incomplete XML", () => {
    fixture(); const request = { ...createAgentVerificationRequest(plan()), reportFormat: "junit" as const };
    expect(parseAgentTestReport(request, '<testsuites><testsuite><testcase file="src/value.test.ts"/><testcase><skipped/></testcase><testcase><failure/></testcase></testsuite></testsuites>', root)).toMatchObject({ executed: 2, failed: 1, skipped: 1 });
    expect(() => parseAgentTestReport(request, '<!DOCTYPE testsuite><testsuite/>', root)).toThrow(/DTD/);
    expect(() => parseAgentTestReport(request, '<testsuite><testcase>', root)).toThrow();
    expect(() => parseAgentTestReport(request, '<testsuite tests="2"><testcase file="src/value.test.ts"/></testsuite>', root)).toThrow(/totals/);
    expect(parseAgentTestReport(request, '<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase name="saved value" file="src/value.test.ts"><failure message="expected 2, received 1">actual assertion stack</failure></testcase></testsuite>', root)).toMatchObject({ executed: 1, failed: 1, failureOutput: expect.stringContaining("expected 2, received 1") });
  });
  it("limits related-to-full fallback to missing coverage or zero tests", () => {
    fixture(); const request = createAgentVerificationRequest(plan());
    const evidence = { ...request, manifestSha256: request.workspaceManifestSha256, exitCode: 0, timedOut: false, executed: 0, failed: 0, skipped: 0, testFiles: [], reason: "zero_tests" };
    expect(assessAgentTestExecution(evidence).fallbackAllowed).toBe(true);
    expect(assessAgentTestExecution({ ...evidence, reason: "test_failure" })).toMatchObject({ status: "failed", fallbackAllowed: false });
    expect(assessAgentTestExecution({ ...evidence, phase: "full" }).fallbackAllowed).toBe(false);
    expect(assessAgentTestExecution({ ...evidence, executed: 1, failed: 1, reason: "tested_inputs_changed" })).toMatchObject({ status: "unverified", fallbackAllowed: false });
  });
  it("captures reports before cleanup and discards test outputs without publication approval", async () => {
    fixture(); const request = createAgentVerificationRequest(plan(["src/value.test.ts"]));
    const guard = new MutationPolicyGuard({ strict: true }); guard.grantScope({ runId: "run", operation: "run_command", command: request.command });
    guard.setMutationTargetRestriction("run", true, ["src/value.ts"]);
    let scratch = "";
    vi.mocked(executeProcess).mockImplementation(async (_binary, args, options) => {
      if (args.at(-1) === "printf WORKBENCH_ISOLATED") return { stdout: "WORKBENCH_ISOLATED", stderr: "" };
      scratch = options.env!.WORKBENCH_TEST_REPORT!;
      writeFileSync(scratch, report(request, options.cwd));
      mkdirSync(path.join(options.cwd!, "coverage")); writeFileSync(path.join(options.cwd!, "coverage/result.json"), "generated");
      return { stdout: "done", stderr: "" };
    });
    const result = await runCommand(root, request.command, 5000, { guard, runId: "run" }, request);
    expect(result.changes).toEqual([]); expect(result.verification?.executed).toBe(1); expect(result.verification?.report).toContain("assertionResults");
    expect(assessAgentTestExecution(result.verification).status).toBe("passed"); expect(existsSync(scratch)).toBe(false); expect(existsSync(path.join(root, "coverage"))).toBe(false);
  });
  it("retains marker evidence beyond the short stdout preview", async () => {
    fixture(); const request = { ...createAgentVerificationRequest(plan()), successMarker: "CHECK_OK" };
    vi.mocked(executeProcess).mockImplementation(async (_binary, args, options) => {
      if (args.at(-1) === "printf WORKBENCH_ISOLATED") return { stdout: "WORKBENCH_ISOLATED", stderr: "" };
      writeFileSync(options.env!.WORKBENCH_TEST_REPORT!, report(request, options.cwd));
      return { stdout: "x".repeat(12000) + "\nCHECK_OK\n", stderr: "" };
    });
    const result = await runCommand(root, request.command, 5000, undefined, request);
    expect(result.stdout).not.toContain("CHECK_OK");
    expect(result.verification).toMatchObject({ executed: 1, successMarker: "CHECK_OK", successMarkerObserved: true });
  });
  it("invalidates tests that edit saved code or race an external workspace edit", async () => {
    fixture(); const request = createAgentVerificationRequest(plan());
    vi.mocked(executeProcess).mockImplementation(async (_binary, args, options) => {
      if (args.at(-1) === "printf WORKBENCH_ISOLATED") return { stdout: "WORKBENCH_ISOLATED", stderr: "" };
      writeFileSync(options.env!.WORKBENCH_TEST_REPORT!, report(request, options.cwd)); writeFileSync(path.join(options.cwd!, "src/value.ts"), "changed");
      return { stdout: "", stderr: "" };
    });
    expect((await runCommand(root, request.command, 5000, undefined, request)).verification?.reason).toBe("tested_inputs_changed");
    expect(readFileSync(path.join(root, "src/value.ts"), "utf8")).toBe("export const value=1");
    vi.mocked(executeProcess).mockImplementation(async (_binary, args, options) => {
      if (args.at(-1) === "printf WORKBENCH_ISOLATED") return { stdout: "WORKBENCH_ISOLATED", stderr: "" };
      writeFileSync(options.env!.WORKBENCH_TEST_REPORT!, report(request, options.cwd)); save("src/new.ts", "external"); return { stdout: "", stderr: "" };
    });
    expect((await runCommand(root, request.command, 5000, undefined, request)).verification?.reason).toBe("stale_test_evidence");
  });
  it("rejects a stale test plan before executing project code", async () => {
    fixture(); const request = createAgentVerificationRequest(plan()); save("src/value.ts", "external");
    vi.mocked(executeProcess).mockResolvedValue({ stdout: "WORKBENCH_ISOLATED", stderr: "" });
    await expect(runCommand(root, request.command, 5000, undefined, request)).rejects.toThrow(/stale/);
    expect(executeProcess).toHaveBeenCalledTimes(1);
  });
  it("rejects missing exit codes and malformed command evidence", async () => {
    for (const output of ['{"stdout":"test passed"}', "{}", "not JSON", ""]) {
      const dispatcher = new ToolDispatcher([{ name: "run_command", definition: { type: "function", function: { name: "run_command", description: "run", parameters: { type: "object", properties: {} } } }, async execute() { return { output, summary: "ran" }; } }]);
      const [result] = await dispatcher.dispatchConcurrent([{ id: "call", name: "run_command", arguments: { command: "node test" } }], { runId: "unit", workspaceRoot: root, gateway: {} as any });
      expect(result.result.ok).toBe(false);
    }
  });
  it("changes manifest identity when a new source file is added", () => {
    fixture(); const before = captureAgentVerificationManifest(root); save("src/new.ts", "new");
    expect(captureAgentVerificationManifest(root).sha256).not.toBe(before.sha256);
  });
  it("keeps typed control evidence after storing and compacting a full report", async () => {
    fixture(); const request = createAgentVerificationRequest(plan());
    initDb(path.join(root, "run.sqlite")); const runId = createRun(createChat(), "Run existing tests");
    const store = new RunResultStore(runId, undefined, root);
    const executionEvidence = { planId: request.planId, command: request.command, runner: request.runner, phase: request.phase,
      manifestSha256: request.workspaceManifestSha256, sourceManifest: request.sourceManifest, exitCode: 0, timedOut: false, executed: 1, failed: 0, skipped: 0, testFiles: ["src/value.test.ts"] };
    const dispatcher = new ToolDispatcher([{ name: "run_command", definition: { type: "function", function: { name: "run_command", description: "run", parameters: { type: "object", properties: {} } } },
      async execute() { return { summary: "passed", output: JSON.stringify({ exitCode: 0, stdout: "x".repeat(24000) }), executionEvidence,
        intermediate: { type: "execution", status: "complete", origin: "execution", sources: [], payload: { exitCode: 0, verification: { ...executionEvidence, report: "complete report" } } } }; } }]);
    const [result] = await dispatcher.dispatchConcurrent([{ id: "call", name: "run_command", arguments: { command: request.command } }], { runId, workspaceRoot: root, gateway: {} as any, resultStore: store, agentVerification: request });
    expect(result.result.ok).toBe(true); expect(result.result.executionEvidence).toMatchObject({ executed: 1, resultId: result.result.resultRef?.resultId });
    expect(result.result.output.length).toBeLessThan(24000); expect(store.verifyIntegrity(result.result.resultRef!.resultId).valid).toBe(true);
  });
});
