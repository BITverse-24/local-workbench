import { mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ exec: vi.fn(), isolated: false, python: "C:\\Python Only\\python3.exe" }));
vi.mock("../src/main/tools/child-process.js", () => ({ executeProcess: fixtures.exec }));
vi.mock("../src/main/tools/python-runtime.js", async () => {
  const runtime = await vi.importActual<typeof import("../src/main/tools/python-runtime.js")>("../src/main/tools/python-runtime.js");
  return { ...runtime, getPythonExecutable: () => fixtures.python,
    pythonLaunch: (python: string, dirs: any, script: string) => fixtures.isolated
      ? { command: "/usr/bin/bwrap", isolated: true, args: ["--unshare-all", "--", python, script], env: { ...runtime.directPythonEnvironment(python, dirs), PYTHONPATH: "/intermediate:/output", TMPDIR: "/output" } }
      : runtime.pythonLaunch(python, dirs, script) };
});
import { executePython } from "../src/main/tools/python.js";
import { createRunDirectories, resolveRunPath, writeRunFile } from "../src/main/run/filesystem.js";
import { withRuntimeScope } from "../src/main/run/runtime-scope.js";

const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string, runId: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "python-portability-"))); vi.stubEnv("WORKBENCH_DATA_ROOT", root);
  runId = randomUUID(); createRunDirectories(runId);
  writeRunFile(runId, "intermediate", "task.py", "print(7)");
  writeFileSync(resolveRunPath(runId, "input/data.csv", "input"), "value\n7\n");
  fixtures.exec.mockReset(); fixtures.isolated = false; fixtures.python = "C:\\Python Only\\python3.exe";
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
});
afterEach(() => { Object.defineProperty(process, "platform", descriptor); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const run = (approve: (code: string, inputs: string[], digest: string) => Promise<boolean>) => withRuntimeScope({ runId, mode: "work", signal: new AbortController().signal, approveUncontainedPython: approve }, () => executePython(runId, "task.py", ["data.csv"]));

describe("Python execution and approval portability", () => {
  it("launches the resolved Windows python3.exe after digest-bound approval", async () => {
    let approvalFinished = false;
    fixtures.exec.mockImplementation(async () => { expect(approvalFinished).toBe(true); return { stdout: "7\n", stderr: "" }; });
    const approve = vi.fn(async (code, inputs, digest) => {
      expect(code).toContain("print(7)"); expect(inputs.some((entry: string) => entry.startsWith("data.csv:"))).toBe(true); expect(digest).toMatch(/^[a-f0-9]{64}$/);
      approvalFinished = true; return true;
    });
    const result = await run(approve);
    expect(result.stdout).toBe("7\n"); expect(approve).toHaveBeenCalledOnce();
    expect(fixtures.exec).toHaveBeenCalledOnce(); expect(fixtures.exec.mock.calls[0][0]).toBe(fixtures.python);
    expect(fixtures.exec.mock.calls[0][2].env.PYTHONPATH).toContain("python-executions");
  });
  it("refuses Windows Python when approval is denied", async () => {
    await expect(run(async () => false)).rejects.toThrow(/not approved/); expect(fixtures.exec).not.toHaveBeenCalled();
  });
  it.each(["source", "dependency", "input"])("refuses changed %s bytes after approval", async changed => {
    writeRunFile(runId, "intermediate", "helper.py", "value = 7");
    await expect(run(async () => {
      const file = changed === "source" ? resolveRunPath(runId, "intermediate/task.py", "intermediate") : changed === "dependency" ? resolveRunPath(runId, "intermediate/helper.py", "intermediate") : undefined;
      if (file) writeFileSync(file, "print(8)");
      else {
        const fs = await import("node:fs");
        const executions = resolveRunPath(runId, "intermediate/python-executions", "intermediate");
        const stagedInput = path.join(executions, fs.readdirSync(executions)[0], "data.csv");
        fs.chmodSync(stagedInput, 0o600); writeFileSync(stagedInput, "value\n8\n");
      }
      return true;
    })).rejects.toThrow(/changed after approval/);
    expect(fixtures.exec).not.toHaveBeenCalled();
  });
  it("rebuilds host paths after a failed Linux isolation probe", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" }); fixtures.isolated = true; fixtures.python = "/opt/python/bin/python3";
    fixtures.exec.mockRejectedValueOnce(new Error("namespace disabled")).mockResolvedValueOnce({ stdout: "7\n", stderr: "" });
    const approve = vi.fn(async () => true); const result = await run(approve);
    expect(result.exitCode).toBe(0); expect(approve).toHaveBeenCalledOnce(); expect(fixtures.exec).toHaveBeenCalledTimes(2);
    const [command, args, options] = fixtures.exec.mock.calls[1];
    expect(command).toBe(fixtures.python); expect(args[0]).toBe(resolveRunPath(runId, "intermediate/task.py", "intermediate"));
    expect(options.env.PYTHONPATH).toContain(root); expect(options.env.PYTHONPATH).not.toBe("/intermediate:/output"); expect(options.env.TMPDIR).toBe(options.cwd);
    expect(readFileSync(path.join(options.cwd, "data.csv"), "utf8")).toContain("7");
  });
  it("does not execute the Linux fallback without approval", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" }); fixtures.isolated = true;
    fixtures.exec.mockRejectedValue(new Error("namespace disabled"));
    await expect(run(async () => false)).rejects.toThrow(/not approved/); expect(fixtures.exec).toHaveBeenCalledOnce();
  });
});
