import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveSafe, PermissionError } from "../path-guard.js";
import { clearListDirCache } from "./list-dir.js";

const exec = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Denylist for destructive, privilege escalation, network egress, and backup-tampering commands.
 * A command denylist supplements platform containment, but never substitutes for it (P0-06 §C).
 */
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

/**
 * Approved safe workspace development tools permitted when platform containment is unavailable.
 * Arbitrary unknown binaries or uncontained scripts fail closed.
 */
export const SAFE_UNCONTAINED_BINARIES = new Set([
  "echo",
  "pwd",
  "ls",
  "dir",
  "cat",
  "touch",
  "sleep",
  "exit",
  "node",
  "npm",
  "npx",
  "python",
  "python3",
  "git",
  "pytest",
  "cargo",
  "vitest",
  "tsc",
]);

export function extractPrimaryBinary(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/);
  for (const token of tokens) {
    if (token.includes("=") && !token.startsWith("./") && !token.startsWith("/") && !token.includes("\\")) {
      continue; // skip env var assignments like FOO=bar
    }
    const base = path.basename(token).toLowerCase().replace(/\.exe$/, "");
    return base;
  }
  return "";
}

export function detectPlatformContainment(): boolean {
  if (process.platform === "linux") {
    return existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap");
  }
  if (process.platform === "darwin") {
    return existsSync("/usr/bin/sandbox-exec") && process.env.WORKBENCH_USE_MAC_SANDBOX === "1";
  }
  return false;
}

export function validateCommandSafety(command: string, hasContainment: boolean): void {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("command must be a non-empty string");
  }

  // Reject access or manipulation of backup recovery trail (P0-06 §D)
  if (/\.harness_backups|\.backups/i.test(trimmed)) {
    throw new PermissionError("command access to backup recovery trail forbidden");
  }

  // Enforce dangerous command denylist (P0-06 §C)
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new PermissionError(`destructive or unsafe command rejected: ${trimmed}`);
    }
  }

  // If effective containment is unavailable, fail closed for arbitrary commands (P0-06 §C)
  if (!hasContainment) {
    if (process.env.WORKBENCH_STRICT_SANDBOX === "1") {
      throw new PermissionError("strict containment required but unavailable on platform");
    }
    const binary = extractPrimaryBinary(trimmed);
    if (!SAFE_UNCONTAINED_BINARIES.has(binary)) {
      throw new PermissionError(
        `Unsupported sandbox containment: arbitrary shell command '${binary}' is blocked when platform sandbox is unavailable.`,
      );
    }
  }
}

/**
 * Execute a command with cwd = workspace root.
 * HARNESS.md §5: returns stdout/stderr/exit code.
 *
 * Platform-aware sandboxing & fail-closed containment (P0-06 §C):
 * - Linux: Bubblewrap (`bwrap`) with network isolation (`--unshare-net`), workspace bound rw.
 * - macOS / Windows / Linux-without-bwrap: fails closed for arbitrary uncontained shell commands,
 *   strictly enforcing denylist and safe binary boundaries.
 */
export async function runCommand(
  workspaceRoot: string,
  command: string,
  timeoutMs: number = 60000,
): Promise<CommandResult> {
  const canonicalRoot = resolveSafe(workspaceRoot, ".");

  if (!command || typeof command !== "string") {
    throw new Error("command must be a non-empty string");
  }

  const hasContainment = detectPlatformContainment();
  validateCommandSafety(command, hasContainment);

  const started = Date.now();

  // Linux: use Bubblewrap if installed for network and filesystem confinement
  let result: CommandResult;
  if (process.platform === "linux" && hasContainment) {
    const bwrapCandidates = ["/usr/bin/bwrap", "/bin/bwrap"];
    const bwrap = bwrapCandidates.find((p) => existsSync(p))!;
    result = await execSandboxedLinux(bwrap, canonicalRoot, command, timeoutMs, started);
  } else {
    // Verified safe development command with locked cwd
    result = await execDirect(canonicalRoot, command, timeoutMs, started);
  }

  // Clear listDir cache so files created or modified by the command are reflected immediately
  clearListDirCache();

  return result;
}

async function execSandboxedLinux(
  bwrap: string,
  workspaceRoot: string,
  command: string,
  timeoutMs: number,
  started: number,
): Promise<CommandResult> {
  const args = [
    "--die-with-parent",
    "--unshare-net",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
  ];

  if (existsSync("/lib")) args.push("--ro-bind", "/lib", "/lib");
  if (existsSync("/lib64")) args.push("--ro-bind", "/lib64", "/lib64");
  if (existsSync("/etc/resolv.conf")) args.push("--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf");

  args.push(
    "--bind", workspaceRoot, workspaceRoot,
    "--chdir", workspaceRoot,
    "--",
    "/bin/sh", "-c", command,
  );

  try {
    const result = await exec(bwrap, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return {
      stdout: result.stdout.slice(0, 8000),
      stderr: result.stderr.slice(0, 8000),
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - started,
    };
  } catch (error: any) {
    return {
      stdout: (error.stdout ?? "").slice(0, 8000),
      stderr: (error.stderr ?? String(error)).slice(0, 8000),
      exitCode: typeof error.code === "number" ? error.code : 1,
      timedOut: Boolean(error.killed),
      durationMs: Date.now() - started,
    };
  }
}

async function execDirect(
  workspaceRoot: string,
  command: string,
  timeoutMs: number,
  started: number,
): Promise<CommandResult> {
  try {
    const isWin = process.platform === "win32";
    const shellCmd = isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
    const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
    const result = await exec(shellCmd, shellArgs, {
      cwd: workspaceRoot,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return {
      stdout: result.stdout.slice(0, 8000),
      stderr: result.stderr.slice(0, 8000),
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - started,
    };
  } catch (error: any) {
    return {
      stdout: (error.stdout ?? "").slice(0, 8000),
      stderr: (error.stderr ?? String(error)).slice(0, 8000),
      exitCode: typeof error.code === "number" ? error.code : 1,
      timedOut: Boolean(error.killed),
      durationMs: Date.now() - started,
    };
  }
}
