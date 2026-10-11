import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { executeProcess } from "./child-process.js";
import { assertRuntimeActive } from "../run/runtime-scope.js";
import type { ExecutionCapability } from "../../shared/contracts.js";

function executableFile(filename: string): boolean {
  try {
    if (!statSync(filename).isFile()) return false;
    accessSync(filename, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

/** Resolve once. Every probe and execution uses this same absolute interpreter. */
export function getPythonExecutable(): string {
  const windows = process.platform === "win32";
  const paths = (process.env.PATH ?? process.env.Path ?? "").split(windows ? ";" : ":")
    .map(directory => directory.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const join = windows ? path.win32.join : path.join;
  const configured = process.env.PYTHON?.trim();
  const names = configured ? [configured, ...(windows && !configured.toLowerCase().endsWith(".exe") ? [`${configured}.exe`] : [])] : windows ? ["python.exe", "python3.exe"] : ["python3", "python"];
  const candidates = configured
    ? [...names, ...paths.flatMap(directory => names.map(name => join(directory, name)))]
    : [...paths.flatMap(directory => names.map(name => join(directory, name))),
       ...(windows ? [] : ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"])];
  for (const candidate of candidates) {
    if ((windows ? path.win32.isAbsolute(candidate) : path.isAbsolute(candidate)) && executableFile(candidate)) return realpathSync(candidate);
  }
  throw new Error(configured ? "The configured PYTHON executable is unavailable. Set PYTHON to an executable path or a name on PATH." : "Python is unavailable. Install Python 3 or set PYTHON to its executable path.");
}

export function findBubblewrap(): string | undefined {
  const candidates = ["/usr/bin/bwrap", "/bin/bwrap", ...(process.env.PATH ?? "").split(":").filter(Boolean).map(directory => path.join(directory, "bwrap"))];
  return candidates.find(candidate => path.isAbsolute(candidate) && executableFile(candidate));
}

function literal(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface PythonDirectories {
  inputDir: string;
  intermediateDir: string;
  outputDir: string;
  stagedInputs: string[];
}

export function directPythonEnvironment(python: string, dirs: PythonDirectories): NodeJS.ProcessEnv {
  const windows = process.platform === "win32";
  return {
    PATH: windows ? path.win32.dirname(python) : "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    PYTHONPATH: [dirs.intermediateDir, dirs.outputDir].join(windows ? ";" : ":"),
    PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONUTF8: "1",
    LANG: "en_US.UTF-8", TMPDIR: dirs.outputDir,
    ...(windows ? { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: dirs.outputDir, TMP: dirs.outputDir } : {}),
  };
}

export function pythonLaunch(python: string, dirs: PythonDirectories, script: string) {
  const env = directPythonEnvironment(python, dirs);
  const inputNames = dirs.stagedInputs.flatMap(name => name.endsWith(".py") && name.includes("-") ? [name, name.replace(/-/g, "_")] : [name]);
  if (process.platform === "linux") {
    const bwrap = findBubblewrap();
    if (bwrap) {
      const roots = ["/usr", "/bin", "/lib", "/lib64"].filter(existsSync);
      // Dedicated Python installs (for example /opt/venv) need their runtime too.
      const prefix = path.resolve(path.dirname(python), "..");
      if (prefix !== "/" && !roots.some(root => prefix === root || prefix.startsWith(root + "/"))) roots.push(prefix);
      return { command: bwrap, isolated: true, env: { ...env, PYTHONPATH: "/intermediate:/output", TMPDIR: "/output" }, args: [
        "--die-with-parent", "--unshare-all", "--new-session",
        ...roots.flatMap(root => ["--ro-bind", root, root]),
        "--proc", "/proc", "--dev", "/dev",
        "--ro-bind", dirs.inputDir, "/input", "--ro-bind", dirs.intermediateDir, "/intermediate", "--bind", dirs.outputDir, "/output",
        ...inputNames.map(name => path.join(dirs.outputDir, name)).filter(existsSync).flatMap(file => ["--ro-bind", file, path.posix.join("/output", path.basename(file))]),
        "--chdir", "/output", "--", python, path.posix.join("/intermediate", path.relative(dirs.intermediateDir, script).split(path.sep).join("/")), ...dirs.stagedInputs,
      ] };
    }
  }
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && process.env.WORKBENCH_USE_MAC_SANDBOX !== "0") {
    const profile = [
      "(version 1)", "(deny default)", "(deny network*)",
      `(allow process-exec (literal ${literal(python)}))`,
      ...["/usr/lib", "/usr/share", path.resolve(path.dirname(python), ".."), "/opt/homebrew/lib", "/opt/homebrew/opt", "/System", "/Library", dirs.inputDir, dirs.intermediateDir, dirs.outputDir].map(root => `(allow file-read* (subpath ${literal(root)}))`),
      `(allow file-write* (subpath ${literal(dirs.outputDir)}))`,
      ...inputNames.map(name => `(deny file-write* (literal ${literal(path.join(dirs.outputDir, name))}))`),
    ].join(" ");
    return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, python, script, ...dirs.stagedInputs], env, isolated: true };
  }
  return { command: python, args: [script, ...dirs.stagedInputs], env, isolated: false };
}

export async function probePythonIsolation(launch: ReturnType<typeof pythonLaunch>, python: string, cwd: string): Promise<ExecutionCapability> {
  if (!launch.isolated) return { status: "approval_required", message: process.platform === "win32"
    ? "Python on Windows requires approval. It runs with your user permissions, without filesystem or network isolation. Approval covers the exact source, dependencies, and inputs."
    : process.platform === "linux"
    ? "Python requires approval without OS isolation. Install bubblewrap (bwrap) and enable user namespaces for isolated execution. Approval covers the exact source, dependencies, and inputs; filesystem and network access remain unrestricted."
    : "Python requires approval without OS isolation. Filesystem and network access remain unrestricted. Approval covers the exact source, dependencies, and inputs." };
  try {
    const args = process.platform === "darwin" ? ["-p", launch.args[1], python, "-c", "print('WORKBENCH_ISOLATED')"] : [...launch.args.slice(0, launch.args.indexOf("--") + 1), python, "-c", "print('WORKBENCH_ISOLATED')"];
    const result = await executeProcess(launch.command, args, { cwd, env: launch.env, timeout: 5000, maxBuffer: 4096 });
    if (result.stdout.trim() !== "WORKBENCH_ISOLATED") throw new Error("Invalid isolation probe response.");
    return { status: "os_isolated", message: "Python isolation probe passed. Filesystem access is limited to run storage and runtime files; network access is blocked." };
  } catch (error) {
    assertRuntimeActive();
    return { status: "approval_required", message: `Python isolation could not start${process.platform === "linux" ? "; check bubblewrap and user namespace settings" : ""}. Approval is required. Filesystem and network access remain unrestricted. Approval covers the exact source, dependencies, and inputs. Diagnostic: ${String(error).slice(0, 500)}` };
  }
}
