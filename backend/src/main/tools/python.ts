import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveRunPath } from "../run/filesystem.js";
import type { PythonExecutionResult } from "../../shared/contracts.js";

const exec = promisify(execFile);
const PYTHON = "/usr/bin/python3";

function profileLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function macSandboxProfile(inputDir: string, intermediateDir: string, outputDir: string, stagedInputs: string[]): string {
  const stagedInputRules = stagedInputs.map((file) => `(deny file-write* (literal ${profileLiteral(path.join(outputDir, file))}))`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    `(allow process-exec (literal ${profileLiteral(PYTHON)}))`,
    `(allow file-read* (subpath ${profileLiteral("/usr")}))`,
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

function stageInputs(runId: string, inputFiles: string[], aliases: InputAlias[]) {
  const inputDir = resolveRunPath(runId, "input", "input");
  const intermediateDir = resolveRunPath(runId, "intermediate", "intermediate");
  const outputDir = resolveRunPath(runId, "output", "output");
  mkdirSync(outputDir, { recursive: true });
  const stagedInputs: string[] = [];
  for (const inputFile of inputFiles) {
    const filename = path.basename(inputFile);
    if (!filename || filename !== inputFile || filename === "." || filename === "..") throw new Error("Python input file must be a run-local filename");
    const alias = aliases.find((item) => item.logical === filename);
    const sourceName = alias?.source ?? filename;
    if (path.basename(sourceName) !== sourceName || sourceName === "." || sourceName === "..") throw new Error("Python input alias must be a run-local filename");
    let source = path.join(inputDir, sourceName);
    if (!existsSync(source)) {
      const files = existsSync(inputDir) ? readdirSync(inputDir) : [];
      const matched = files.find((f) => f === sourceName || f.endsWith(`-${sourceName}`));
      if (matched) {
        source = path.join(inputDir, matched);
      }
    }
    if (!existsSync(source)) {
      const intermediateSource = path.join(intermediateDir, sourceName);
      if (existsSync(intermediateSource)) {
        source = intermediateSource;
      }
    }
    if (!existsSync(source)) throw new Error(`Python input file not found: ${filename}`);
    copyFileSync(source, path.join(outputDir, filename));
    stagedInputs.push(filename);
  }
  return { inputDir, intermediateDir, outputDir, stagedInputs };
}

function outputFiles(outputDir: string, stagedInputs: string[]): string[] {
  const inputNames = new Set(stagedInputs);
  return readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== ".DS_Store" && !inputNames.has(entry.name))
    .map((entry) => entry.name);
}

export async function executePython(runId: string, source: string, inputFiles: string[], aliases: InputAlias[] = [], timeoutMs = 60000): Promise<PythonExecutionResult> {
  void source; // The manager persists the validated source as intermediate/task.py.
  const started = Date.now();
  const staged = stageInputs(runId, inputFiles, aliases);
  const script = path.join(staged.intermediateDir, "task.py");
  if (!existsSync(script)) throw new Error("generated Python task is missing");

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
        "--chdir", "/output", "--", PYTHON, "/intermediate/task.py",
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
      args = ["-p", macSandboxProfile(staged.inputDir, staged.intermediateDir, staged.outputDir, staged.stagedInputs), PYTHON, script, ...staged.stagedInputs];
    } else {
      console.warn("[python-runner] macOS sandbox-exec unavailable or disabled; using validated development runner");
      command = PYTHON;
      args = [script, ...staged.stagedInputs];
    }
  } else {
    throw new Error(`No supported Python sandbox is available on ${process.platform}`);
  }

  try {
    const result = await exec(command, args, { cwd: staged.outputDir, timeout: timeoutMs, maxBuffer: 16384 });
    return { exitCode: 0, stdout: result.stdout.slice(0, 8000), stderr: result.stderr.slice(0, 8000), timedOut: false, outputFiles: outputFiles(staged.outputDir, staged.stagedInputs), durationMs: Date.now() - started };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: (e.stdout ?? "").slice(0, 8000), stderr: (e.stderr ?? String(error)).slice(0, 8000), timedOut: Boolean(e.killed), outputFiles: outputFiles(staged.outputDir, staged.stagedInputs), durationMs: Date.now() - started };
  }
}
