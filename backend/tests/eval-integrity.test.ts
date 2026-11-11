import { describe, expect, it } from "vitest";
import { FAMILIES } from "../../tests/eval/families/index.js";
import { selfCheck } from "../../tests/eval/core/selfcheck.js";
import { Rng } from "../../tests/eval/core/prng.js";
import { compareSuites, summarize, wilson, type RunRecordV2, type SuiteResultV2 } from "../../tests/eval/core/metrics.js";

const perFamily = process.env.EVAL_INTEGRITY_SEEDS === "all" ? Infinity : Number(process.env.EVAL_INTEGRITY_SEEDS ?? 8);

describe("eval integrity: every generated task is valid, solvable and deterministic", () => {
  for (const family of FAMILIES) {
    describe(family.id, () => {
      const seeds = family.devSeeds.slice(0, perFamily);
      for (const seed of seeds) {
        it(`seed ${seed}: fails untouched, passes with the reference, deterministic, no leaks`, async () => {
          const result = await selfCheck(family, seed);
          expect(result.problems, JSON.stringify(result, null, 2)).toEqual([]);
          expect(result.ok).toBe(true);
        }, 120000);
      }
    });
  }
});

describe("eval core utilities", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = new Rng(7);
    const b = new Rng(7);
    expect([a.next(), a.int(1, 100), a.float(0, 1, 3)]).toEqual([b.next(), b.int(1, 100), b.float(0, 1, 3)]);
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it("computes Wilson intervals", () => {
    const [lo, hi] = wilson(5, 10);
    expect(lo).toBeCloseTo(0.237, 2);
    expect(hi).toBeCloseTo(0.763, 2);
    expect(wilson(0, 0)).toEqual([0, 0]);
  });

  const run = (taskId: string, pass: boolean, extra: Partial<RunRecordV2> = {}): RunRecordV2 => ({
    schema: 2, taskId, family: "f", seed: 1, tier: "core", mode: "agent", expectation: "complete",
    model: { id: "m", registryHash: "h" }, runIndex: 1, pass, oracleResults: [], finalState: "completed", stopReason: "ok",
    falseCompletion: !pass, falseRefusal: false, wallMs: 1000, modelCalls: 4, callsByRole: {}, recoveries: 0, approvals: 1, toolCalls: 3, filesRead: 2, ...extra,
  });
  const suite = (runs: RunRecordV2[]): SuiteResultV2 => ({ schema: 2, suite: "core", timestamp: "", k: 1, model: { id: "m", registryHash: "h" }, features: {}, stats: summarize(runs), families: {}, runs });

  it("summarizes pass@k and pass^k per task", () => {
    const stats = summarize([run("a", true), run("a", false, { runIndex: 2 }), run("b", true), run("b", true, { runIndex: 2 })]);
    expect(stats.tasks).toBe(2);
    expect(stats.passAtK).toBe(1);
    expect(stats.passPowK).toBe(0.5);
    expect(stats.passRate).toBeCloseTo(0.75);
  });

  it("flags a CI-significant pass-rate regression and a false-completion rise", () => {
    const good = suite(Array.from({ length: 40 }, (_, i) => run(`t${i}`, true)));
    const bad = suite(Array.from({ length: 40 }, (_, i) => run(`t${i}`, i < 10)));
    const cmp = compareSuites(good, bad);
    expect(cmp.regressions.length).toBeGreaterThanOrEqual(2);
    expect(cmp.flips.length).toBe(30);
    expect(compareSuites(good, good).regressions).toEqual([]);
  });

  it("treats a small drop as noise", () => {
    const a = suite(Array.from({ length: 10 }, (_, i) => run(`t${i}`, i < 7)));
    const b = suite(Array.from({ length: 10 }, (_, i) => run(`t${i}`, i < 6, { falseCompletion: false })));
    expect(compareSuites(a, b).regressions).toEqual([]);
  });
});
