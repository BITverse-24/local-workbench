import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { initDb, closeDb, getDb } from "../../backend/src/main/persistence/db.js";
import { setDataDir } from "../../backend/src/main/run/filesystem.js";
import { ModelGateway } from "../../backend/src/main/gateway/model-gateway.js";
import { RunManager } from "../../backend/src/main/run/manager.js";
import { HarnessManager } from "../../backend/src/main/harness/harness-manager.js";
import { getState } from "../../backend/src/main/run/store.js";
import { getExecutionLedger } from "../../backend/src/main/run/execution-ledger.js";
import type { ModelRegistryEntry, RunEvent } from "../../backend/src/shared/contracts.js";

const ROOT = process.cwd();
const BASES_DIR = path.join(ROOT, "tests/eval/bases");
const TASKS_DIR = path.join(ROOT, "tests/eval/tasks");
const REGISTRY_PATH = path.join(ROOT, "tests/eval/registry.local.json");

interface TaskSpec {
  id: string;
  base: string;
  mutation: string;
  prompt: string;
  expectChangedFiles: string[];
  preserveExports: boolean;
  oracle: {
    command: string;
    mustPass: boolean;
  };
}

interface MutationManifestItem extends TaskSpec {
  file: string;
  original: string;
  mutated: string;
}

interface RunResultRecord {
  taskId: string;
  runIndex: number;
  pass: boolean;
  stopReason: string;
  wallMs: number;
  callsByRole: Record<string, number>;
  finishReasons: Record<string, number>;
  approvalsRequested: number;
  changedFiles: string[];
  oracleOutput: string;
  error?: string;
}

function copyDirRecursive(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (entry === "node_modules" || entry === ".git" || entry === "__pycache__" || entry.endsWith(".pyc")) continue;
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function fileManifest(dir: string, base = dir): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "__pycache__" || entry.endsWith(".pyc")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      for (const [k, v] of fileManifest(full, base)) map.set(k, v);
    } else {
      const rel = path.relative(base, full).replace(/\\/g, "/");
      const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
      map.set(rel, hash);
    }
  }
  return map;
}

async function runTaskAttempt(
  task: TaskSpec,
  mutationInfo: MutationManifestItem,
  runIndex: number,
  modelId: string,
  registry: ModelRegistryEntry[]
): Promise<RunResultRecord> {
  const startMs = Date.now();
  const workRoot = mkdtempSync(path.join(tmpdir(), `eval-work-${task.id}-${runIndex}-`));
  const dataDir = mkdtempSync(path.join(tmpdir(), `eval-data-${task.id}-${runIndex}-`));

  let pass = false;
  let stopReason = "unknown";
  let oracleOutput = "";
  const callsByRole: Record<string, number> = {};
  const finishReasons: Record<string, number> = {};
  let approvalsRequested = 0;
  const changedFiles: string[] = [];
  let executionError: string | undefined;

  try {
    // 1. Copy base repo to workRoot
    const baseDir = path.join(BASES_DIR, task.base);
    copyDirRecursive(baseDir, workRoot);

    // 2. Apply mutation
    const targetFile = path.join(workRoot, mutationInfo.file);
    const originalContent = readFileSync(targetFile, "utf8");
    if (!originalContent.includes(mutationInfo.original)) {
      throw new Error(`Original snippet for ${task.id} not found in ${mutationInfo.file}`);
    }
    const mutatedContent = originalContent.replace(mutationInfo.original, mutationInfo.mutated);
    writeFileSync(targetFile, mutatedContent, "utf8");

    // Capture baseline file manifest after mutation
    const beforeManifest = fileManifest(workRoot);

    // 3. Initialize fresh DB & data directory
    setDataDir(dataDir);
    initDb(path.join(dataDir, "db.sqlite"));

    // 4. Set up gateway & runtime
    const gateway = new ModelGateway(undefined, registry);
    let activeRunId = "";

    const emit = (event: RunEvent) => {
      if (event.type === "tool_call") {
        console.log(`      -> tool_call: ${(event as any).tool} (${(event as any).summary || ""})`);
      }
      if (event.type === "confirmation_required") {
        approvalsRequested++;
        const action = (event as any).action;
        if (action && activeRunId) {
          setTimeout(() => {
            manager.confirm({ runId: activeRunId, actionId: action.actionId, approved: true }).catch(() => {});
          }, 10);
        }
      }
    };

    const manager = new RunManager(gateway, emit, undefined, { agentV3Preview: true });
    const harness = new HarnessManager((e) => {
      manager.workspaceChanged();
    }, emit);

    harness.registerWorkspace(workRoot);
    manager.setHarness(harness);

    // 5. Start the Agent run
    const startResult = await manager.start({
      mode: "agent",
      userText: task.prompt,
      agentTaskIntent: "continue",
      workspaceIdentity: harness.requireActiveWorkspace(),
      selectedModel: modelId
    });
    activeRunId = startResult.runId;

    // 6. Poll for run completion (timeout: 300s)
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const state = getState(activeRunId);
      if (["completed", "partial", "failed", "cancelled", "limit_exceeded"].includes(state)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!["completed", "partial", "failed", "cancelled", "limit_exceeded"].includes(getState(activeRunId))) {
      try {
        manager.cancel(activeRunId);
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 7. Extract ledger metrics
    const ledger = getExecutionLedger(activeRunId);
    stopReason = ledger?.termination?.stopReason || getState(activeRunId) || "timeout";
    if (ledger?.agentTask?.callsByRole) {
      Object.assign(callsByRole, ledger.agentTask.callsByRole);
    }

    // 8. Oracle verification
    const afterManifest = fileManifest(workRoot);
    for (const [file, hash] of afterManifest) {
      if (beforeManifest.get(file) !== hash) {
        changedFiles.push(file);
      }
    }
    for (const [file] of beforeManifest) {
      if (!afterManifest.has(file)) {
        changedFiles.push(file);
      }
    }

    let oraclePassed = false;
    try {
      const out = execSync(task.oracle.command, { cwd: workRoot, stdio: "pipe" });
      oraclePassed = true;
      oracleOutput = out.toString();
    } catch (err: any) {
      oraclePassed = false;
      oracleOutput = (err.stdout?.toString() || "") + "\n" + (err.stderr?.toString() || "");
    }

    // Check scope: only expectChangedFiles changed
    const outOfScopeFiles = changedFiles.filter((f) => !task.expectChangedFiles.includes(f));
    const scopePassed = outOfScopeFiles.length === 0;

    pass = oraclePassed && scopePassed && changedFiles.length > 0;
  } catch (err: any) {
    executionError = String(err?.message || err);
  } finally {
    try {
      closeDb();
    } catch {}
    try {
      rmSync(workRoot, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }

  const wallMs = Date.now() - startMs;
  return {
    taskId: task.id,
    runIndex,
    pass,
    stopReason,
    wallMs,
    callsByRole,
    finishReasons,
    approvalsRequested,
    changedFiles,
    oracleOutput: oracleOutput.slice(0, 1000),
    error: executionError
  };
}

export async function runEvalSuite(options: {
  tier: "smoke" | "full";
  k: number;
  modelId: string;
  outputFile?: string;
}) {
  const { tier, k, modelId } = options;
  console.log(`\n=======================================================`);
  console.log(`AGENT EVAL SUITE — Tier: ${tier.toUpperCase()} (k=${k}, model: ${modelId})`);
  console.log(`=======================================================`);

  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(`Registry file not found at ${REGISTRY_PATH}`);
  }
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as ModelRegistryEntry[];

  const manifestPath = path.join(TASKS_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found at ${manifestPath}. Run npm run eval:generate first.`);
  }
  const allMutations = JSON.parse(readFileSync(manifestPath, "utf8")) as MutationManifestItem[];

  let selectedMutations: MutationManifestItem[] = [];
  if (tier === "smoke") {
    // 8 tasks: 1 from each base repo
    const seenBases = new Set<string>();
    for (const m of allMutations) {
      if (!seenBases.has(m.base)) {
        seenBases.add(m.base);
        selectedMutations.push(m);
      }
    }
  } else {
    selectedMutations = allMutations;
  }

  console.log(`Selected ${selectedMutations.length} tasks across ${new Set(selectedMutations.map((m) => m.base)).size} repos.\n`);

  const taskResults: Array<{ id: string; base: string; runs: RunResultRecord[] }> = [];
  let totalRuns = 0;
  let passedRuns = 0;

  for (let idx = 0; idx < selectedMutations.length; idx++) {
    const mut = selectedMutations[idx];
    const taskSpec: TaskSpec = {
      id: mut.id,
      base: mut.base,
      mutation: mut.mutation,
      prompt: mut.prompt,
      expectChangedFiles: mut.expectChangedFiles,
      preserveExports: mut.preserveExports,
      oracle: mut.oracle
    };

    console.log(`[${idx + 1}/${selectedMutations.length}] Running task ${mut.id} (${mut.base})...`);
    const runs: RunResultRecord[] = [];

    for (let runIdx = 1; runIdx <= k; runIdx++) {
      const res = await runTaskAttempt(taskSpec, mut, runIdx, modelId, registry);
      runs.push(res);
      totalRuns++;
      if (res.pass) passedRuns++;
      console.log(
        `   Attempt ${runIdx}/${k}: ${res.pass ? "PASS" : "FAIL"} (${res.stopReason}, ${res.wallMs}ms, approvals: ${res.approvalsRequested})`
      );
      if (Object.keys(res.callsByRole).length) {
        console.log(`      callsByRole: ${JSON.stringify(res.callsByRole)}`);
      }
    }
    taskResults.push({ id: mut.id, base: mut.base, runs });
  }

  const passRate = totalRuns ? (passedRuns / totalRuns) * 100 : 0;
  console.log("\n=======================================================");
  console.log("EVALUATION RESULTS");
  console.log("=======================================================");
  console.log(`Total Tasks:  ${selectedMutations.length}`);
  console.log(`Total Runs:   ${totalRuns}`);
  console.log(`Passed Runs:  ${passedRuns} / ${totalRuns} (${passRate.toFixed(1)}%)`);

  const summary = {
    version: 1,
    timestamp: new Date().toISOString(),
    tier,
    k,
    model: modelId,
    stats: {
      totalTasks: selectedMutations.length,
      totalRuns,
      passedRuns,
      passRate: Number(passRate.toFixed(1))
    },
    tasks: taskResults
  };

  const outPath = options.outputFile || path.join(ROOT, "docs/eval", `baseline-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`Results saved to: ${outPath}`);
  console.log("=======================================================\n");

  return summary;
}
