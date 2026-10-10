import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync, realpathSync, chmodSync, renameSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { executeProcess } from "./child-process.js";
import { assertRuntimeActive, currentRuntimeScope } from "../run/runtime-scope.js";
import { pythonProcessingSlots } from "../gateway/inference-scheduler.js";
import { resolveRunPath } from "../run/filesystem.js";
import { resolveSafe } from "../harness/path-guard.js";
import type { PythonExecutionResult } from "../../shared/contracts.js";

const exec = executeProcess;
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
  for (const directory of (process.env.PATH??"").split(path.delimiter)) for (const executable of process.platform==="win32"?["python.exe","python3.exe"]:["python3","python"]) {
    const candidate=path.join(directory,executable);if(existsSync(candidate))return candidate;
  }
  throw new Error("Python executable is unavailable.");
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
    `(allow file-read* (subpath ${profileLiteral("/usr/lib")}))`,
    `(allow file-read* (subpath ${profileLiteral("/usr/share")}))`,
    `(allow file-read* (subpath ${profileLiteral(path.resolve(path.dirname(pythonBin),".."))}))`,
    `(allow file-read* (subpath ${profileLiteral("/opt/homebrew/lib")}))`,
    `(allow file-read* (subpath ${profileLiteral("/opt/homebrew/opt")}))`,
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
  const publishedDir = resolveRunPath(runId, "output", "output");
  // Each execution gets fresh input copies. Staging must never overwrite a
  // published artifact, including a repair with the original source filename.
  const outputDir = resolveRunPath(runId, `intermediate/python-executions/${randomUUID()}`, "intermediate");
  mkdirSync(outputDir, { recursive: true });
  const stagedInputs: string[] = [];
  for (const inputFile of inputFiles) {
    const rawTrimmed = (inputFile ?? "").trim();
    if (!rawTrimmed) continue;
    if (path.isAbsolute(rawTrimmed) || rawTrimmed.split(/[\\/]/).includes("..")) throw new Error("Python input must be a contained relative path.");
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
      const outputSource = path.join(publishedDir, sourceName);
      if (existsSync(outputSource)) {
        source = outputSource;
      }
    }

    if (!source || !existsSync(source)) {
      throw new Error(`Python input file not found: ${filename}`);
    }

    source = resolveSafe(source.startsWith(inputDir + path.sep) ? inputDir : source.startsWith(intermediateDir + path.sep) ? intermediateDir : source.startsWith(publishedDir + path.sep) ? publishedDir : workspaceRoot!, path.relative(source.startsWith(inputDir + path.sep) ? inputDir : source.startsWith(intermediateDir + path.sep) ? intermediateDir : source.startsWith(publishedDir + path.sep) ? publishedDir : workspaceRoot!, source));
    const destination = resolveSafe(outputDir, filename);
    if (source !== destination) {
      if(existsSync(destination)) {
        if(!readFileSync(source).equals(readFileSync(destination))){chmodSync(destination,0o600);copyFileSync(source,destination);}
      }else copyFileSync(source,destination);
    }
    chmodSync(destination, 0o444);
    if (filename.endsWith(".py") && filename.includes("-")) {
      const underscored = filename.replace(/-/g, "_");
      const underscoredDest = path.join(outputDir, underscored);
      if (!existsSync(underscoredDest)) {
        copyFileSync(source, underscoredDest);
        chmodSync(underscoredDest, 0o444);
      }
    }
    stagedInputs.push(filename);
  }
  return { inputDir, intermediateDir, outputDir, publishedDir, stagedInputs };
}

function outputSnapshot(outputDir: string): Map<string, string> {
  return new Map(readdirSync(outputDir, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const stat = statSync(path.join(outputDir, entry.name), { bigint: true });
    return [entry.name, `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`];
  }));
}

function outputFiles(outputDir: string, stagedInputs: string[], before: Map<string, string>): string[] {
  const inputNames = new Set(stagedInputs.flatMap((name) => name.endsWith(".py") && name.includes("-") ? [name, name.replace(/-/g, "_")] : [name]));
  return [...outputSnapshot(outputDir)].filter(([name, signature]) => name !== ".DS_Store" && !inputNames.has(name) && before.get(name) !== signature).map(([name]) => name);
}

export async function executePython(
  runId: string,
  source: string,
  inputFiles: string[],
  aliases: InputAlias[] = [],
  timeoutMs = 60000,
  workspaceRoot?: string,
): Promise<PythonExecutionResult> {
  assertRuntimeActive();
  const scope=currentRuntimeScope();
  if(scope?.mode==="chat")throw new Error("Chat cannot execute Python.");
  if(scope?.mode==="work")workspaceRoot=undefined;
  const started = Date.now();
  const staged = stageInputs(runId, inputFiles, aliases, workspaceRoot);
  const before = outputSnapshot(staged.outputDir);
  const targetScript =
    source && existsSync(resolveSafe(staged.intermediateDir, source))
      ? resolveSafe(staged.intermediateDir, source)
      : path.join(staged.intermediateDir, "task.py");
  if (!existsSync(targetScript)) throw new Error("generated Python task is missing");
  const script = targetScript;
  const scriptBaseName = path.basename(script);

  const PYTHON = realpathSync(getPythonExecutable());
  let command: string;
  let args: string[];
  if (process.platform === "linux") {
    const bwrap = existsSync("/usr/bin/bwrap") ? "/usr/bin/bwrap" : existsSync("/bin/bwrap") ? "/bin/bwrap" : null;
    if (bwrap) {
      command = bwrap;
      args = [
        ...["/lib","/lib64"].filter(existsSync).flatMap(directory=>["--ro-bind",directory,directory]),
        "--die-with-parent", "--unshare-net",
        "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
        "--ro-bind", staged.inputDir, "/input", "--ro-bind", staged.intermediateDir, "/intermediate",
        "--bind", staged.outputDir, "/output",
        ...staged.stagedInputs.flatMap((file) => ["--ro-bind", path.join(staged.outputDir, file), path.join("/output", file)]),
        "--chdir", "/output", "--", PYTHON, `/intermediate/${scriptBaseName}`,
        ...staged.stagedInputs,
      ];
    } else {
      console.warn("[python-runner] Linux bubblewrap unavailable; approval required before direct execution");
      command = PYTHON;
      args = [script, ...staged.stagedInputs];
    }
  } else if (process.platform === "darwin") {
    // Probe OS isolation before use. A failed probe requires explicit fallback approval.
    if (existsSync("/usr/bin/sandbox-exec") && process.env.WORKBENCH_USE_MAC_SANDBOX !== "0") {
      command = "/usr/bin/sandbox-exec";
      args = ["-p", macSandboxProfile(PYTHON, staged.inputDir, staged.intermediateDir, staged.outputDir, staged.stagedInputs), PYTHON, script, ...staged.stagedInputs];
    } else {
      console.warn("[python-runner] macOS sandbox-exec unavailable or disabled; approval required before direct execution");
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

  const execEnv:NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", PYTHONPATH: [staged.intermediateDir,staged.outputDir].join(path.delimiter), PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", LANG: "en_US.UTF-8", TMPDIR: staged.outputDir };
  if(command.endsWith("bwrap")){execEnv.PYTHONPATH="/intermediate:/output";execEnv.TMPDIR="/output";}
  if(process.platform==="win32"){execEnv.SystemRoot=process.env.SystemRoot;execEnv.WINDIR=process.env.WINDIR;execEnv.PATH=path.dirname(PYTHON);}
  let isolated=command!==PYTHON && command!=="python";
  if(isolated){
    try {
      const probeArgs=process.platform==="darwin"?["-p",args[1],PYTHON,"-c","pass"]:[...args.slice(0,args.indexOf("--")+1),PYTHON,"-c","pass"];
      await exec(command,probeArgs,{cwd:staged.outputDir,env:execEnv,timeout:5000,maxBuffer:4096});
    }catch(error){assertRuntimeActive();isolated=false;}
  }
  const dependencyDigests=()=>{
    const files:string[]=[];let sourceBytes=0;
    const visit=(root:string,relative="")=>{for(const entry of readdirSync(path.join(root,relative),{withFileTypes:true})) {
      const filename=path.join(relative,entry.name);
      if(entry.isDirectory() && !filename.includes("results"))visit(root,filename);
      else if(entry.name.endsWith(".py")){const source=resolveSafe(root,filename);sourceBytes+=statSync(source).size;if(sourceBytes>4*1024*1024)throw new Error('Python dependency snapshot exceeds 4 MiB.');files.push(`${root===staged.intermediateDir?'intermediate':'output'}/${filename}:${createHash('sha256').update(readFileSync(source)).digest('hex')}`);}
      if(files.length>256)throw new Error("Python dependency snapshot exceeds its limit.");
    }};
    visit(staged.intermediateDir);visit(staged.outputDir);
    return files.sort();
  };
  const inputSnapshot=()=>staged.stagedInputs.map(name=>`${name}:${createHash('sha256').update(readFileSync(resolveSafe(staged.outputDir,name))).digest('hex')}`);
  const digestSnapshot=()=>createHash('sha256').update(readFileSync(script)).update(JSON.stringify(inputSnapshot())).update(JSON.stringify(dependencyDigests())).digest('hex');
  let approvedDigest:string|undefined;
  if(!isolated){
    const code=readFileSync(resolveSafe(staged.intermediateDir,path.basename(script)),"utf8");
    const inputDigests=[...inputSnapshot(),...dependencyDigests()];
    const digest=digestSnapshot();approvedDigest=digest;
    if(!scope?.approveUncontainedPython || !await scope.approveUncontainedPython(code+'\n\n# Generated Python dependencies included in this approval:\n'+dependencyDigests().map(entry=>{const filename=entry.slice(0,entry.lastIndexOf(':'));return '# FILE '+filename+'\n'+readFileSync(resolveSafe(filename.startsWith('intermediate/')?staged.intermediateDir:staged.outputDir,filename.slice(filename.indexOf('/')+1)),'utf8');}).join('\n\n'),inputDigests,digest))throw new Error("Python without OS isolation was not approved.");
    assertRuntimeActive();
    // Verify the exact bytes again after approval. Input or source changes need a new request.
    if(digestSnapshot()!==digest)throw new Error('Python source or inputs changed after approval.');
    command=PYTHON;args=[script,...staged.stagedInputs];
  }
  scope?.observe?.({isolationStatus:isolated?"os_isolated":"approved_uncontained"});
  const release=await pythonProcessingSlots.acquire(scope?.mode??"work",scope?.signal,'python-processing');

  const publishOutputs = () => {
    assertRuntimeActive();
    const files = outputFiles(staged.outputDir, staged.stagedInputs, before);
    for (const filename of files) {
      const source = resolveSafe(staged.outputDir, filename);
      const destination = resolveSafe(staged.publishedDir, filename);
      const temporary = resolveSafe(staged.publishedDir, `.python-${randomUUID()}`);
      copyFileSync(source, temporary);
      chmodSync(temporary, 0o600);
      renameSync(temporary, destination);
    }
    return files;
  };

  try {
    if(approvedDigest && digestSnapshot()!==approvedDigest)throw {code:"permission_denied",retryable:false,message:"Python source or inputs changed while waiting for execution."};
    const result = await exec(command, args, { cwd: staged.outputDir, env: execEnv, timeout: timeoutMs, maxBuffer: 16384 });
    return { exitCode: 0, stdout: result.stdout.slice(0, 8000), stderr: result.stderr.slice(0, 8000), capturedOutput: { stdout: result.stdout, stderr: result.stderr, truncated: false }, timedOut: false, outputFiles: publishOutputs(), durationMs: Date.now() - started };
  } catch (error) {
    assertRuntimeActive();
    if((error as any)?.code==="permission_denied")throw error;
    const e = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: (e.stdout ?? "").slice(0, 8000), stderr: (e.stderr ?? String(error)).slice(0, 8000), capturedOutput: { stdout: e.stdout ?? "", stderr: e.stderr ?? String(error), truncated: e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, timedOut: Boolean(e.killed), outputFiles: publishOutputs(), durationMs: Date.now() - started };
  } finally { release(); }
}
