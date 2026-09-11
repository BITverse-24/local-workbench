import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { resolveSafe } from "../path-guard.js";

const exec = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Execute a command with cwd = workspace root.
 * HARNESS.md §5: returns stdout/stderr/exit code.
 *
 * Platform-aware sandboxing:
 * - Linux: Bubblewrap (`bwrap`) with network isolation (`--unshare-net`), workspace bound rw.
 * - macOS/fallback: child_process with cwd locked to canonical workspace root + timeout.
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

  const started = Date.now();

  // Linux: use Bubblewrap if installed for network and filesystem confinement
  if (process.platform === "linux") {
    const bwrapCandidates = ["/usr/bin/bwrap", "/bin/bwrap"];
    const bwrap = bwrapCandidates.find((p) => existsSync(p));
    if (bwrap) {
      return execSandboxedLinux(bwrap, canonicalRoot, command, timeoutMs, started);
    }
  }

  // macOS / Windows / Linux-without-bwrap fallback: direct shell with locked cwd
  return execDirect(canonicalRoot, command, timeoutMs, started);
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
    const result = await exec("/bin/sh", ["-c", command], {
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
