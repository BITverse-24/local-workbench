import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync, realpathSync, chmodSync, renameSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { executeProcess } from "./child-process.js";
import { assertRuntimeActive, currentRuntimeScope } from "../run/runtime-scope.js";
import { pythonProcessingSlots } from "../gateway/inference-scheduler.js";
import { resolveRunPath } from "../run/filesystem.js";
import { resolveSafe } from "../harness/path-guard.js";
import { getPythonExecutable, pythonLaunch, probePythonIsolation, directPythonEnvironment } from "./python-runtime.js";
import type { PythonExecutionResult } from "../../shared/contracts.js";

const exec = executeProcess;
type InputAlias = { logical: string; source: string };

function stageInputs(runId: string, inputFiles: string[], aliases: InputAlias[] = [], workspaceRoot?: string) {
  const inputDir = realpathSync(resolveRunPath(runId, "input", "input"));
  const intermediateDir = realpathSync(resolveRunPath(runId, "intermediate", "intermediate"));
  const publishedDir = realpathSync(resolveRunPath(runId, "output", "output"));
  // Each execution gets fresh input copies. Staging must never overwrite a
  // published artifact, including a repair with the original source filename.
  const executionDir = resolveRunPath(runId, `intermediate/python-executions/${randomUUID()}`, "intermediate");
  mkdirSync(executionDir, { recursive: true });
  const outputDir = realpathSync(executionDir);
  const stagedInputs: string[] = [];
  const originalInputs = new Map<string, string>();
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
    originalInputs.set(filename, source);
  }
  return { inputDir, intermediateDir, outputDir, publishedDir, stagedInputs, originalInputs };
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
  const script = realpathSync(targetScript);
  const PYTHON = getPythonExecutable();
  const launch = pythonLaunch(PYTHON, staged, script);
  const isolation = await probePythonIsolation(launch, PYTHON, staged.outputDir);
  const isolated = isolation.status === "os_isolated";
  let { command, args, env: execEnv } = launch;
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
    const code=readFileSync(resolveSafe(staged.intermediateDir,path.relative(staged.intermediateDir,script)),"utf8");
    const inputDigests=[...inputSnapshot(),...dependencyDigests()];
    const digest=digestSnapshot();approvedDigest=digest;
    if(!scope?.approveUncontainedPython || !await scope.approveUncontainedPython(code+'\n\n# Generated Python dependencies included in this approval:\n'+dependencyDigests().map(entry=>{const filename=entry.slice(0,entry.lastIndexOf(':'));return '# FILE '+filename+'\n'+readFileSync(resolveSafe(filename.startsWith('intermediate/')?staged.intermediateDir:staged.outputDir,filename.slice(filename.indexOf('/')+1)),'utf8');}).join('\n\n'),inputDigests,digest))throw new Error("Python without OS isolation was not approved.");
    assertRuntimeActive();
    // Verify the exact bytes again after approval. Input or source changes need a new request.
    if(digestSnapshot()!==digest)throw new Error('Python source or inputs changed after approval.');
    command=PYTHON;args=[script,...staged.stagedInputs];
    execEnv=directPythonEnvironment(PYTHON,staged);
  }
  scope?.observe?.({isolationStatus:isolated?"os_isolated":"approved_uncontained"});
  const release=await pythonProcessingSlots.acquire(scope?.mode??"work",scope?.signal,'python-processing');
  const digestInput = (root: string, filename: string): string | null => {
    try { return createHash('sha256').update(readFileSync(resolveSafe(root, filename))).digest('hex'); }
    catch { return null; }
  };
  // Capture the bytes actually passed to the child, after approval and queueing.
  const inputBefore = staged.stagedInputs.map(filename => ({filename, beforeSha256: digestInput(staged.outputDir, filename)}));
  const inputEvidence = () => inputBefore.map(entry => ({
    ...entry, originalFilename: path.basename(staged.originalInputs.get(entry.filename)!), afterSha256: digestInput(staged.outputDir, entry.filename),
    originalAfterSha256: digestInput(path.dirname(staged.originalInputs.get(entry.filename)!), path.basename(staged.originalInputs.get(entry.filename)!)),
  }));

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
    return { exitCode: 0, stdout: result.stdout.slice(0, 8000), stderr: result.stderr.slice(0, 8000), capturedOutput: { stdout: result.stdout, stderr: result.stderr, truncated: false }, timedOut: false, inputEvidence: inputEvidence(), outputFiles: publishOutputs(), durationMs: Date.now() - started };
  } catch (error) {
    assertRuntimeActive();
    if((error as any)?.code==="permission_denied")throw error;
    const e = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: (e.stdout ?? "").slice(0, 8000), stderr: (e.stderr ?? String(error)).slice(0, 8000), capturedOutput: { stdout: e.stdout ?? "", stderr: e.stderr ?? String(error), truncated: e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, timedOut: Boolean(e.killed), inputEvidence: inputEvidence(), outputFiles: publishOutputs(), durationMs: Date.now() - started };
  } finally { release(); }
}
