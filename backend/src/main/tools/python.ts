import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolveRunPath } from "../run/filesystem.js";
import type { PythonExecutionResult } from "../../shared/contracts.js";
const exec = promisify(execFile);
export async function executePython(runId: string, source: string, inputFiles: string[], timeoutMs = 60000): Promise<PythonExecutionResult> { if (!existsSync("/usr/bin/bwrap") && !existsSync("/bin/bwrap")) throw new Error("Bubblewrap is unavailable"); void inputFiles; void source; const started = Date.now(); try { const result = await exec("bwrap", ["--die-with-parent", "--unshare-net", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", resolveRunPath(runId, "input", "input"), "/input", "--ro-bind", resolveRunPath(runId, "intermediate", "intermediate"), "/intermediate", "--bind", resolveRunPath(runId, "output", "output"), "/output", "--chdir", "/output", "--", "/usr/bin/python3", "/intermediate/task.py"], { timeout: timeoutMs, maxBuffer: 16384 }); return { exitCode: 0, stdout: result.stdout.slice(0, 8000), stderr: result.stderr.slice(0, 8000), timedOut: false, outputFiles: [], durationMs: Date.now() - started }; } catch (error) { const e = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean }; return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: (e.stdout ?? "").slice(0, 8000), stderr: (e.stderr ?? String(error)).slice(0, 8000), timedOut: Boolean(e.killed), outputFiles: [], durationMs: Date.now() - started }; } }

