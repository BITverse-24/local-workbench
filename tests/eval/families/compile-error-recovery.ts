import { Rng } from "../core/prng.js";
import type { FileMap, TaskFamily, TaskInstance } from "../core/task-spec.js";
import { jsPackage, lit, pyLit } from "./util.js";

function jsCase(rng: Rng) {
  const high = rng.pick([80, 85, 90]);
  const warn = rng.pick([60, 65, 70]);
  const clean = `function classifyReading(reading) {
  if (!reading || typeof reading.value !== "number" || Number.isNaN(reading.value)) {
    return { level: "invalid", delta: 0 };
  }
  const value = reading.value;
  if (value >= ${high}) {
    return { level: "critical", delta: Math.round((value - ${high}) * 10) / 10 };
  }
  if (value >= ${warn}) {
    return { level: "warning", delta: Math.round((value - ${warn}) * 10) / 10 };
  }
  return { level: "normal", delta: 0 };
}

function summarizeBatch(readings) {
  const counts = { critical: 0, warning: 0, normal: 0, invalid: 0 };
  let maxDelta = 0;
  for (const r of readings) {
    const res = classifyReading(r);
    counts[res.level] += 1;
    if (res.delta > maxDelta) maxDelta = res.delta;
  }
  return { counts, maxDelta };
}

module.exports = { classifyReading, summarizeBatch };
`;
  // Both a subtle logic defect (strict > on warn) and a syntax defect (unclosed brace in summarizeBatch).
  const broken = clean
    .replace(`if (value >= ${warn}) {`, `if (value > ${warn}) {`)
    .replace(`    if (res.delta > maxDelta) maxDelta = res.delta;\n  }`, `    if (res.delta > maxDelta) { maxDelta = res.delta;\n  }`);
  const test = `const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyReading, summarizeBatch } = require("../src/monitor");

test("classifies thresholds inclusively and summarizes batches", () => {
  assert.deepEqual(classifyReading({ value: ${warn} }), { level: "warning", delta: 0 });
  assert.deepEqual(classifyReading({ value: ${high} }), { level: "critical", delta: 0 });
  const s = summarizeBatch([{ value: ${high + 4} }, { value: ${warn} }, { value: 20 }, {}]);
  assert.deepEqual(s, { counts: { critical: 1, warning: 1, normal: 1, invalid: 1 }, maxDelta: 4 });
});
`;
  return {
    prompt: `\`src/monitor.js\` does not load cleanly and its threshold classification fails the tests. Fix \`src/monitor.js\` so all tests pass. Do not change the tests.`,
    workspace: { "package.json": jsPackage("monitor", "node --test test/*.test.js"), "src/monitor.js": broken, "test/monitor.test.js": test } as FileMap,
    reference: { "src/monitor.js": clean } as FileMap,
    allow: ["src/monitor.js"],
    protect: ["test/monitor.test.js", "package.json"],
    command: "node --test test/*.test.js",
    requires: ["node"],
  };
}

function pyCase(rng: Rng) {
  const high = rng.pick([80, 85, 90]);
  const warn = rng.pick([60, 65, 70]);
  const clean = `def classify_reading(reading):
    val = reading.get("value") if isinstance(reading, dict) else None
    if not isinstance(val, (int, float)) or isinstance(val, bool):
        return {"level": "invalid", "delta": 0}
    if val >= ${high}:
        return {"level": "critical", "delta": round(val - ${high}, 1)}
    if val >= ${warn}:
        return {"level": "warning", "delta": round(val - ${warn}, 1)}
    return {"level": "normal", "delta": 0}


def summarize_batch(readings):
    counts = {"critical": 0, "warning": 0, "normal": 0, "invalid": 0}
    max_delta = 0
    for r in readings:
        res = classify_reading(r)
        counts[res["level"]] += 1
        if res["delta"] > max_delta:
            max_delta = res["delta"]
    return {"counts": counts, "max_delta": max_delta}
`;
  const broken = clean
    .replace(`if val >= ${warn}:`, `if val > ${warn}:`)
    .replace(`        if res["delta"] > max_delta:\n            max_delta = res["delta"]`, `        if res["delta"] > max_delta\n            max_delta = res["delta"]`);
  const test = `import unittest
from monitor import classify_reading, summarize_batch


class MonitorTests(unittest.TestCase):
    def test_thresholds_and_summary(self):
        self.assertEqual(classify_reading({"value": ${warn}}), {"level": "warning", "delta": 0})
        self.assertEqual(classify_reading({"value": ${high}}), {"level": "critical", "delta": 0})
        s = summarize_batch([{"value": ${high + 4}}, {"value": ${warn}}, {"value": 20}, {}])
        self.assertEqual(s, {"counts": {"critical": 1, "warning": 1, "normal": 1, "invalid": 1}, "max_delta": ${pyLit(4)}})


if __name__ == "__main__":
    unittest.main()
`;
  void lit;
  return {
    prompt: `\`monitor.py\` fails to import and its threshold classification fails the tests. Fix \`monitor.py\` so all tests pass. Do not change the tests.`,
    workspace: { "monitor.py": broken, "test_monitor.py": test } as FileMap,
    reference: { "monitor.py": clean } as FileMap,
    allow: ["monitor.py"],
    protect: ["test_monitor.py"],
    command: "python3 -B -m unittest test_monitor.py",
    requires: ["python3"],
  };
}

function generate(seed: number): TaskInstance {
  const rng = new Rng(seed * 3571 + 19);
  const c = seed % 2 === 0 ? pyCase(rng) : jsCase(rng);
  return {
    id: `compile-error-recovery/${seed}`,
    family: "compile-error-recovery",
    seed,
    tier: "hard",
    mode: "agent",
    prompt: c.prompt,
    workspace: c.workspace,
    reference: { files: c.reference },
    oracles: [
      { type: "command", command: c.command },
      { type: "scope", allow: c.allow, protect: c.protect, requireChange: true },
    ],
    expectation: "complete",
    limits: { timeoutMs: 600000 },
    requires: c.requires,
  };
}

export const compileErrorRecovery: TaskFamily = {
  id: "compile-error-recovery",
  tier: "hard",
  mode: "agent",
  description: "Module with both a syntax error and a boundary defect; measures how quickly the agent recovers to a clean test pass.",
  devSeeds: Array.from({ length: 8 }, (_, i) => i + 1),
  generate,
};
