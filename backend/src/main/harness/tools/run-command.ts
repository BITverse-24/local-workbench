import type { ExecutionCapability } from "../../../shared/contracts.js";
import { findBubblewrap } from "../../tools/python-runtime.js";
import { MACOS_TOOL_SELECTORS, macosReadRules } from "../../tools/macos-sandbox.js";
import { executeProcess } from "../../tools/child-process.js";
import { assertRuntimeActive, currentRuntimeScope } from "../../run/runtime-scope.js";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSafe, PermissionError } from "../path-guard.js";
import { writeFile } from "./write-file.js";
import { deleteFile } from "./delete-file.js";
import type { MutationPolicyGuard } from "../policy-guard.js";
import { agentManifestDigest, captureAgentVerificationManifest, isCodeVerificationPath, NODE_EXISTING_TEST_REPORTER, parseAgentTestReport, type AgentTestExecutionEvidence, type AgentTestExecutionRequest } from "../../agent/test-verification.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  changes: string[];
  backupPaths: string[];
  isolationStatus: "os_isolated" | "unisolated";
  isolationMessage: string;
  verification?: AgentTestExecutionEvidence;
}

// A usability guard, not an OS security boundary. Approval is still required.
export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  // Destructive operations
  /\b(rm\s+-[a-z]*[rf]|rmdir|del\s+[\/a-z]*|erase)\b/i,
  /(^|[;&|\s])unlink\s+/i,
  /\b(git\s+clean\s+-[a-z]*f|git\s+reset\s+--hard)\b/i,
  /\b(find\s+.*-delete)\b/i,
  /\b(format\s+[a-z]:|mkfs|fdisk|parted\b)/i,
  /^(rm|del)\s+/i,
  // Privilege escalation
  /\b(sudo|su|doas|pkexec)\b/i,
  /\b(chmod\s+([0-7]*[4-7][0-7]{2}|\+s)|chown)\b/i,
  // Network egress in air-gapped environment
  /\b(curl|wget|nc|netcat|ssh|scp|ftp|sftp|telnet|ping|socat|nmap)\b/i,
  // Reverse shells & device redirection
  /\/dev\/(tcp|udp)/i,
  // Fork bombs & shutdown
  /\b(shutdown|reboot|poweroff|init\s+0|halt)\b/i,
  // Direct raw disk writes
  /\bdd\s+if=/i,
  // Access to backup recovery trail
  /\.harness_backups|\.backups/i,
];


export function validateCommandSafety(command: string): void {
  if (typeof command !== "string" || !command.trim()) throw new Error("command must be a non-empty string");
  if (/\.harness_backups|\.backups/i.test(command)) throw new PermissionError("command access to backup recovery trail forbidden");
  if (DANGEROUS_COMMAND_PATTERNS.some(pattern => pattern.test(command))) throw new PermissionError("destructive or unsafe command rejected");
}

const MAX_FILES = 10000;
const MAX_BYTES = 128 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Snapshot = Map<string, { bytes: Buffer; mode: number; hash: string }> & { directories: Set<string> };

/** Never follow links while taking a snapshot or publishing subprocess output. */
function snapshot(root: string, rejectLinks: boolean): Snapshot {
  const files = Object.assign(new Map<string, { bytes: Buffer; mode: number; hash: string }>(), { directories: new Set<string>() });
  let total = 0;
  const visit = (relative: string) => {
    assertRuntimeActive();
    for (const entry of readdirSync(path.join(root, relative))) {
      if (entry === ".harness_backups" || entry === ".backups") continue;
      const name = path.join(relative, entry);
      const file = path.join(root, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        if (rejectLinks) throw new PermissionError(`Command snapshots do not accept symlinks: ${name}.`);
        // Materialize an authorized in-workspace link as independent bytes.
        const resolved = resolveSafe(root, name);
        if (!lstatSync(resolved).isFile()) throw new PermissionError(`Command directory symlink is unsupported: ${name}.`);
        total += lstatSync(resolved).size;
        if (total > MAX_BYTES) throw new PermissionError("Command snapshot exceeds 128 MiB.");
        const bytes = readFileSync(resolved);
        files.set(name, { bytes, mode: 0o600, hash: digest(bytes) });
      } else if (stat.isDirectory()) { files.directories.add(name); visit(name); }
      else if (stat.isFile()) {
        total += stat.size;
        if (total > MAX_BYTES) throw new PermissionError("Command snapshot exceeds 128 MiB.");
        const bytes = readFileSync(file);
        files.set(name, { bytes, mode: stat.mode & 0o777, hash: digest(bytes) });
      } else throw new PermissionError(`Unsupported command input: ${name}.`);
      if (files.size > MAX_FILES || total > MAX_BYTES) throw new PermissionError("Command snapshot exceeds its file or byte limit.");
    }
  };
  visit("");
  return files;
}

const literal = (value: string) => JSON.stringify(value);

function sandboxLaunch(workspace: string, scratch: string, command: string, extraEnv: NodeJS.ProcessEnv = {}): CommandLaunch {
  const trustedPath = [...new Set(["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin", ...(process.env.PATH ?? "").split(path.delimiter).filter(directory => /^(?:\/usr\/|\/bin$|\/opt\/homebrew\/)/.test(directory))])].join(path.delimiter);
  const env: NodeJS.ProcessEnv = { PATH: trustedPath, HOME: scratch, TMPDIR: scratch, LANG: "en_US.UTF-8", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", ...extraEnv };
  if (process.platform === "darwin" && process.env.WORKBENCH_USE_MAC_SANDBOX !== "0" && existsSync("/usr/bin/sandbox-exec")) {
    const roots = ["/usr", "/bin", "/sbin", "/System", "/Library", "/opt/homebrew"].filter(existsSync).map(root => realpathSync(root));
    const profile = [
      "(version 1)", "(deny default)", "(deny network*)", "(allow process-exec)", "(allow process-fork)",
      "(allow sysctl-read)",
      ...macosReadRules([...roots, ...MACOS_TOOL_SELECTORS, workspace, scratch]),
      `(allow file-read* file-write* (subpath ${literal(workspace)}))`,
      `(allow file-read* file-write* (subpath ${literal(scratch)}))`,
      '(allow file-read* file-write* (literal "/dev/null"))',
      '(allow file-read* (literal "/dev/urandom") (literal "/dev/random"))',
      "(deny file-link)",
    ].join("\n");
    return { binary: "/usr/bin/sandbox-exec", args: ["-p", profile, "/bin/sh", "-c", command], env };
  }
  if (process.platform === "linux") {
    const binary = findBubblewrap();
    if (binary) {
      return { binary, args: ["--die-with-parent", "--unshare-all", "--new-session", "--clearenv", ...Object.entries(env).flatMap(([key,value]) => ["--setenv",key,value!]),
        ...["/usr", "/bin", "/lib", "/lib64"].filter(existsSync).flatMap(root => ["--ro-bind", root, root]),
        "--proc", "/proc", "--dev", "/dev", "--bind", workspace, workspace, "--bind", scratch, scratch,
        "--chdir", workspace, "--", "/bin/sh", "-c", command], env };
    }
  }
  const reason = process.platform === "win32"
    ? "This app has no Windows OS isolation backend."
    : process.platform === "linux"
    ? "OS isolation requires bubblewrap (bwrap) and enabled user namespaces."
    : "Workspace commands require OS isolation. sandbox-exec is unavailable or disabled.";
  throw new PermissionError(`Unsupported sandbox containment: ${reason} No command was executed.`);
}

export const COMMAND_FALLBACK_DISCLOSURE = "The app tries OS isolation first. If isolation cannot start, this approved command runs with your user permissions. It can read or change files outside the workspace and access the network. The workspace copy and publication checks do not provide OS isolation.";

type CommandLaunch = { binary: string; args: string[]; env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean };

function directLaunch(scratch: string, command: string, extraEnv: NodeJS.ProcessEnv = {}): CommandLaunch {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? process.env.Path, HOME: scratch, TMPDIR: scratch,
    LANG: "en_US.UTF-8", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", ...extraEnv,
  };
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const binary = path.win32.join(systemRoot, "System32", "cmd.exe");
    Object.assign(env, { SystemRoot: systemRoot, WINDIR: systemRoot, COMSPEC: binary,
      TEMP: scratch, TMP: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
      PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD" });
    // Match Node's Windows shell launch. cmd.exe receives the approved command
    // unchanged, including operators and quotes, with AutoRun disabled.
    return { binary, args: ["/d", "/s", "/c", `"${command}"`], env, windowsVerbatimArguments: true };
  }
  return { binary: "/bin/sh", args: ["-c", command], env };
}

/** Probe fixed code only. Select fallback before, never after, running user code. */
async function selectCommandLaunch(workspace: string, scratch: string, command: string, extraEnv: NodeJS.ProcessEnv = {}) {
  try {
    const probe = sandboxLaunch(workspace, scratch, "printf WORKBENCH_ISOLATED");
    const result = await executeProcess(probe.binary, probe.args, { cwd: workspace, env: probe.env, timeout: 5000, maxBuffer: 4096 });
    if (result.stdout !== "WORKBENCH_ISOLATED") throw new Error("Invalid isolation probe response.");
    return { launch: sandboxLaunch(workspace, scratch, command, extraEnv), status: "os_isolated" as const,
      message: "Command uses OS isolation. The network is blocked." };
  } catch (error) {
    assertRuntimeActive();
    return { launch: directLaunch(scratch, command, extraEnv), status: "unisolated" as const,
      message: `OS isolation is unavailable. ${String(error).slice(0, 500)} ${COMMAND_FALLBACK_DISCLOSURE}` };
  }
}

export async function getCommandCapability(): Promise<ExecutionCapability> {
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "workbench-command-probe-")));
  const work = path.join(temporary, "workspace"), scratch = path.join(temporary, "scratch");
  try {
    mkdirSync(work, { mode: 0o700 }); mkdirSync(scratch, { mode: 0o700 });
    const selected = await selectCommandLaunch(work, scratch, "echo WORKBENCH_COMMAND");
    if (selected.status === "os_isolated") return { status: "os_isolated", message: selected.message };
    // Verify the native shell too, so missing launchers still have a clear error.
    const { launch } = selected;
    const result = await executeProcess(launch.binary, launch.args, { cwd: work, env: launch.env,
      windowsVerbatimArguments: launch.windowsVerbatimArguments, timeout: 5000, maxBuffer: 4096 });
    if (result.stdout.trim() !== "WORKBENCH_COMMAND") throw new Error("Invalid command shell probe response.");
    return { status: "approval_required", message: `${selected.message} Shell: ${process.platform === "win32" ? "Windows cmd.exe" : "/bin/sh"}. Use commands for this shell.` };
  } catch (error) {
    assertRuntimeActive();
    return { status: "unavailable", message: `The command shell could not start. ${String(error).slice(0, 700)}` };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/**
 * Commands run against an independent workspace snapshot. The original workspace
 * is protected by the OS only when isolation is active. Approved fallback code
 * has user permissions; the snapshot cannot contain its absolute-path access.
 * A successful command's file changes are checked together and published through
 * guarded writers with backups. Failed/cancelled commands publish no changes.
 */
export async function runCommand(workspaceRoot: string, command: string, timeoutMs = 60000,
  policy?: { guard: MutationPolicyGuard; runId?: string; assertAuthority?: () => void }, verification?: AgentTestExecutionRequest): Promise<CommandResult> {
  assertRuntimeActive();
  if (currentRuntimeScope() && currentRuntimeScope()!.mode !== "agent") throw new PermissionError("Only Agent may execute workspace commands.");
  policy?.assertAuthority?.();
  const root = resolveSafe(workspaceRoot, ".");
  validateCommandSafety(command);
  if (verification && verification.command !== command) throw new PermissionError("The verification command does not match its approved test plan.");
  const started = Date.now();
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "workbench-command-")));
  const work = path.join(temporary, "workspace");
  const scratch = path.join(temporary, "scratch");
  mkdirSync(work, { mode: 0o700 }); mkdirSync(scratch, { mode: 0o700 });
  try {
    const reportPath = path.join(scratch, "test-report");
    const reporterPath = path.join(scratch, "node-reporter.cjs");
    if (verification?.runner === "node") writeFileSync(reporterPath, NODE_EXISTING_TEST_REPORTER);
    const selected = await selectCommandLaunch(work, scratch, command, verification ? { WORKBENCH_TEST_REPORT: reportPath, WORKBENCH_TEST_REPORTER: reporterPath,
      ...(verification.runner === "node" ? { NODE_OPTIONS: `--test-reporter=${JSON.stringify(reporterPath)}` } : {}) } : {});
    const fallbackApproved = () => Boolean(policy?.guard.isUnisolatedCommandAuthorized(policy.runId, command));
    if (selected.status === "unisolated" && !fallbackApproved()) {
      throw new PermissionError(`Unsupported sandbox containment: command execution without OS isolation requires approval for this exact command and run. No command was executed. ${selected.message}`);
    }
    assertRuntimeActive();
    policy?.assertAuthority?.();
    if (policy && !policy.guard.isAuthorized(policy.runId, "run_command", { command })) throw new PermissionError("Command approval was revoked before execution.");
    const before = snapshot(root, false);
    const beforeFiles = Object.fromEntries([...before].map(([name, file]) => [name.split(path.sep).join("/"), file.hash]));
    if (verification && agentManifestDigest(beforeFiles) !== verification.workspaceManifestSha256) throw new PermissionError("Test plan is stale: workspace inputs changed before execution.");
    for (const directory of before.directories) mkdirSync(path.join(work, directory), { recursive: true });
    for (const [name, file] of before) {
      const destination = path.join(work, name);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, file.bytes, { mode: file.mode });
    }
    const { launch } = selected;
    currentRuntimeScope()?.observe?.({ commandIsolationStatus: selected.status,
      isolationStatus: selected.status === "os_isolated" ? "os_isolated" : "approved_uncontained" });
    let stdout = "", stderr = "", exitCode = 0, timedOut = false;
    try {
      ({stdout, stderr} = await executeProcess(launch.binary, launch.args, { cwd: work, env: launch.env, windowsVerbatimArguments: launch.windowsVerbatimArguments, timeout: timeoutMs, maxBuffer: 1024 * 1024 }));
    } catch (error: any) {
      assertRuntimeActive();
      stdout = error.stdout ?? ""; stderr = error.stderr ?? String(error);
      exitCode = typeof error.code === "number" ? error.code : 1; timedOut = Boolean(error.killed);
    }
    assertRuntimeActive();
    const result: CommandResult = { stdout: stdout.slice(0,8000), stderr: stderr.slice(0,8000), exitCode, timedOut, durationMs: Date.now()-started, changes: [], backupPaths: [], isolationStatus: selected.status, isolationMessage: selected.message };
    if (verification) {
      policy?.assertAuthority?.();
      if (policy && (!policy.guard.isAuthorized(policy.runId, "run_command", { command }) || (selected.status === "unisolated" && !fallbackApproved()))) throw new PermissionError("Command approval was revoked before verification completed.");
      const evidence: AgentTestExecutionEvidence = { planId: verification.planId, command, runner: verification.runner, phase: verification.phase,
        manifestSha256: verification.workspaceManifestSha256, sourceManifest: beforeFiles, exitCode, timedOut, executed: 0, failed: 0, skipped: 0,
        testFiles: [], isolationStatus: selected.status,
        ...(verification.successMarker ? { successMarker: verification.successMarker, successMarkerObserved: stdout.split(/\r?\n/).some(line => line.trim() === verification.successMarker) } : {}) };
      result.verification = evidence;
      try {
        if (timedOut) { evidence.reason = "test_timeout"; evidence.detail = "The test command exceeded its time limit."; }
        else {
          if (verification.reportFormat === "tap") evidence.report = stdout;
          else {
            const safeReport = resolveSafe(scratch, "test-report");
            if (!existsSync(safeReport) || !lstatSync(safeReport).isFile() || lstatSync(safeReport).isSymbolicLink()) throw new Error("The test runner did not write a regular machine report.");
            if (lstatSync(safeReport).size > 16 * 1024 * 1024) throw new Error("Test report exceeds its 16 MiB limit.");
            evidence.report = readFileSync(safeReport, "utf8");
          }
          Object.assign(evidence, parseAgentTestReport(verification, evidence.report!, work));
          if (evidence.failed > 0) { evidence.reason = "test_failure"; evidence.detail = `${evidence.failed} tests failed.`; }
          else if (evidence.executed === 0) { evidence.reason = "zero_tests"; evidence.detail = "No non-skipped test executed."; }
          else if (exitCode !== 0) { evidence.reason = "test_failure"; evidence.detail = `The test runner exited with code ${exitCode}. ${stderr.slice(0, 1000)}`; }
          else if (verification.changedTestPaths.some(file => !evidence.testFiles.includes(file))) { evidence.reason = "missing_test_coverage"; evidence.detail = "The report does not show execution of every changed test file."; }
        }
      } catch (error) {
        evidence.reason = /not write/.test(String(error)) && /not found|No module named|cannot find|is not recognized|permission denied|cannot execute/i.test(stderr) ? "test_dependency_unavailable" : "invalid_test_report";
        evidence.detail = `${error instanceof Error ? error.message : String(error)}${stderr ? ` ${stderr.slice(0, 1000)}` : ""}`;
      }
      // Test outputs, caches, and coverage stay in the disposable copy. Existing
      // input files must keep their bytes; generated outputs cannot repair code.
      for (const [name, file] of before) {
        if (/(?:^|[/\\])(?:coverage|\.pytest_cache|\.cache|__pycache__|dist|build)(?:[/\\]|$)/.test(name)) continue;
        try {
          const target = resolveSafe(work, name);
          if (!lstatSync(target).isFile() || digest(readFileSync(target)) !== file.hash) { evidence.reason = "tested_inputs_changed"; evidence.detail = `The test command changed an input file: ${name}.`; break; }
        } catch { evidence.reason = "tested_inputs_changed"; evidence.detail = `The test command removed or replaced an input file: ${name}.`; break; }
      }
      try {
        for (const name of snapshot(work, true).keys()) {
          if (!before.has(name) && !/(?:^|[/\\])(?:coverage|\.pytest_cache|\.cache|__pycache__|dist|build)(?:[/\\]|$)/.test(name) && isCodeVerificationPath(name)) {
            evidence.reason = "tested_inputs_changed"; evidence.detail = `The test command created a source, test, or configuration file: ${name}.`; break;
          }
        }
      } catch (error) { evidence.reason = "test_snapshot_invalid"; evidence.detail = String(error); }
      try {
        if (captureAgentVerificationManifest(root).sha256 !== verification.workspaceManifestSha256) { evidence.reason = "stale_test_evidence"; evidence.detail = "Workspace inputs changed during test execution."; }
      } catch (error) { evidence.reason = "stale_test_evidence"; evidence.detail = String(error); }
      result.durationMs = Date.now() - started;
      return result;
    }
    if (exitCode !== 0) return result;
    const after = snapshot(work, true);
    // A directory-only operation cannot be represented by the guarded file writer.
    // Reject it explicitly rather than report an unapplied operation as success.
    for (const directory of after.directories) {
      if (!before.directories.has(directory) && ![...after.keys()].some(name => name.startsWith(directory + path.sep))) throw new PermissionError("Command created an empty directory. Use an approved file write in that directory. No changes were published.");
    }
    for (const directory of before.directories) if (!after.directories.has(directory)) throw new PermissionError("Command removed a directory. No changes were published.");
    const changes = [...new Set([...before.keys(), ...after.keys()])].filter(name => before.get(name)?.hash !== after.get(name)?.hash || before.get(name)?.mode !== after.get(name)?.mode);
    // Validate the entire change set and current authority before the first write.
    policy?.assertAuthority?.();
    if (policy && (!policy.guard.isAuthorized(policy.runId, "run_command", { command }) || (selected.status === "unisolated" && !fallbackApproved()))) throw new PermissionError("Command approval was revoked before publication.");
    for (const name of changes) {
      if (policy && (policy.guard.isPathProtected(policy.runId, name) || policy.guard.isPathTargetRestricted(policy.runId, name))) throw new PermissionError(`Command attempted an out-of-scope change: ${name}. No changes were published.`);
      if (existsSync(path.join(root, name)) && lstatSync(path.join(root, name)).isSymbolicLink()) throw new PermissionError(`Command changed a symlink input: ${name}. No changes were published.`);
      const target = resolveSafe(root, name);
      const existing = existsSync(target) ? digest(readFileSync(target)) : undefined;
      if (existing !== before.get(name)?.hash) throw new PermissionError(`Workspace changed during command execution: ${name}. No changes were published.`);
    }
    assertRuntimeActive();
    for (const name of changes) {
      const changed = after.get(name);
      const mutation = changed ? writeFile(root, name, changed.bytes) : deleteFile(root, name);
      if (changed) chmodSync(resolveSafe(root, name), changed.mode);
      if (mutation.backupPath) result.backupPaths.push(mutation.backupPath);
      result.changes.push(`${changed ? "written" : "deleted"}:${name}`);
    }
    result.durationMs = Date.now()-started;
    return result;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
