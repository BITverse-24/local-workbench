import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { getPythonExecutable, pythonLaunch, probePythonIsolation } from "../src/main/tools/python-runtime.js";
import { executeProcess } from "../src/main/tools/child-process.js";
import { getPythonCapability } from "../src/main/tools/execution-capabilities.js";
import { getCommandCapability, runCommand } from "../src/main/harness/tools/run-command.js";
import { executePython } from "../src/main/tools/python.js";
import { createRunDirectories, writeRunFile } from "../src/main/run/filesystem.js";
import { withRuntimeScope } from "../src/main/run/runtime-scope.js";

// These tests must execute inside the real sandbox. An approved fallback cannot pass.
describe.runIf(process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))("macOS sandbox compatibility and containment", () => {
  let root: string;
  let dirs: { inputDir: string; intermediateDir: string; outputDir: string; stagedInputs: string[] };
  beforeEach(() => {
    vi.stubEnv("WORKBENCH_USE_MAC_SANDBOX", "1");
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'workbench sandbox "')));
    dirs = { inputDir: path.join(root, "input"), intermediateDir: path.join(root, "intermediate"), outputDir: path.join(root, "output"), stagedInputs: ["input.csv"] };
    for (const dir of [dirs.inputDir, dirs.intermediateDir, dirs.outputDir]) mkdirSync(dir);
    writeFileSync(path.join(dirs.inputDir, "input.csv"), "value\n7\n");
    writeFileSync(path.join(dirs.outputDir, "input.csv"), "value\n7\n");
    writeFileSync(path.join(root, "private.txt"), "PRIVATE");
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  async function run(source: string) {
    const python = getPythonExecutable(), script = path.join(dirs.intermediateDir, "task.py");
    writeFileSync(script, source);
    const launch = pythonLaunch(python, dirs, script);
    expect(launch.isolated).toBe(true);
    expect((await probePythonIsolation(launch, python, dirs.outputDir)).status).toBe("os_isolated");
    return executeProcess(launch.command, launch.args, { cwd: dirs.outputDir, env: launch.env, timeout: 10000, maxBuffer: 65536 });
  }

  it("starts the configured Python, imports runtime libraries, and writes a result", async () => {
    const result = await run(`import csv, math, hashlib, sqlite3, ssl, zlib, decimal, unittest
from pathlib import Path
with open('input.csv') as source:
    rows = list(csv.DictReader(source))
assert rows == [{'value': '7'}]
assert math.sqrt(49) == 7
Path('result.txt').write_text(hashlib.sha256(b'7').hexdigest())
print('CHECKED')
`);
    expect(result.stdout.trim()).toBe("CHECKED");
    expect(readFileSync(path.join(dirs.outputDir, "result.txt"), "utf8")).toHaveLength(64);
    expect((await getPythonCapability()).status).toBe("os_isolated");
  });

  it("blocks outside reads, writes, symlink escapes, source changes, and input replacement", async () => {
    symlinkSync(path.join(root, "private.txt"), path.join(dirs.outputDir, "escape.txt"));
    await run(`from pathlib import Path
def denied(action):
    try:
        action()
    except PermissionError:
        return
    raise AssertionError('Access was allowed')
denied(lambda: Path(${JSON.stringify(path.join(root, "private.txt"))}).read_text())
denied(lambda: Path(${JSON.stringify(path.join(root, "private.txt"))}).write_text('CHANGED'))
denied(lambda: list(Path(${JSON.stringify(root)}).iterdir()))
denied(lambda: Path('escape.txt').read_text())
denied(lambda: Path('escape.txt').write_text('CHANGED'))
denied(lambda: Path(__file__).write_text('CHANGED'))
denied(lambda: Path(${JSON.stringify(path.join(dirs.inputDir, "input.csv"))}).write_text('CHANGED'))
denied(lambda: Path('input.csv').write_text('CHANGED'))
denied(lambda: Path('input.csv').unlink())
Path('replacement').write_text('CHANGED')
denied(lambda: Path('replacement').replace('input.csv'))
`);
    expect(readFileSync(path.join(root, "private.txt"), "utf8")).toBe("PRIVATE");
    expect(readFileSync(path.join(dirs.outputDir, "input.csv"), "utf8")).toBe("value\n7\n");
  });

  it("blocks network connections and execution of an unrelated program", async () => {
    let connections = 0;
    const server = createServer(socket => { connections++; socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      await run(`import socket, subprocess
try:
    socket.create_connection(('127.0.0.1', ${port}), timeout=1)
except PermissionError:
    pass
else:
    raise AssertionError('Network connection was allowed')
try:
    subprocess.run(['/bin/sh', '-c', 'echo UNEXPECTED'], check=True)
except PermissionError:
    pass
else:
    raise AssertionError('Unrelated executable was allowed')
`);
      expect(connections).toBe(0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("runs Agent commands in isolation and publishes only the workspace result", async () => {
    expect((await getCommandCapability()).status).toBe("os_isolated");
    const result = await runCommand(dirs.outputDir, 'python3 -c \'from pathlib import Path; Path("result.txt").write_text("CHECKED")\'', 10000);
    expect(result.isolationStatus).toBe("os_isolated");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(readFileSync(path.join(dirs.outputDir, "result.txt"), "utf8")).toBe("CHECKED");
  });

  it("runs an existing Node test module in the Agent sandbox", async () => {
    writeFileSync(path.join(dirs.outputDir, "value.test.cjs"), "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('value',()=>assert.equal(3+4,7));\n");
    const result = await runCommand(dirs.outputDir, 'node --test --test-reporter=tap value.test.cjs', 10000);
    expect(result.isolationStatus).toBe("os_isolated");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/# pass 1/);
    expect(result.stdout).toMatch(/# fail 0/);
  });

  it("uses the Work staging and publication path without asking for uncontained approval", async () => {
    vi.stubEnv("WORKBENCH_DATA_ROOT", root);
    const runId = "00000000-0000-4000-8000-000000000001";
    createRunDirectories(runId);
    writeRunFile(runId, "input", "input.csv", "value\n7\n");
    writeRunFile(runId, "intermediate", "task.py", `import csv
from pathlib import Path
with open('input.csv') as source:
    rows = list(csv.DictReader(source))
assert rows == [{'value': '7'}]
Path('result.txt').write_text('CHECKED')
print('CHECKED')
`);
    const approve = vi.fn(async () => { throw new Error("Unexpected fallback approval"); });
    const observe = vi.fn();
    const result = await withRuntimeScope({ runId, mode: "work", signal: new AbortController().signal,
      approveUncontainedPython: approve, observe }, () => executePython(runId, "task.py", ["input.csv"]));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.outputFiles).toContain("result.txt");
    expect(readFileSync(path.join(root, "runs", runId, "output", "result.txt"), "utf8")).toBe("CHECKED");
    expect(approve).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith({ isolationStatus: "os_isolated" });
    expect(result.inputEvidence?.[0].beforeSha256).toBe(result.inputEvidence?.[0].afterSha256);
  });

  it("reports a terminating signal rather than a null exit code", async () => {
    await expect(executeProcess(getPythonExecutable(), ["-c", "import os, signal; os.kill(os.getpid(), signal.SIGTERM)"], {
      timeout: 5000, maxBuffer: 4096,
    })).rejects.toMatchObject({ signal: "SIGTERM", message: "Process terminated by SIGTERM" });
  });

  it("discovers Homebrew Python even with minimal packaged macOS PATH", async () => {
    vi.stubEnv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    const python = getPythonExecutable();
    expect(python).not.toBe("/usr/bin/python3");
    expect(python).toMatch(/python/);
    const capability = await getPythonCapability();
    expect(capability.status).toBe("os_isolated");
  });

  it("allows macOS CommandLineTools python under sandbox isolation without xcode-select error", async () => {
    const clt = "/Library/Developer/CommandLineTools/usr/bin/python3";
    if (!existsSync(clt)) return;
    const cltPython = realpathSync(clt);
    const script = path.join(dirs.intermediateDir, "clt-test.py");
    writeFileSync(script, "print('CLT_OK')");
    const launch = pythonLaunch(cltPython, dirs, script);
    const capability = await probePythonIsolation(launch, cltPython, dirs.outputDir);
    expect(capability.status).toBe("os_isolated");
  });
});
