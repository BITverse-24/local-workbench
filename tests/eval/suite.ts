import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelRegistryEntry } from "../../backend/src/shared/contracts.js";
import { cleanupSandboxes, registryHash, runTaskInWorker, type DriverContext } from "./core/drivers/worker.js";
import { evaluateOracles } from "./core/oracles.js";
import { hasTool } from "./core/sandbox.js";
import { summarize, summarizeByFamily, type RunRecordV2, type SuiteResultV2 } from "./core/metrics.js";
import type { TaskInstance } from "./core/task-spec.js";

export interface SuiteOptions {
  suite: string;
  instances: TaskInstance[];
  k: number;
  models: ModelRegistryEntry[];
  driver: Omit<DriverContext, "registry">;
  outputDir: string;
  outputFile?: string;
  features: Record<string, string>;
  quiet?: boolean;
}

export function loadRegistry(root: string): ModelRegistryEntry[] {
  return JSON.parse(readFileSync(path.join(root, "tests/eval/registry.local.json"), "utf8")) as ModelRegistryEntry[];
}

export async function runSuite(options: SuiteOptions): Promise<SuiteResultV2[]> {
  const perModel = new Map<string, RunRecordV2[]>();
  for (const m of options.models) perModel.set(m.id, []);
  const total = options.instances.length * options.k * options.models.length;
  let n = 0;
  for (const task of options.instances) {
    const missing = (task.requires ?? []).filter((tool) => !hasTool(tool));
    for (const model of options.models) {
      const ident = { id: model.id, registryHash: registryHash([model]) };
      for (let run = 1; run <= options.k; run++) {
        n++;
        const base = { schema: 2 as const, taskId: task.id, family: task.family, seed: task.seed, tier: task.tier, mode: task.mode, expectation: task.expectation, model: ident, runIndex: run };
        if (missing.length) {
          perModel.get(model.id)!.push({ ...base, pass: false, oracleResults: [], finalState: "skipped", stopReason: "skipped", falseCompletion: false, falseRefusal: false, wallMs: 0, modelCalls: 0, callsByRole: {}, recoveries: 0, approvals: 0, toolCalls: 0, filesRead: 0, skipped: `missing toolchain: ${missing.join(", ")}` });
          if (!options.quiet) console.log(`[${n}/${total}] ${task.id} SKIP (missing ${missing.join(", ")})`);
          continue;
        }
        const driven = await runTaskInWorker(task, { ...options.driver, registry: [model] });
        const oracleResults = await evaluateOracles(task, driven.observation);
        cleanupSandboxes();
        const pass = oracleResults.length > 0 && oracleResults.every((r) => r.pass);
        const state = driven.observation.finalState;
        const record: RunRecordV2 = {
          ...base,
          pass,
          oracleResults,
          finalState: state,
          stopReason: driven.stopReason,
          falseCompletion: state === "completed" && !pass,
          falseRefusal: task.expectation === "complete" && (state === "partial" || state === "limit_exceeded") && !pass,
          wallMs: driven.wallMs,
          modelCalls: driven.modelCalls,
          callsByRole: driven.callsByRole,
          recoveries: driven.recoveries,
          approvals: driven.approvals,
          toolCalls: driven.toolCalls,
          filesRead: driven.filesRead,
          error: driven.error,
        };
        perModel.get(model.id)!.push(record);
        if (!options.quiet) {
          const failed = oracleResults.filter((r) => !r.pass).map((r) => `${r.id}: ${r.detail.slice(0, 140)}`);
          console.log(`[${n}/${total}] ${task.id} (${model.id}) run ${run}/${options.k}: ${pass ? "PASS" : "FAIL"} state=${state} calls=${driven.modelCalls} ${Math.round(driven.wallMs / 1000)}s${failed.length ? `\n      ${failed.join("\n      ")}` : ""}${driven.error ? `\n      driver: ${driven.error.slice(0, 160)}` : ""}`);
        }
      }
    }
  }
  mkdirSync(options.outputDir, { recursive: true });
  const results: SuiteResultV2[] = [];
  for (const model of options.models) {
    const runs = perModel.get(model.id)!;
    const result: SuiteResultV2 = {
      schema: 2,
      suite: options.suite,
      timestamp: new Date().toISOString(),
      k: options.k,
      model: { id: model.id, registryHash: registryHash([model]) },
      features: options.features,
      stats: summarize(runs),
      families: summarizeByFamily(runs),
      runs,
    };
    const stamp = result.timestamp.replace(/[:.]/g, "-");
    const file = options.outputFile && options.models.length === 1 ? options.outputFile : path.join(options.outputDir, `${stamp}-${options.suite}-${model.id.replace(/[^\w.-]+/g, "_")}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(result, null, 2));
    if (!options.quiet) {
      const s = result.stats;
      console.log(`\n${model.id}: pass ${(s.passRate * 100).toFixed(1)}% (95% CI ${(s.ci95[0] * 100).toFixed(0)}–${(s.ci95[1] * 100).toFixed(0)}%), pass@k ${(s.passAtK * 100).toFixed(0)}%, pass^k ${(s.passPowK * 100).toFixed(0)}%, false-completion ${(s.falseCompletionRate * 100).toFixed(1)}%, median calls ${s.medianModelCalls}, median ${Math.round(s.medianWallMs / 1000)}s`);
      for (const [family, fs] of Object.entries(result.families)) console.log(`  ${family}: ${(fs.passRate * 100).toFixed(0)}% over ${fs.runs} runs`);
      console.log(`Saved ${file}`);
    }
    results.push(result);
  }
  return results;
}
