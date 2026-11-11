import type { OracleResult } from "./task-spec.js";

export interface RunRecordV2 {
  schema: 2;
  taskId: string;
  family: string;
  seed: number;
  tier: string;
  mode: string;
  expectation: string;
  model: { id: string; registryHash: string };
  runIndex: number;
  pass: boolean;
  oracleResults: OracleResult[];
  finalState: string;
  stopReason: string;
  /** Run reported completed but at least one oracle failed. */
  falseCompletion: boolean;
  /** Task was completable but the run stopped Partial/failed without doing the work. */
  falseRefusal: boolean;
  wallMs: number;
  modelCalls: number;
  callsByRole: Record<string, number>;
  recoveries: number;
  approvals: number;
  toolCalls: number;
  filesRead: number;
  error?: string;
  skipped?: string;
}

export interface SuiteResultV2 {
  schema: 2;
  suite: string;
  timestamp: string;
  k: number;
  model: { id: string; registryHash: string };
  features: Record<string, string>;
  stats: SuiteStats;
  families: Record<string, SuiteStats>;
  runs: RunRecordV2[];
}

export interface SuiteStats {
  tasks: number;
  runs: number;
  passRate: number;
  ci95: [number, number];
  passAtK: number;
  passPowK: number;
  falseCompletionRate: number;
  falseRefusalRate: number;
  medianWallMs: number;
  medianModelCalls: number;
  meanFilesRead: number;
}

/** Wilson score interval for a binomial proportion. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function summarize(runs: RunRecordV2[]): SuiteStats {
  const counted = runs.filter((r) => !r.skipped);
  const byTask = new Map<string, RunRecordV2[]>();
  for (const r of counted) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const passed = counted.filter((r) => r.pass).length;
  const tasks = [...byTask.values()];
  return {
    tasks: tasks.length,
    runs: counted.length,
    passRate: counted.length ? passed / counted.length : 0,
    ci95: wilson(passed, counted.length),
    passAtK: tasks.length ? tasks.filter((t) => t.some((r) => r.pass)).length / tasks.length : 0,
    passPowK: tasks.length ? tasks.filter((t) => t.every((r) => r.pass)).length / tasks.length : 0,
    falseCompletionRate: counted.length ? counted.filter((r) => r.falseCompletion).length / counted.length : 0,
    falseRefusalRate: counted.length ? counted.filter((r) => r.falseRefusal).length / counted.length : 0,
    medianWallMs: median(counted.map((r) => r.wallMs)),
    medianModelCalls: median(counted.map((r) => r.modelCalls)),
    meanFilesRead: counted.length ? counted.reduce((a, r) => a + r.filesRead, 0) / counted.length : 0,
  };
}

export function summarizeByFamily(runs: RunRecordV2[]): Record<string, SuiteStats> {
  const groups = new Map<string, RunRecordV2[]>();
  for (const r of runs) groups.set(r.family, [...(groups.get(r.family) ?? []), r]);
  return Object.fromEntries([...groups].map(([family, rs]) => [family, summarize(rs)]));
}

export interface Comparison {
  regressions: string[];
  improvements: string[];
  notes: string[];
  flips: Array<{ taskId: string; before: number; after: number }>;
}

/** Regression policy from the plan: CI-based pass-rate drop, false-completion rise, +25% median calls. */
export function compareSuites(before: SuiteResultV2, after: SuiteResultV2): Comparison {
  const out: Comparison = { regressions: [], improvements: [], notes: [], flips: [] };
  const b = before.stats;
  const a = after.stats;
  if (a.ci95[1] < b.passRate) out.regressions.push(`pass rate ${(b.passRate * 100).toFixed(1)}% → ${(a.passRate * 100).toFixed(1)}% (new 95% CI upper bound ${(a.ci95[1] * 100).toFixed(1)}% is below the baseline)`);
  else if (a.ci95[0] > b.passRate) out.improvements.push(`pass rate ${(b.passRate * 100).toFixed(1)}% → ${(a.passRate * 100).toFixed(1)}% (new 95% CI lower bound is above the baseline)`);
  else out.notes.push(`pass rate ${(b.passRate * 100).toFixed(1)}% → ${(a.passRate * 100).toFixed(1)}% (within noise)`);
  if (a.falseCompletionRate > b.falseCompletionRate + 0.02) out.regressions.push(`false-completion rate ${(b.falseCompletionRate * 100).toFixed(1)}% → ${(a.falseCompletionRate * 100).toFixed(1)}%`);
  if (b.medianModelCalls > 0 && a.medianModelCalls > b.medianModelCalls * 1.25) out.regressions.push(`median model calls ${b.medianModelCalls} → ${a.medianModelCalls} (>25% more)`);
  const rate = (res: SuiteResultV2) => {
    const m = new Map<string, { p: number; n: number }>();
    for (const r of res.runs) if (!r.skipped) m.set(r.taskId, { p: (m.get(r.taskId)?.p ?? 0) + (r.pass ? 1 : 0), n: (m.get(r.taskId)?.n ?? 0) + 1 });
    return m;
  };
  const rb = rate(before);
  const ra = rate(after);
  for (const [id, x] of ra) {
    const y = rb.get(id);
    if (y && Math.abs(x.p / x.n - y.p / y.n) >= 0.5) out.flips.push({ taskId: id, before: y.p / y.n, after: x.p / x.n });
  }
  return out;
}
