import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withTaskProgress } from "../src/main/run/task-progress.js";
import { reviewAttachedPython, reviewProposedPython, reviewSourceResponse } from "../src/main/agent/source-review.js";
import type { ModelGateway } from "../src/main/gateway/model-gateway.js";
import type { TaskProgressEvent } from "../src/shared/contracts.js";

let root: string;
let oldRoot: string | undefined;
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "task-progress-")); oldRoot = process.env.WORKBENCH_DATA_ROOT; process.env.WORKBENCH_DATA_ROOT = root; });
afterEach(() => { if (oldRoot === undefined) delete process.env.WORKBENCH_DATA_ROOT; else process.env.WORKBENCH_DATA_ROOT = oldRoot; rmSync(root, { recursive: true, force: true }); });
const item = (index: number) => ({ index, status: "satisfied", issue: "The input is retained.", sourceEvidence: "input", implementationEvidence: "input" });
const response = (content: string, finishReason = "stop") => ({ ok: true, value: { content, finishReason } });
const reviewInput = () => ({ runId: randomUUID(), modelId: "primary-model", request: "Repair the source.", sourceEvidence: "input", currentSource: "input", executionOutput: "output", sourceChecklist: JSON.stringify({ checks: ["One", "Two", "Three"] }) });

it("does not let observers affect the operation result or its original error", async () => {
  const context = { runId: "run", emitProgress: () => { throw new Error("Observer failed"); } };
  await expect(withTaskProgress(context, "source_inspection", async () => 42)).resolves.toBe(42);
  const original = new Error("Actual error");
  await expect(withTaskProgress(context, "source_inspection", async () => { throw original; })).rejects.toBe(original);
});

it("suppresses late checkpoints after cancellation while preserving the work result", async () => {
  const events: TaskProgressEvent[] = [];
  let cancelled = false;
  const result = await withTaskProgress({ runId: "run", emitProgress: event => events.push(event), isCancelled: () => cancelled }, "post_execution_review", async activity => {
    activity.assess(0, 3); cancelled = true; activity.assess(1, 3); return "original result";
  });
  expect(result).toBe("original result");
  expect(events.map(event => [event.status, event.assessedChecks])).toEqual([["active", undefined], ["active", 0]]);
});

it("counts only complete parsed and index-matched assessments, without exposing response fragments", async () => {
  const events: TaskProgressEvent[] = [];
  const chat = vi.fn().mockResolvedValueOnce(response(JSON.stringify([item(0), item(0), item(99)])))
    .mockResolvedValueOnce(response("PRIVATE INVALID RESPONSE"))
    .mockResolvedValueOnce(response(JSON.stringify([item(0)])));
  await expect(reviewAttachedPython({ ...reviewInput(), gateway: { chatWithTools: chat } as unknown as ModelGateway, emitProgress: event => events.push(event) })).rejects.toThrow("did not assess every");
  expect(events.filter(event => event.assessedChecks !== undefined).map(event => event.assessedChecks)).toEqual([0, 1, 2, 2]);
  expect(events[events.length - 1]).toMatchObject({ status: "blocked", assessedChecks: 2, totalChecks: 3 });
  expect(new Set(events.map(event => event.activityId)).size).toBe(1);
  expect(JSON.stringify(events)).not.toContain("PRIVATE");
  expect(chat).toHaveBeenCalledTimes(3);
});

it.each(["length", "malformed"])("does not count %s review output, including valid-looking truncated JSON", async kind => {
  const events: TaskProgressEvent[] = [];
  const chat = vi.fn(async () => response(kind === "length" ? JSON.stringify([item(0)]) : "{", kind === "length" ? "length" : "stop"));
  await expect(reviewAttachedPython({ ...reviewInput(), gateway: { chatWithTools: chat } as unknown as ModelGateway, emitProgress: event => events.push(event) })).rejects.toThrow("did not assess every");
  expect(events.filter(event => event.assessedChecks !== undefined).every(event => event.assessedChecks === 0)).toBe(true);
  expect(events[events.length - 1].status).toBe("blocked");
  expect(chat).toHaveBeenCalledTimes(4);
});

it("keeps review requests, token limits, and call counts identical when progress is observed", async () => {
  const input = reviewInput();
  const chat = vi.fn(async () => response(JSON.stringify([item(0), item(1), item(2)])));
  const gateway = { chatWithTools: chat } as unknown as ModelGateway;
  await reviewAttachedPython({ ...input, gateway });
  const original = structuredClone(chat.mock.calls);
  chat.mockClear();
  const events: TaskProgressEvent[] = [];
  await reviewAttachedPython({ ...input, gateway, emitProgress: event => events.push(event) });
  expect(chat.mock.calls).toEqual(original);
  expect(chat).toHaveBeenCalledTimes(1);
  expect(events[events.length - 1]).toMatchObject({ status: "completed", assessedChecks: 3, totalChecks: 3 });
});

it("reports pre-execution gaps as blocked without changing the returned findings", async () => {
  const events: TaskProgressEvent[] = [];
  const gateway = { chatWithTools: vi.fn(async () => response(JSON.stringify({ gaps: [{ check: "Input", issue: "A source gap.", sourceEvidence: "input", implementationEvidence: "input" }] }))) } as unknown as ModelGateway;
  const findings = await reviewProposedPython({ ...reviewInput(), gateway, proposedSource: "input", target: "repair.py", emitProgress: event => events.push(event) });
  expect(findings).toHaveLength(1);
  expect(events[events.length - 1]).toMatchObject({ stage: "pre_execution_review", status: "blocked", target: "repair.py" });
});

it("reports coverage and correction stages without adding a review request", async () => {
  const events: TaskProgressEvent[] = [];
  const review = (gaps: string[]) => JSON.stringify({ sourceCoverage: [], edits: [], coverageGaps: gaps, unresolvedIssues: [] });
  const chat = vi.fn().mockResolvedValueOnce(response(review(["Include supplied evidence."])))
    .mockResolvedValueOnce(response("Corrected draft."))
    .mockResolvedValueOnce(response(review([])));
  const result = await reviewSourceResponse({ runId: randomUUID(), modelId: "primary-model", gateway: { chatWithTools: chat } as unknown as ModelGateway,
    request: "Draft a report", evidence: "Supplied evidence.", candidate: "Original draft.", emitProgress: event => events.push(event) });
  expect(result.content).toBe("Corrected draft.");
  expect(events.map(event => [event.stage, event.status])).toEqual([["source_coverage_review", "active"], ["correction", "active"], ["correction", "completed"], ["source_coverage_review", "completed"]]);
  expect(chat).toHaveBeenCalledTimes(3);
});
