import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutionCapabilities, ExecutionCapability } from "../../shared/contracts.js";
import { getCommandCapability } from "../harness/tools/run-command.js";
import { assertRuntimeActive } from "../run/runtime-scope.js";
import { executeProcess } from "./child-process.js";
import { getPythonExecutable, pythonLaunch, probePythonIsolation, directPythonEnvironment } from "./python-runtime.js";

export async function getPythonCapability(): Promise<ExecutionCapability> {
  let temporary: string | undefined;
  try {
    const python = getPythonExecutable();
    temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "workbench-python-probe-")));
    const dirs = { inputDir: path.join(temporary, "input"), intermediateDir: path.join(temporary, "intermediate"), outputDir: path.join(temporary, "output"), stagedInputs: [] as string[] };
    for (const directory of [dirs.inputDir, dirs.intermediateDir, dirs.outputDir]) mkdirSync(directory, { mode: 0o700 });
    // Check the selected interpreter with fixed code before offering Python.
    const result = await executeProcess(python, ["-c", "import sys; print(sys.version_info.major)"], { cwd: dirs.outputDir, env: directPythonEnvironment(python, dirs), timeout: 5000, maxBuffer: 4096 });
    if (result.stdout.trim() !== "3") throw new Error("Python 3 is required.");
    return await probePythonIsolation(pythonLaunch(python, dirs, path.join(dirs.intermediateDir, "task.py")), python, dirs.outputDir);
  } catch (error) {
    assertRuntimeActive();
    return { status: "unavailable", message: `Python is unavailable. ${String(error).slice(0, 500)}` };
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
}

export async function getExecutionCapabilities(): Promise<ExecutionCapabilities> {
  const [workspaceCommands, python] = await Promise.all([getCommandCapability(), getPythonCapability()]);
  return { platform: process.platform, workspaceCommands, python };
}
