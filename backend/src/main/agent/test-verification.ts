import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SaxesParser } from "saxes";
import type { AgentToolCall } from "../../shared/contracts.js";
import { PermissionError, resolveSafe } from "../harness/path-guard.js";
import { getPythonExecutable } from "../tools/python-runtime.js";

export type AgentTestRunner = "vitest" | "jest" | "node" | "pytest" | "unittest" | "junit" | "tap";
export type AgentTestPhase = "related" | "full";
/** A reporter, not a test: consume the existing node:test execution events. */
export const NODE_EXISTING_TEST_REPORTER = `const fs=require('node:fs');
module.exports=async function* (source){
 const result={executed:0,failed:0,skipped:0,testFiles:[],failures:[]};
 for await(const event of source){
  if(!['test:pass','test:fail'].includes(event.type)||event.data.details?.type==='suite')continue;
  if(event.data.skip||event.data.todo){result.skipped++;continue;}
  result.executed++;if(event.type==='test:fail'){
   result.failed++;
   const error=event.data.details?.error;
   const failure={name:event.data.name,file:event.data.file,message:error?.cause?.message||error?.message||'Test failed',stack:error?.cause?.stack||error?.stack||''};
   result.failures.push(failure);
   yield failure.name+': '+failure.message+String.fromCharCode(10)+failure.stack+String.fromCharCode(10);
  }
  if(event.data.file&&!result.testFiles.includes(event.data.file))result.testFiles.push(event.data.file);
 }
 fs.writeFileSync(process.env.WORKBENCH_TEST_REPORT,JSON.stringify(result));
 yield JSON.stringify(result)+'\\n';
};`;
export interface AgentTestPlan {
  id: string; workspaceRoot: string; suiteRoot: string; runner: AgentTestRunner;
  changedPaths: string[]; changedTestPaths: string[]; sourceManifest: Record<string, string>;
  manifestSha256: string; initialPhase: AgentTestPhase; relatedCommand?: string; fullCommand: string;
  reportFormat: "json" | "junit" | "tap" | "unittest"; testFiles: string[];
}
/** Only the controller supplies this context. It is never a model tool argument. */
export interface AgentTestExecutionRequest {
  planId: string; command: string; phase: AgentTestPhase; runner: AgentTestRunner; suiteRoot: string;
  workspaceManifestSha256: string; sourceManifest: Record<string, string>; changedTestPaths: string[];
  reportFormat: AgentTestPlan["reportFormat"]; testFiles: string[];
  successMarker?: string;
}
export interface AgentTestExecutionEvidence {
  planId: string; command: string; phase: AgentTestPhase; runner: AgentTestRunner;
  manifestSha256: string; sourceManifest: Record<string, string>; exitCode: number; timedOut: boolean;
  executed: number; failed: number; skipped: number; testFiles: string[];
  reason?: string; detail?: string; resultId?: string; report?: string; isolationStatus?: string;
  failureOutput?: string;
  successMarker?: string; successMarkerObserved?: boolean;
}
export type AgentTestDiscovery = { ok: true; plans: AgentTestPlan[] } | { ok: false; reason: string; detail: string };
const MAX_FILES = 10000, MAX_BYTES = 128 * 1024 * 1024;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const slash = (value: string) => value.split(path.sep).join("/");
export function isCodeVerificationPath(filename: string): boolean {
  if (/\.(?:md|mdx|rst|txt|adoc|docx|xlsx|pdf|png|jpe?g|gif|svg|webp|ico|avif|bmp|tiff?|woff2?|ttf|otf)$/i.test(filename) && !/(?:^|\/)requirements[^/]*\.txt$/i.test(filename)) return false;
  return /\.(?:[cm]?[jt]sx?|py|pyi|java|kt|kts|go|rs|c|cc|cpp|cxx|h|hpp|cs|fs|rb|php|swift|scala|sh|bash|ps1|sql|vue|svelte|json|ya?ml|toml|ini|cfg)$/i.test(filename) ||
    /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|pytest\.ini|setup\.cfg|tox\.ini|requirements[^/]*\.txt|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|Makefile|CMakeLists\.txt|pom\.xml|build\.gradle|[^/]*(?:vitest|jest|tsconfig)[^/]*)$/i.test(filename);
}
const isTestPath = (filename: string) => /\.(?:[cm]?[jt]sx?|py|java|kt|go|rs|c|cc|cpp|cs|rb|php|swift|scala)$/i.test(filename) &&
  !/(?:^|\/)(?:helpers?|fixtures?|support)(?:\/|$)/i.test(filename) &&
  /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|(?:^|\/)(?:test[_-][^/]+|[^/]+(?:[._-](?:test|spec)|_test))\.[^/]+$/i.test(filename);
export function agentManifestDigest(files: Record<string, string>): string {
  return hash(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}
/** Match the command snapshot limits and input link rules. New files also change the digest. */
export function captureAgentVerificationManifest(workspaceRoot: string): { sha256: string; files: Record<string, string> } {
  const root = resolveSafe(workspaceRoot, "."), files: Record<string, string> = {};
  let count = 0, bytes = 0, entries = 0;
  const visit = (relative: string) => {
    for (const name of readdirSync(resolveSafe(root, relative || ".")).sort()) {
      if (name === ".harness_backups" || name === ".backups") continue;
      if (++entries > 20000) throw new PermissionError("Command snapshot exceeds its directory entry limit.");
      const rel = slash(path.join(relative, name)), target = resolveSafe(root, rel), stat = lstatSync(path.join(root, rel));
      if (stat.isDirectory()) { visit(rel); continue; }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new PermissionError(`Unsupported command input: ${rel}.`);
      if (stat.isSymbolicLink() && !lstatSync(target).isFile()) throw new PermissionError(`Command directory symlink is unsupported: ${rel}.`);
      bytes += statSync(target).size; count++;
      if (count > MAX_FILES || bytes > MAX_BYTES) throw new PermissionError("Command snapshot exceeds its limit of 10,000 files or 128 MiB.");
      const content = readFileSync(target);
      files[rel] = hash(content);
    }
  };
  visit("");
  return { sha256: agentManifestDigest(files), files };
}
function readSmall(root: string, file: string): string | undefined {
  try { const target = resolveSafe(root, file); if (lstatSync(target).size > 256 * 1024) return undefined; return readFileSync(target, "utf8"); } catch { return undefined; }
}
function quote(value: string): string {
  if (process.platform === "win32") {
    if (/[\r\n"%!]/.test(value)) throw new Error("Test path cannot be quoted safely for cmd.exe.");
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
/** Emit a requested marker only after the selected test command succeeds. */
export function appendVerificationSuccessMarker(command: string, marker: string): string {
  if (process.platform === "win32") {
    if (/[\r\n\0%!]/.test(marker)) throw new Error("The requested marker cannot be emitted safely by the Windows shell.");
    return `${command} && echo(${marker.replace(/[\^&|<>()"]/g, value => `^${value}`)}`;
  }
  return `${command} && printf '%s\\n' ${quote(marker)}`;
}
const reportArgument = () => process.platform === "win32" ? '"%WORKBENCH_TEST_REPORT%"' : '"$WORKBENCH_TEST_REPORT"';
const prefix = (cwd: string, command: string) => cwd === "." ? command : `cd ${quote(cwd)} && ${command}`;
function closestRoot(root: string, file: string): string {
  let dir = path.posix.dirname(file);
  for (;;) {
    if (["package.json", "pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].some(name => existsSync(resolveSafe(root, path.posix.join(dir, name))))) return dir;
    if (dir === ".") return ".";
    dir = path.posix.dirname(dir);
  }
}
function wrapperRunner(root: string, suiteRoot: string, script: string): AgentTestRunner | undefined {
  if (/(?:^|\s)vitest(?:\s|$)/.test(script)) return "vitest";
  if (/(?:^|\s)jest(?:\s|$)/.test(script)) return "jest";
  if (/\bnode\s+--test(?:\s|$)/.test(script)) return "node";
  const wrapper = script.match(/^node\s+([\w./-]+\.[cm]?js)$/)?.[1];
  if (wrapper) {
    const text = readSmall(root, path.posix.join(suiteRoot, wrapper));
    // A wrapper must forward reporter options; a dependency name alone is not a test command.
    if (text?.includes("process.argv.slice(2)")) {
      if (/vitest[/.]|["']vitest["']/.test(text)) return "vitest";
      if (/jest[/.]|["']jest["']/.test(text)) return "jest";
    }
  }
  return undefined;
}
function unittestCommand(testDirectory: string): string {
  // This wrapper only discovers and runs the project's existing tests. It creates no test cases.
  const code = `import unittest,json,os,sys\nsuite=unittest.defaultTestLoader.discover(${JSON.stringify(testDirectory)})\nclass Result(unittest.TextTestResult):\n def startTest(self,test):\n  super().startTest(test)\n  self.files.add(os.path.relpath(sys.modules[test.__class__.__module__].__file__,os.getcwd()).replace(os.sep,'/'))\nclass Runner(unittest.TextTestRunner):\n def _makeResult(self):\n  result=Result(self.stream,self.descriptions,self.verbosity)\n  result.files=set()\n  return result\nresult=Runner().run(suite)\nwith open(os.environ['WORKBENCH_TEST_REPORT'],'w') as stream: json.dump({'executed':result.testsRun-len(result.skipped),'failed':len(result.failures)+len(result.errors)+len(result.unexpectedSuccesses),'skipped':len(result.skipped),'testFiles':sorted(result.files)},stream)\nsys.exit(0 if result.wasSuccessful() else 1)`;
  const encoded = Buffer.from(code).toString("base64");
  return `${pythonCommand()} -B -c "import base64;exec(compile(base64.b64decode('${encoded}'),'<workbench-existing-tests>','exec'))"`;
}
const pythonCommand = () => process.platform === "win32" ? quote(getPythonExecutable()) : "python3";
export function discoverAgentTestPlans(input: { workspaceRoot: string; changedPaths: string[]; userCommand?: string }): AgentTestDiscovery {
  try {
    const root = resolveSafe(input.workspaceRoot, "."), manifest = captureAgentVerificationManifest(root);
    const paths = [...new Set(input.changedPaths.map(file => slash(path.relative(root, resolveSafe(root, file)))) )].sort();
    const groups = new Map<string, string[]>();
    for (const file of paths) { const dir = closestRoot(root, file); groups.set(dir, [...(groups.get(dir) ?? []), file]); }
    const plans: AgentTestPlan[] = [];
    for (const [dir, changedPaths] of groups) {
      const testFiles = Object.keys(manifest.files).filter(file => (dir === "." || file.startsWith(`${dir}/`)) && !/(?:^|\/)(?:node_modules|\.git|\.venv|venv|vendor)\//.test(file) && isTestPath(file));
      const changedTestPaths = changedPaths.filter(file => isTestPath(file) && manifest.files[file]);
      const relativeChanged = changedPaths.map(file => slash(path.posix.relative(dir, file)));
      const configOrShared = changedPaths.some(file => !/\.(?:[cm]?[jt]sx?|py|vue|svelte)$/i.test(file) || /(?:^|\/)(?:shared|common)\/|(?:config|setup)\.[^/]+$/i.test(file));
      let runner: AgentTestRunner | undefined, full = "", related: string | undefined, configuredExplicit = false, format: AgentTestPlan["reportFormat"] = "json";
      const packageText = readSmall(root, path.posix.join(dir, "package.json"));
      if (packageText) {
        const pkg = JSON.parse(packageText);
        const explicitScript = input.userCommand?.match(/^(npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)(?:\s+--\s+[\w./ '\"-]+)?$/);
        const scriptName = explicitScript?.[2] ?? "test";
        const script = typeof pkg.scripts?.[scriptName] === "string" ? pkg.scripts[scriptName].trim() : "";
        runner = wrapperRunner(root, dir, script);
        const manager = explicitScript?.[1] ?? (String(pkg.packageManager ?? "").split("@")[0] || (existsSync(resolveSafe(root, path.posix.join(dir, "pnpm-lock.yaml"))) ? "pnpm" : existsSync(resolveSafe(root, path.posix.join(dir, "yarn.lock"))) ? "yarn" : "npm"));
        if (!["npm", "pnpm", "yarn"].includes(manager)) runner = undefined;
        configuredExplicit = Boolean(explicitScript && runner);
        const base = explicitScript ? `${input.userCommand}${manager === "yarn" || /\s--(?:\s|$)/.test(input.userCommand!) ? "" : " --"}` : `${manager} test${manager === "yarn" ? "" : " --"}`;
        const report = reportArgument();
        if (runner === "vitest") {
          full = `${base} --run --reporter=json --outputFile=${report}`;
          // A direct runner can use related mode without changing a wrapper's setup.
          if (!configuredExplicit && !configOrShared && /^vitest(?:\s+run)?$/.test(script) && !changedTestPaths.length) {
            related = `node node_modules/vitest/vitest.mjs related ${relativeChanged.map(quote).join(" ")} --run --reporter=json --outputFile=${report}`;
          } else if (!configOrShared && changedTestPaths.length === changedPaths.length) related = `${full} ${relativeChanged.map(quote).join(" ")}`;
        } else if (runner === "jest") {
          full = `${base} --watch=false --runInBand --json --outputFile=${report}`;
          if (!configOrShared) related = `${full} --findRelatedTests ${relativeChanged.map(quote).join(" ")}`;
        } else if (runner === "node") {
          format = "unittest";
          // NODE_OPTIONS installs the host reporter before any file arguments in
          // an existing script. Appending Node flags after filenames changes their meaning.
          full = base;
        }
      } else {
        const config = ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].map(name => readSmall(root, path.posix.join(dir, name)) ?? "").join("\n");
        if (/pytest|\[tool\.pytest|\[pytest\]/.test(config) && testFiles.some(file => file.endsWith(".py"))) {
          runner = "pytest"; format = "junit"; full = `${pythonCommand()} -B -m pytest --junitxml=${reportArgument()} -o junit_family=xunit1`;
        } else {
          const existing = testFiles.filter(file => file.endsWith(".py") && /\bunittest\b/.test(readSmall(root, file) ?? ""));
          const directory = existing.length ? path.posix.dirname(path.posix.relative(dir, existing[0])) : undefined;
          if (directory && existing.every(file => path.posix.relative(dir, file).startsWith(directory === "." ? "" : `${directory}/`))) {
            runner = "unittest"; format = "unittest"; full = unittestCommand(directory);
          }
        }
      }
      if (input.userCommand && runner === "pytest" && /^(?:python[0-9.]*\s+(?:-B\s+)?-m\s+pytest|pytest)(?:\s+[^;&|\r\n]*)?$/.test(input.userCommand)) {
        full = `${input.userCommand} --junitxml=${reportArgument()} -o junit_family=xunit1`; related = undefined; configuredExplicit = true;
      }
      if (input.userCommand && /^node\s+--test(?:\s+[^;&|\r\n]*)?$/.test(input.userCommand) && testFiles.some(file => /(?:require\(['"]node:test['"]\)|from\s+['"]node:test['"])/.test(readSmall(root, file) ?? ""))) {
        runner = "node"; format = "unittest"; full = input.userCommand; related = undefined; configuredExplicit = true;
      }
      if (input.userCommand && !configuredExplicit) {
        // Custom commands must already select a machine report. Do not infer success from their words.
        if (/--junitxml(?:=|\s)|--reporter[=\s]+junit/.test(input.userCommand) && input.userCommand.includes("WORKBENCH_TEST_REPORT")) { runner = "junit"; format = "junit"; full = input.userCommand; related = undefined; }
        else if (/--(?:test-)?reporter[=\s]+tap/.test(input.userCommand)) { runner = "tap"; format = "tap"; full = input.userCommand; related = undefined; }
        else return { ok: false, reason: "unsupported_test_setup", detail: "The specified test command has no supported machine report. Use the existing setup's JSON, JUnit, or TAP reporter." };
      }
      if (!runner || !full || !testFiles.length) return { ok: false, reason: "no_usable_test_setup", detail: `No usable existing test setup was found in ${dir}. Tests were not created or substituted.` };
      plans.push({ id: hash(JSON.stringify({ suiteRoot: dir, runner, changedPaths, full, related })), workspaceRoot: root, suiteRoot: dir, runner, changedPaths, changedTestPaths, sourceManifest: manifest.files,
        manifestSha256: manifest.sha256, initialPhase: related ? "related" : "full", relatedCommand: related ? prefix(dir, related) : undefined,
        fullCommand: prefix(dir, full), reportFormat: format, testFiles });
    }
    return { ok: true, plans };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: /snapshot exceeds/.test(detail) ? "snapshot_limit" : "test_discovery_failed", detail };
  }
}
export function createAgentVerificationRequest(plan: AgentTestPlan, phase: AgentTestPhase = plan.initialPhase): AgentTestExecutionRequest {
  return { planId: plan.id, command: phase === "related" && plan.relatedCommand ? plan.relatedCommand : plan.fullCommand, phase,
    runner: plan.runner, suiteRoot: plan.suiteRoot, workspaceManifestSha256: plan.manifestSha256, sourceManifest: plan.sourceManifest,
    changedTestPaths: plan.changedTestPaths, reportFormat: plan.reportFormat, testFiles: plan.testFiles };
}
export function createAgentVerificationCall(request: AgentTestExecutionRequest, id = randomUUID()): AgentToolCall {
  return { id, name: "run_command", arguments: { command: request.command } };
}
interface ParsedTests { executed: number; failed: number; skipped: number; testFiles: string[]; failureOutput?: string }
const count = (value: unknown): number => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Test report count is invalid."); return value as number; };
function testFile(file: string, executionRoot: string, suiteRoot: string): string {
  const relative = path.isAbsolute(file) ? path.relative(executionRoot, file) : path.posix.join(suiteRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Test report path is outside the execution snapshot.");
  return slash(relative).replace(/^\.\//, "");
}
export function parseAgentTestReport(request: AgentTestExecutionRequest, report: string, executionRoot: string): ParsedTests {
  if (request.reportFormat === "json") {
    const data = JSON.parse(report), results = data.testResults;
    if (!Array.isArray(results) || !results.every(item => Array.isArray(item.assertionResults))) throw new Error("Test report has no assertion results.");
    let executed = 0, failed = 0, skipped = 0; const files: string[] = [], failures: string[] = [];
    for (const item of results) {
      let ran = false;
      for (const assertion of item.assertionResults) {
        if (assertion.status === "passed" || assertion.status === "failed") { executed++; ran = true; if (assertion.status === "failed") failed++; }
        else if (["pending", "todo", "skipped", "disabled"].includes(assertion.status)) skipped++;
        else throw new Error("Test report has an unknown assertion status.");
        if (assertion.status === "failed") failures.push(...(Array.isArray(assertion.failureMessages) ? assertion.failureMessages.filter((value: unknown) => typeof value === "string") : []));
      }
      if (ran) files.push(testFile(item.name ?? item.testFilePath, executionRoot, request.suiteRoot));
      if (item.status === "failed" && !item.assertionResults.length) failed++;
      if (item.status === "failed" && typeof item.message === "string") failures.push(item.message);
    }
    if (data.numFailedTests !== undefined && count(data.numFailedTests) !== results.reduce((total, item) => total + item.assertionResults.filter((test: { status: string }) => test.status === "failed").length, 0)) throw new Error("Test report counts disagree.");
    if (data.numTotalTests !== undefined && count(data.numTotalTests) !== executed + skipped) throw new Error("Test report totals disagree.");
    if (data.numFailedTestSuites !== undefined && count(data.numFailedTestSuites) > 0) failed = Math.max(failed, count(data.numFailedTestSuites));
    if (data.wasInterrupted === true) throw new Error("Test report was interrupted.");
    if (data.success === false) failed = Math.max(failed, 1);
    if (request.runner === "jest" && data.numTotalTestSuites !== undefined && count(data.numTotalTestSuites) !== results.length) throw new Error("Test suite totals disagree.");
    return { executed, failed, skipped, testFiles: [...new Set(files)], ...(failures.length ? { failureOutput: failures.join("\n").slice(0, 6000) } : {}) };
  }
  if (request.reportFormat === "unittest") {
    const data = JSON.parse(report);
    if (!Array.isArray(data.testFiles) || !data.testFiles.every((item: unknown) => typeof item === "string")) throw new Error("Test report has no test files.");
    const failureOutput = Array.isArray(data.failures) ? data.failures.map((failure: { name?: string; message?: string; stack?: string }) => `${failure.name ?? ""}: ${failure.message ?? ""}\n${failure.stack ?? ""}`).join("\n").slice(0, 6000) : "";
    return { executed: count(data.executed), failed: count(data.failed), skipped: count(data.skipped), testFiles: data.testFiles.map((file: string) => testFile(file, executionRoot, request.suiteRoot)), ...(failureOutput ? { failureOutput } : {}) };
  }
  if (request.reportFormat === "tap") {
    if (/\bBail out!/i.test(report)) throw new Error("TAP execution stopped before its plan completed.");
    const plan = report.match(/^1\.\.(\d+)(?:\s+#.*)?\s*$/m);
    if (!plan) throw new Error("TAP report has no complete test plan.");
    const assertions = [...report.matchAll(/^(\s*)(not ok|ok)\s+(\d+)(?:\s+([^\r\n]*))?$/gm)];
    const top = assertions.filter(item => item[1].length === 0);
    if (top.length !== Number(plan[1]) || top.some((item, index) => Number(item[3]) !== index + 1)) throw new Error("TAP report does not complete its test plan.");
    let passed = 0, failed = 0, skipped = 0;
    for (const assertion of assertions) {
      if (/\s#\s*(?:skip|todo)\b/i.test(` ${assertion[4] ?? ""}`)) skipped++;
      else if (assertion[2] === "not ok") failed++; else passed++;
    }
    // TAP supports explicit file subtests. Without file provenance changed test coverage stays unresolved.
    const files = request.testFiles.filter(file => report.includes(file) || report.includes(path.posix.relative(request.suiteRoot, file)));
    return { executed: passed + failed, failed, skipped, testFiles: files };
  }
  let executed = 0, failed = 0, skipped = 0, cases = 0; const files: string[] = [], failures: string[] = [];
  type Suite = { expected: Record<string, number>; tests: number; failures: number; errors: number; skipped: number };
  const suites: Suite[] = [];
  let sawSuite = false;
  let diagnostic = false;
  let current: { file?: string; name: string; skipped: boolean; failed: boolean; error: boolean } | undefined;
  const parser = new SaxesParser({ xmlns: false });
  parser.on("doctype", () => { throw new Error("JUnit DTDs are not accepted."); });
  parser.on("error", error => { throw error; });
  parser.on("opentag", tag => {
    if (tag.name === "testsuite" || tag.name === "testsuites") {
      sawSuite = true;
      const attrs = tag.attributes as Record<string, string>, expected: Record<string, number> = {};
      for (const field of ["tests", "failures", "errors", "skipped"]) if (attrs[field] !== undefined) {
        if (!/^\d+$/.test(attrs[field])) throw new Error("JUnit suite count is invalid.");
        expected[field] = count(Number(attrs[field]));
      }
      suites.push({ expected, tests: 0, failures: 0, errors: 0, skipped: 0 });
    } else if (tag.name === "testcase") {
      if (!suites.length) throw new Error("JUnit testcase is outside a test suite.");
      if (current) throw new Error("Nested JUnit testcase is invalid.");
      cases++; const attrs = tag.attributes as Record<string, string>;
      const inferred = attrs.classname?.replace(/\./g, "/") + ".py";
      const matched = request.testFiles.find(item => item === inferred || item.endsWith(`/${inferred}`));
      const file = attrs.file ?? (matched ? path.join(executionRoot, matched) : undefined);
      current = { file, name: attrs.name ?? "Test", skipped: false, failed: false, error: false };
    } else if (current && tag.name === "skipped") current.skipped = true;
    else if (current && ["failure", "error"].includes(tag.name)) {
      current.failed = true; current.error = tag.name === "error"; diagnostic = true;
      const message = (tag.attributes as Record<string, string>).message;
      failures.push(`${current.name}${message ? `: ${message}` : ""}`);
    }
  });
  parser.on("text", value => { if (diagnostic && failures.join("").length < 6000) failures.push(value.slice(0, 6000)); });
  parser.on("cdata", value => { if (diagnostic && failures.join("").length < 6000) failures.push(value.slice(0, 6000)); });
  parser.on("closetag", tag => {
    if (["failure", "error"].includes(tag.name)) diagnostic = false;
    if (tag.name === "testsuite" || tag.name === "testsuites") {
      const suite = suites.pop();
      if (!suite) throw new Error("JUnit suite is incomplete.");
      for (const field of ["tests", "failures", "errors", "skipped"] as const) if (suite.expected[field] !== undefined && suite.expected[field] !== suite[field]) throw new Error("JUnit suite totals disagree with its test cases.");
    }
    if (tag.name !== "testcase" || !current) return;
    for (const suite of suites) {
      suite.tests++; if (current.skipped) suite.skipped++;
      if (current.failed) { if (current.error) suite.errors++; else suite.failures++; }
    }
    if (current.skipped) skipped++; else { executed++; if (current.failed) failed++; if (current.file) files.push(testFile(current.file, executionRoot, request.suiteRoot)); }
    current = undefined;
  });
  parser.write(report).close();
  if (current || !cases || !sawSuite || suites.length) throw new Error("JUnit report has no complete test cases.");
  return { executed, failed, skipped, testFiles: [...new Set(files)], ...(failures.length ? { failureOutput: failures.join("\n").slice(0, 6000) } : {}) };
}
export function assessAgentTestExecution(evidence?: AgentTestExecutionEvidence): { status: "passed" | "failed" | "unverified"; reason: string; detail: string; fallbackAllowed: boolean } {
  if (!evidence) return { status: "unverified", reason: "missing_execution_evidence", detail: "No typed test execution evidence was saved.", fallbackAllowed: false };
  if (!Number.isSafeInteger(evidence.exitCode) || ![evidence.executed, evidence.failed, evidence.skipped].every(value => Number.isSafeInteger(value) && value >= 0) || typeof evidence.timedOut !== "boolean") return { status: "unverified", reason: "invalid_execution_evidence", detail: "The test result has no complete typed execution record.", fallbackAllowed: false };
  if (evidence.timedOut) return { status: "unverified", reason: "test_timeout", detail: "The test command exceeded its time limit.", fallbackAllowed: false };
  if (evidence.reason && !["test_failure", "zero_tests", "missing_test_coverage"].includes(evidence.reason)) return { status: "unverified", reason: evidence.reason, detail: evidence.detail ?? evidence.reason, fallbackAllowed: false };
  if (evidence.failed > 0) return { status: "failed", reason: "test_failure", detail: `${evidence.failed} tests failed.`, fallbackAllowed: false };
  if (evidence.reason) return { status: evidence.reason === "test_failure" ? "failed" : "unverified", reason: evidence.reason, detail: evidence.detail ?? evidence.reason, fallbackAllowed: evidence.phase === "related" && ["zero_tests", "missing_test_coverage"].includes(evidence.reason) };
  if (!evidence.executed) return { status: "unverified", reason: "zero_tests", detail: "No non-skipped test executed.", fallbackAllowed: evidence.phase === "related" };
  if (evidence.failed > 0 || evidence.exitCode !== 0) return { status: "failed", reason: "test_failure", detail: `${evidence.failed} tests failed; command exit ${evidence.exitCode}.`, fallbackAllowed: false };
  return { status: "passed", reason: "tests_passed", detail: `${evidence.executed} tests executed and passed.`, fallbackAllowed: false };
}
