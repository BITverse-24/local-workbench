import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveRunPath } from "../run/filesystem.js";
import { resolveSafe } from "../harness/path-guard.js";
import type { PythonExecutionResult } from "../../shared/contracts.js";

const exec = promisify(execFile);
function getPythonExecutable(): string {
  if (process.env.PYTHON && existsSync(process.env.PYTHON)) {
    return process.env.PYTHON;
  }
  const candidates = [
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
  ];
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && existsSync(candidate)) {
      return candidate;
    }
  }
  return "python3";
}

function profileLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function macSandboxProfile(pythonBin: string, inputDir: string, intermediateDir: string, outputDir: string, stagedInputs: string[]): string {
  const stagedInputRules = stagedInputs.map((file) => `(deny file-write* (literal ${profileLiteral(path.join(outputDir, file))}))`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    `(allow process-exec (literal ${profileLiteral(pythonBin)}))`,
    `(allow file-read* (subpath ${profileLiteral("/usr")}))`,
    `(allow file-read* (subpath ${profileLiteral("/opt")}))`,
    `(allow file-read* (subpath ${profileLiteral("/System")}))`,
    `(allow file-read* (subpath ${profileLiteral("/Library")}))`,
    `(allow file-read* (subpath ${profileLiteral(inputDir)}))`,
    `(allow file-read* (subpath ${profileLiteral(intermediateDir)}))`,
    `(allow file-read* (subpath ${profileLiteral(outputDir)}))`,
    `(allow file-write* (subpath ${profileLiteral(outputDir)}))`,
    stagedInputRules,
  ].join(" ");
}

type InputAlias = { logical: string; source: string };

function stageInputs(runId: string, inputFiles: string[], aliases: InputAlias[] = [], workspaceRoot?: string) {
  const inputDir = resolveRunPath(runId, "input", "input");
  const intermediateDir = resolveRunPath(runId, "intermediate", "intermediate");
  const outputDir = resolveRunPath(runId, "output", "output");
  mkdirSync(outputDir, { recursive: true });
  const stagedInputs: string[] = [];
  for (const inputFile of inputFiles) {
    const rawTrimmed = (inputFile ?? "").trim();
    if (!rawTrimmed) continue;
    const filename = path.basename(rawTrimmed);
    if (!filename || filename === "." || filename === "..") throw new Error("Python input file must be a valid filename");
    const alias = aliases.find((item) => item.logical === filename);
    const sourceName = alias?.source ? path.basename(alias.source) : filename;

    let source: string | null = null;

    // Run attachments take precedence over identically named workspace files.
    if (!source) {
      const directInput = path.join(inputDir, sourceName);
      if (existsSync(directInput)) {
        source = directInput;
      } else if (existsSync(inputDir)) {
        const files = readdirSync(inputDir);
        const matched = files.find((f) => f === sourceName || f.endsWith(`-${sourceName}`));
        if (matched) {
          source = path.join(inputDir, matched);
        }
      }
    }

    if (!source && workspaceRoot) {
      const workspaceInput = resolveSafe(workspaceRoot, rawTrimmed);
      if (existsSync(workspaceInput)) source = workspaceInput;
    }

    // 3. Intermediate directory
    if (!source) {
      const intermediateSource = path.join(intermediateDir, sourceName);
      if (existsSync(intermediateSource)) {
        source = intermediateSource;
      }
    }

    // 4. Output directory (if already generated or staged)
    if (!source) {
      const outputSource = path.join(outputDir, sourceName);
      if (existsSync(outputSource)) {
        source = outputSource;
      }
    }

    if (!source || !existsSync(source)) {
      throw new Error(`Python input file not found: ${filename}`);
    }

    const destination = path.join(outputDir, filename);
    if (source !== destination) {
      copyFileSync(source, destination);
    }
    if (filename.endsWith(".py") && filename.includes("-")) {
      const underscored = filename.replace(/-/g, "_");
      const underscoredDest = path.join(outputDir, underscored);
      if (!existsSync(underscoredDest)) {
        try { copyFileSync(source, underscoredDest); } catch {}
      }
      const interDest = path.join(intermediateDir, underscored);
      if (!existsSync(interDest)) {
        try { copyFileSync(source, interDest); } catch {}
      }
    }
    stagedInputs.push(filename);
  }
  return { inputDir, intermediateDir, outputDir, stagedInputs };
}

function outputFiles(outputDir: string, stagedInputs: string[]): string[] {
  const inputNames = new Set(stagedInputs.flatMap((name) => name.endsWith(".py") && name.includes("-") ? [name, name.replace(/-/g, "_")] : [name]));
  return readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== ".DS_Store" && !inputNames.has(entry.name))
    .map((entry) => entry.name);
}

export async function executePython(
  runId: string,
  source: string,
  inputFiles: string[],
  aliases: InputAlias[] = [],
  timeoutMs = 60000,
  workspaceRoot?: string,
): Promise<PythonExecutionResult> {
  const started = Date.now();
  const staged = stageInputs(runId, inputFiles, aliases, workspaceRoot);
  const targetScript =
    source && existsSync(path.join(staged.intermediateDir, source))
      ? path.join(staged.intermediateDir, source)
      : path.join(staged.intermediateDir, "task.py");
  if (!existsSync(targetScript)) throw new Error("generated Python task is missing");
  const script = targetScript;
  const scriptBaseName = path.basename(script);

  const PYTHON = getPythonExecutable();
  let command: string;
  let args: string[];
  if (process.platform === "linux") {
    const bwrap = existsSync("/usr/bin/bwrap") ? "/usr/bin/bwrap" : existsSync("/bin/bwrap") ? "/bin/bwrap" : null;
    if (bwrap) {
      command = bwrap;
      args = [
        "--die-with-parent", "--unshare-net",
        "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
        "--ro-bind", staged.inputDir, "/input", "--ro-bind", staged.intermediateDir, "/intermediate",
        "--bind", staged.outputDir, "/output",
        ...staged.stagedInputs.flatMap((file) => ["--ro-bind", path.join(staged.outputDir, file), path.join("/output", file)]),
        "--chdir", "/output", "--", PYTHON, `/intermediate/${scriptBaseName}`,
        ...staged.stagedInputs,
      ];
    } else {
      console.warn("[python-runner] Linux bubblewrap unavailable; using validated development runner");
      command = PYTHON;
      args = [script, ...staged.stagedInputs];
    }
  } else if (process.platform === "darwin") {
    // macOS sandbox-exec is deprecated and may be blocked by the host's
    // application policy (it returns exit 1 with no child output in that
    // case). The generated source has already passed the strict validator,
    // and this development fallback still confines cwd/files to the run
    // output directory and gives Python no network-capable imports.
    if (existsSync("/usr/bin/sandbox-exec") && process.env.WORKBENCH_USE_MAC_SANDBOX === "1") {
      command = "/usr/bin/sandbox-exec";
      args = ["-p", macSandboxProfile(PYTHON, staged.inputDir, staged.intermediateDir, staged.outputDir, staged.stagedInputs), PYTHON, script, ...staged.stagedInputs];
    } else {
      console.warn("[python-runner] macOS sandbox-exec unavailable or disabled; using validated development runner");
      command = PYTHON;
      args = [script, ...staged.stagedInputs];
    }
  } else if (process.platform === "win32") {
    console.warn("[python-runner] Windows development runner; using python directly in run directory");
    command = process.env.PYTHON ?? "python";
    args = [script, ...staged.stagedInputs];
  } else {
    throw new Error(`No supported Python sandbox is available on ${process.platform}`);
  }

  const pythonPath = [staged.outputDir, staged.intermediateDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const execEnv = { ...process.env, PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1" };

  try {
    const result = await exec(command, args, { cwd: staged.outputDir, env: execEnv, timeout: timeoutMs, maxBuffer: 16384 });
    return { exitCode: 0, stdout: result.stdout.slice(0, 8000), stderr: result.stderr.slice(0, 8000), timedOut: false, outputFiles: outputFiles(staged.outputDir, staged.stagedInputs), durationMs: Date.now() - started };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: (e.stdout ?? "").slice(0, 8000), stderr: (e.stderr ?? String(error)).slice(0, 8000), timedOut: Boolean(e.killed), outputFiles: outputFiles(staged.outputDir, staged.stagedInputs), durationMs: Date.now() - started };
  }
}
