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

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  changes: string[];
  backupPaths: string[];
}

// A usability guard. Only an effective OS sandbox grants process authority.
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


export function validateCommandSafety(command: string, hasContainment = true): void {
  if (typeof command !== "string" || !command.trim()) throw new Error("command must be a non-empty string");
  if (/\.harness_backups|\.backups/i.test(command)) throw new PermissionError("command access to backup recovery trail forbidden");
  if (DANGEROUS_COMMAND_PATTERNS.some(pattern => pattern.test(command))) throw new PermissionError("destructive or unsafe command rejected");
  if (!hasContainment) throw new PermissionError("Unsupported sandbox containment: commands require effective OS isolation.");
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

function sandboxLaunch(workspace: string, scratch: string, command: string): { binary: string; args: string[]; env: NodeJS.ProcessEnv } {
  const trustedPath = [...new Set(["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin", ...(process.env.PATH ?? "").split(path.delimiter).filter(directory => /^(?:\/usr\/|\/bin$|\/opt\/homebrew\/)/.test(directory))])].join(path.delimiter);
  const env: NodeJS.ProcessEnv = { PATH: trustedPath, HOME: scratch, TMPDIR: scratch, LANG: "en_US.UTF-8", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
  if (process.platform === "darwin" && process.env.WORKBENCH_USE_MAC_SANDBOX !== "0" && existsSync("/usr/bin/sandbox-exec")) {
    const roots = ["/usr", "/bin", "/sbin", "/System", "/Library", "/opt/homebrew"].filter(existsSync).map(root => realpathSync(root));
    const profile = [
      "(version 1)", "(deny default)", "(deny network*)", "(allow process-exec)", "(allow process-fork)",
      "(allow sysctl-read)",
      ...roots.map(root => `(allow file-read* (subpath ${literal(root)}))`),
      `(allow file-read* file-write* (subpath ${literal(workspace)}))`,
      `(allow file-read* file-write* (subpath ${literal(scratch)}))`,
      '(allow file-read* file-write* (literal "/dev/null"))',
      '(allow file-read* (literal "/dev/urandom") (literal "/dev/random"))',
      "(deny file-link)",
    ].join("\n");
    return { binary: "/usr/bin/sandbox-exec", args: ["-p", profile, "/bin/sh", "-c", command], env };
  }
  if (process.platform === "linux") {
    const binary = ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync);
    if (binary) {
      return { binary, args: ["--die-with-parent", "--unshare-all", "--new-session", "--clearenv", ...Object.entries(env).flatMap(([key,value]) => ["--setenv",key,value!]),
        ...["/usr", "/bin", "/lib", "/lib64"].filter(existsSync).flatMap(root => ["--ro-bind", root, root]),
        "--proc", "/proc", "--dev", "/dev", "--bind", workspace, workspace, "--bind", scratch, scratch,
        "--chdir", workspace, "--", "/bin/sh", "-c", command], env };
    }
  }
  throw new PermissionError("Unsupported sandbox containment: commands require effective OS isolation. No command was executed.");
}

/**
 * Commands run against an independent workspace snapshot. The original workspace
 * is never writable by a subprocess, even through hard links or absolute paths.
 * A successful command's file changes are checked together and published through
 * guarded writers with backups. Failed/cancelled commands publish no changes.
 */
export async function runCommand(workspaceRoot: string, command: string, timeoutMs = 60000,
  policy?: { guard: MutationPolicyGuard; runId?: string; assertAuthority?: () => void }): Promise<CommandResult> {
  assertRuntimeActive();
  if (currentRuntimeScope() && currentRuntimeScope()!.mode !== "agent") throw new PermissionError("Only Agent may execute workspace commands.");
  policy?.assertAuthority?.();
  const root = resolveSafe(workspaceRoot, ".");
  validateCommandSafety(command);
  const started = Date.now();
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "workbench-command-")));
  const work = path.join(temporary, "workspace");
  const scratch = path.join(temporary, "scratch");
  mkdirSync(work, { mode: 0o700 }); mkdirSync(scratch, { mode: 0o700 });
  try {
    // Probe the actual launcher before copying inputs or running user code.
    const probe = sandboxLaunch(work, scratch, "printf WORKBENCH_ISOLATED");
    try {
      const result = await executeProcess(probe.binary, probe.args, { cwd: work, env: probe.env, timeout: 5000, maxBuffer: 4096 });
      if (result.stdout !== "WORKBENCH_ISOLATED") throw new Error("Invalid isolation probe response");
    } catch (error) {
      assertRuntimeActive();
      throw new PermissionError("Unsupported sandbox containment: OS isolation could not start. No command was executed.");
    }
    assertRuntimeActive();
    const before = snapshot(root, false);
    for (const directory of before.directories) mkdirSync(path.join(work, directory), { recursive: true });
    for (const [name, file] of before) {
      const destination = path.join(work, name);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, file.bytes, { mode: file.mode });
    }
    const launch = sandboxLaunch(work, scratch, command);
    currentRuntimeScope()?.observe?.({ commandIsolationStatus: "os_isolated" });
    let stdout = "", stderr = "", exitCode = 0, timedOut = false;
    try {
      ({stdout, stderr} = await executeProcess(launch.binary, launch.args, { cwd: work, env: launch.env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }));
    } catch (error: any) {
      assertRuntimeActive();
      stdout = error.stdout ?? ""; stderr = error.stderr ?? String(error);
      exitCode = typeof error.code === "number" ? error.code : 1; timedOut = Boolean(error.killed);
    }
    assertRuntimeActive();
    const result: CommandResult = { stdout: stdout.slice(0,8000), stderr: stderr.slice(0,8000), exitCode, timedOut, durationMs: Date.now()-started, changes: [], backupPaths: [] };
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
    if (policy && !policy.guard.isAuthorized(policy.runId, "run_command", { command })) throw new PermissionError("Command approval was revoked before publication.");
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
