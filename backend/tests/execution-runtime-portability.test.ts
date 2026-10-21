import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ files: new Set<string>(), aliases: new Map<string, string>(), directories: new Map<string, string[]>(), exec: vi.fn() }));
vi.mock("node:fs", async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...fs, existsSync: (file: string) => fixtures.files.has(file), statSync: (file: string) => { if (!fixtures.files.has(file)) throw new Error("missing"); return { isFile: () => true }; }, accessSync: (file: string) => { if (!fixtures.files.has(file)) throw new Error("missing"); }, realpathSync: (file: string) => fixtures.aliases.get(file) ?? file, readdirSync: (file: string) => fixtures.directories.get(file) ?? fs.readdirSync(file) };
});
vi.mock("../src/main/tools/child-process.js", () => ({ executeProcess: fixtures.exec }));
import { directPythonEnvironment, findBubblewrap, getPythonExecutable, probePythonIsolation, pythonLaunch } from "../src/main/tools/python-runtime.js";
import { macosLibraryRoots } from "../src/main/tools/macos-sandbox.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const platform = (value: string) => Object.defineProperty(process, "platform", { configurable: true, value });
const dirs = { inputDir: "/runs/input", intermediateDir: "/runs/intermediate", outputDir: "/runs/output", stagedInputs: ["local-module.py"] };
beforeEach(() => { fixtures.files.clear(); fixtures.aliases.clear(); fixtures.directories.clear(); fixtures.exec.mockReset(); vi.stubEnv("PYTHON", ""); vi.stubEnv("PATH", ""); });
afterEach(() => { Object.defineProperty(process, "platform", platformDescriptor); vi.unstubAllEnvs(); });

describe("Execution runtime portability", () => {
  it("discovers a Windows python3.exe without choosing macOS paths", () => {
    platform("win32"); vi.stubEnv("PATH", '"C:\\Python Only";C:\\Other');
    fixtures.files.add("/usr/bin/python3"); fixtures.files.add("C:\\Python Only\\python3.exe");
    const python = getPythonExecutable();
    expect(python).toBe("C:\\Python Only\\python3.exe");
    const windowsDirs = { inputDir: "C:\\run\\input", intermediateDir: "C:\\run\\intermediate", outputDir: "C:\\run\\output", stagedInputs: [] };
    const launch = pythonLaunch(python, windowsDirs, "C:\\run\\intermediate\\task.py");
    expect(launch.command).toBe(python); expect(launch.isolated).toBe(false);
    expect(launch.env.PYTHONPATH).toBe("C:\\run\\intermediate;C:\\run\\output");
    expect(launch.env.PATH).toBe("C:\\Python Only");
    expect(launch.env.TEMP).toBe(windowsDirs.outputDir);
  });
  it("resolves an explicit interpreter name on Windows PATH", () => {
    platform("win32"); vi.stubEnv("PATH", "C:\\Runtime"); vi.stubEnv("PYTHON", "custom-python.exe");
    fixtures.files.add("C:\\Runtime\\custom-python.exe");
    expect(getPythonExecutable()).toBe("C:\\Runtime\\custom-python.exe");
  });
  it("does not silently replace an invalid configured interpreter", () => {
    platform("win32"); vi.stubEnv("PYTHON", "C:\\Missing\\python.exe"); fixtures.files.add("/usr/bin/python3");
    expect(getPythonExecutable).toThrow(/configured PYTHON executable is unavailable/);
  });
  it("prefers a Linux PATH interpreter and resolves its symlink", () => {
    platform("linux"); vi.stubEnv("PATH", "/opt/venv/bin:/usr/bin");
    fixtures.files.add("/opt/venv/bin/python3"); fixtures.files.add("/usr/bin/python3"); fixtures.aliases.set("/opt/venv/bin/python3", "/opt/python/bin/python3");
    expect(getPythonExecutable()).toBe("/opt/python/bin/python3");
  });
  it("reports missing Python", () => { platform("linux"); expect(getPythonExecutable).toThrow(/Install Python 3/); });
  it("permits the macOS framework launcher without granting arbitrary execution or ancestor reads", () => {
    platform("darwin"); vi.stubEnv("WORKBENCH_USE_MAC_SANDBOX", "1");
    const root = "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14";
    const python = `${root}/bin/python3.14`, helper = `${root}/Resources/Python.app/Contents/MacOS/Python`;
    fixtures.files.add("/usr/bin/sandbox-exec"); fixtures.files.add(helper);
    const launch = pythonLaunch(python, dirs, "/runs/intermediate/task.py");
    const profile = launch.args[1];
    expect(profile).toContain('(allow file-read* (literal "/"))');
    expect(profile).toContain('(allow file-read-metadata (literal "/opt/homebrew/Cellar/python@3.14"))');
    expect(profile).toContain(`(allow process-exec (literal "${helper}"))`);
    expect(profile).toContain(`(allow file-read* (subpath "${root}"))`);
    expect(profile).not.toContain('(allow file-read* (subpath "/"))');
    expect(profile).not.toContain('(allow file-read* (subpath "/runs"))');
    expect(profile).not.toContain('(allow process-exec)');
    expect(profile).not.toContain('(allow process-fork)');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(allow file-write* (subpath "/runs/output"))');
    expect(profile).toContain('(deny file-write* (literal "/runs/output/local-module.py"))');
    expect(profile).toContain('(deny file-write* (literal "/runs/output/local_module.py"))');
  });
  it("does not authorize a framework helper redirected outside its runtime", () => {
    platform("darwin"); vi.stubEnv("WORKBENCH_USE_MAC_SANDBOX", "1");
    const root = "/Library/Frameworks/Python.framework/Versions/3.14";
    const helper = `${root}/Resources/Python.app/Contents/MacOS/Python`;
    fixtures.files.add("/usr/bin/sandbox-exec"); fixtures.files.add(helper);
    fixtures.aliases.set(helper, "/bin/sh");
    const launch = pythonLaunch(`${root}/bin/python3`, dirs, "/runs/intermediate/task.py");
    expect(launch.args[1]).not.toContain('(allow process-exec (literal "/bin/sh"))');
  });
  it("resolves installed library links but excludes links into private user data", () => {
    for (const file of ["/opt/homebrew/opt", "/opt/homebrew/Cellar", "/opt/homebrew/opt/sqlite/lib", "/opt/homebrew/opt/escape/lib"]) fixtures.files.add(file);
    fixtures.directories.set("/opt/homebrew/opt", ["sqlite", "escape"]);
    fixtures.aliases.set("/opt/homebrew/opt/sqlite/lib", "/opt/homebrew/Cellar/sqlite/3.53/lib");
    fixtures.aliases.set("/opt/homebrew/opt/escape/lib", "/Users/private");
    expect(macosLibraryRoots()).toEqual(["/opt/homebrew/opt/sqlite/lib", "/opt/homebrew/Cellar/sqlite/3.53/lib"]);
  });
  it("bounds the installed library scan instead of granting broader reads", () => {
    fixtures.files.add("/opt/homebrew/opt"); fixtures.files.add("/opt/homebrew/Cellar");
    fixtures.directories.set("/opt/homebrew/opt", Array.from({length: 513}, (_, index) => String(index)));
    expect(macosLibraryRoots).toThrow(/exceeds 512/);
  });
  it("finds Linux bubblewrap on PATH", () => {
    platform("linux"); vi.stubEnv("PATH", "/opt/tools"); fixtures.files.add("/opt/tools/bwrap"); expect(findBubblewrap()).toBe("/opt/tools/bwrap");
  });
  it("requires explicit approval on Windows without probing a fake sandbox", async () => {
    platform("win32"); const launch = pythonLaunch("C:\\Python\\python3.exe", dirs, "/runs/intermediate/task.py");
    const status = await probePythonIsolation(launch, launch.command, dirs.outputDir);
    expect(status.status).toBe("approval_required"); expect(status.message).toMatch(/Windows.*approval/); expect(status.message).toContain("dependencies"); expect(fixtures.exec).not.toHaveBeenCalled();
  });
  it("reports Linux bubblewrap prerequisites when it is missing", async () => {
    platform("linux"); const launch = pythonLaunch("/usr/bin/python3", dirs, "/runs/intermediate/task.py");
    expect(launch.command).toBe("/usr/bin/python3");
    const status = await probePythonIsolation(launch, launch.command, dirs.outputDir);
    expect(status.status).toBe("approval_required"); expect(status.message).toContain("user namespaces");
  });
  it.each(["success", "failed", "invalid output"])("handles a Linux isolation probe: %s", async outcome => {
    platform("linux"); for (const file of ["/usr/bin/bwrap", "/usr", "/bin", "/lib", "/runs/output/local-module.py", "/runs/output/local_module.py"]) fixtures.files.add(file);
    const launch = pythonLaunch("/opt/python/bin/python3", dirs, "/runs/intermediate/nested/task.py");
    expect(launch.args).toContain("--unshare-all"); expect(launch.args).toContain("/opt/python"); expect(launch.args).toContain("/intermediate/nested/task.py");
    expect(launch.args).toContain("/output/local_module.py");
    if (outcome === "failed") fixtures.exec.mockRejectedValue(new Error("user namespaces disabled"));
    else fixtures.exec.mockResolvedValue({ stdout: outcome === "success" ? "WORKBENCH_ISOLATED\n" : "wrong", stderr: "" });
    const status = await probePythonIsolation(launch, "/opt/python/bin/python3", dirs.outputDir);
    expect(status.status).toBe(outcome === "success" ? "os_isolated" : "approval_required");
    expect(fixtures.exec.mock.calls[0][1]).toContain("/opt/python/bin/python3");
    if (outcome === "failed") expect(status.message).toContain("user namespaces disabled");
    const directEnv = directPythonEnvironment("/opt/python/bin/python3", dirs);
    expect(directEnv.PYTHONPATH).toBe("/runs/intermediate:/runs/output"); expect(directEnv.TMPDIR).toBe(dirs.outputDir);
  });
});
