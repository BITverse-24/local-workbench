import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256, snapshot } from "../helpers/files.js";
import { loadCorpus } from "../scenarios/corpus.js";
import { runScenario, type RunOptions } from "../runner.js";
import type { ExecutionRecord } from "../recorder.js";
import { appendFindings } from "../findings.js";

export interface BenchmarkReport {
  complete?: boolean; expectedExecutions?: number; interrupted?: boolean;
  version: 1; corpusVersion: string; corpusHash: string; targetHash: string; evaluatorVersion: string; mode: string; modelIdentityHash: string; judgeHash: string; applicationCommits: string[]; modelIdentityComplete: boolean;
  strata: Record<string, { executions: number; pass: number; fail: number; inconclusive: number; policyViolations: number; meanLatencyMs: number; meanToolCalls: number; passRate?: number; failRate?: number; passRateInterval95?: [number, number] }>;
  records: Array<{ scenarioId: string; executionId: string; verdict: string; evidence: string }>;
}
export function summarize(records: ExecutionRecord[], corpusVersion: string, corpusHash: string): BenchmarkReport {
  if (!records.length) throw new Error("Cannot summarize an empty benchmark");
  const strata: BenchmarkReport["strata"] = {};
  for (const r of records) {
    const key = `${r.scenario.family}/${r.scenario.complexity}`;
    const s = strata[key] ??= { executions: 0, pass: 0, fail: 0, inconclusive: 0, policyViolations: 0, meanLatencyMs: 0, meanToolCalls: 0 };
    const old = s.executions++;
    s[r.verdict]++; s.policyViolations += r.results.filter((c) => c.category === "policy" && c.verdict === "fail").length;
    s.meanLatencyMs = (s.meanLatencyMs * old + r.durationMs) / s.executions;
    s.meanToolCalls = (s.meanToolCalls * old + r.events.filter((e) => e.event.type === "tool_call").length) / s.executions;
  }
  for (const s of Object.values(strata)) {
    s.passRate = s.pass / s.executions; s.failRate = s.fail / s.executions;
    const z = 1.959963984540054, n = s.executions, p = s.passRate, scale = 1 + z * z / n;
    const center = (p + z * z / (2 * n)) / scale;
    const radius = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / scale;
    s.passRateInterval95 = [Math.max(0, center - radius), Math.min(1, center + radius)];
  }
  return { version: 1, corpusVersion, corpusHash, targetHash: sha256(JSON.stringify(records[0].profile.target)), evaluatorVersion: "v1", modelIdentityHash: sha256(JSON.stringify(records[0].modelMetadata.versions ?? "unavailable")), modelIdentityComplete: records.every((r) => r.targetMode !== "real" || r.modelMetadata.versionIdentityComplete === true), judgeHash: sha256(JSON.stringify({ judge: records[0].profile.judge, fallback: records[0].profile.judgeFallback })), applicationCommits: [...new Set(records.map((r) => r.commit))], mode: records[0].targetMode, strata, records: records.map((r) => ({ scenarioId: r.scenario.id, executionId: r.executionId, verdict: r.verdict, evidence: r.evidenceDir })) };
}
export function compareBenchmarks(before: BenchmarkReport, after: BenchmarkReport): { compatible: boolean; changes: unknown } {
  const compatible = before.version === 1 && after.version === 1 && before.complete !== false && after.complete !== false && before.modelIdentityComplete === true && after.modelIdentityComplete === true && ["corpusVersion", "corpusHash", "targetHash", "modelIdentityHash", "judgeHash", "evaluatorVersion", "mode"].every((key) => typeof before[key as keyof BenchmarkReport] === "string" && before[key as keyof BenchmarkReport] === after[key as keyof BenchmarkReport]);
  if (!compatible) return { compatible: false, changes: "Incompatible corpus, target, execution mode or evaluator" };
  return { compatible: true, changes: Object.fromEntries(Object.entries(after.strata).map(([key, current]) => [key, { before: before.strata[key], after: current }])) };
}
export async function runBenchmark(options: RunOptions, repetitions = 3, scenarioIds?: string[]): Promise<BenchmarkReport> {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new Error("Invalid benchmark repetition count");
  const corpus = loadCorpus(options.runtimeRoot);
  const evaluatorVersion = sha256(JSON.stringify(snapshot(path.join(options.runtimeRoot, "tests/evaluator"))));
  const selected = scenarioIds ? corpus.scenarios.filter((s) => scenarioIds.includes(s.id)) : corpus.scenarios;
  if (!selected.length || (scenarioIds && selected.length !== new Set(scenarioIds).size)) throw new Error("Unknown benchmark scenario IDs");
  const records: ExecutionRecord[] = [];
  const directory = path.join(options.runtimeRoot, "tests/.runtime/benchmarks"); mkdirSync(directory, { recursive: true });
  const checkpoint = (): BenchmarkReport => {
    const report = summarize(records, corpus.version, sha256(JSON.stringify(selected)));
    report.evaluatorVersion = evaluatorVersion;
    report.judgeHash = sha256(JSON.stringify({ enabled: !!options.judge, primary: options.profile.judge, fallback: options.profile.judgeFallback, active: options.judge?.active }));
    report.expectedExecutions = selected.length * repetitions;
    report.interrupted = options.signal?.aborted || false;
    report.complete = records.length === report.expectedExecutions && !report.interrupted;
    writeFileSync(path.join(directory, `${options.campaignId}.json`), JSON.stringify(report, null, 2));
    return report;
  };
  for (const scenario of selected) {
    if (options.signal?.aborted) break;
    const attempts: ExecutionRecord[] = [];
    for (let n = 0; n < repetitions; n++) {
      if (options.signal?.aborted) break;
      const r = await runScenario(scenario, options); records.push(r); attempts.push(r);
      checkpoint();
      console.log(JSON.stringify({ benchmark: corpus.version, scenario: scenario.id, attempt: n + 1, verdict: r.verdict, evidence: r.evidenceDir }));
    }
    if (options.mode === "real") {
      appendFindings(options.runtimeRoot, attempts);
    }
  }
  return checkpoint();
}
