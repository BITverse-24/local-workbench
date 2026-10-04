import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOCKED_FLOW_B_CODE_RULES,
  validateCodeDraftResult,
} from "../validation";
import successfulCode from "../mock-responses/successful-code-generation.json";
import malformedCode from "../mock-responses/malformed-code-response.json";
import expectedSummary from "../../demo/flow_b/expected-out-of-range-summary.json";
import expectedExecution from "../../demo/flow_b/expected-python-execution.json";

describe("code contract (Flow B generation)", () => {
  it("accepts the safe code mock and pins the Flow B summary counts", () => {
    expect(
      validateCodeDraftResult(successfulCode.result, LOCKED_FLOW_B_CODE_RULES)
        .ok,
    ).toBe(true);
    expect(
      (successfulCode.result as { expectedResult: string }).expectedResult,
    ).toContain("OUT_OF_RANGE 7/240 (high=5, low=2)");
    expect(expectedSummary.summary.outOfRange).toBe(7);
    expect(expectedSummary.summary.high).toBe(5);
    expect(expectedSummary.summary.low).toBe(2);
    expect(expectedSummary.rows).toHaveLength(7);
  });

  it("pins the execution oracle and forbids hard-coded counts in source", () => {
    expect(expectedExecution.exitCode).toBe(0);
    expect(expectedExecution.stdout).toContain(
      "OUT_OF_RANGE 7/240 (high=5, low=2)",
    );
    expect(expectedExecution.timedOut).toBe(false);
    expect(
      (successfulCode.result as { source: string }).source,
    ).not.toMatch(/OUT_OF_RANGE\s+7\/240/);
  });

  it("rejects malformed code and unsafe, misnamed, or hard-coded variants", () => {
    expect(
      validateCodeDraftResult(malformedCode.result, LOCKED_FLOW_B_CODE_RULES)
        .ok,
    ).toBe(false);
    const invalid = {
      filename: "run.sh",
      source: "import subprocess\nprint('OUT_OF_RANGE 7/240 (high=5, low=2)')",
      expectedResult: "OUT_OF_RANGE 7/240 (high=5, low=2)",
      inputFiles: ["../reactor-temperature-log.csv"],
      outputFiles: ["out-of-range-rows.csv"],
      allowedImports: ["subprocess"],
      extra: true,
    };
    expect(validateCodeDraftResult(invalid).ok).toBe(false);
  });

  it("golden Python file stays the safe reference for the fixed CSV task", () => {
    const golden = readFileSync(
      path.resolve("demo/flow_b/expected-task.py"),
      "utf8",
    );
    expect(golden).toContain("reactor-temperature-log.csv");
    expect(golden).toContain("out-of-range-rows.csv");
    expect(golden).not.toMatch(/subprocess|socket|requests|os\.system/);
  });
});
