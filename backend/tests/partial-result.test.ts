import { expect, it } from "vitest";
import { formatPartialResult, type PartialResultEvidence } from "../src/main/run/partial-result.js";
import type { TaskProgressEvent } from "../src/shared/contracts.js";

const review = (status: TaskProgressEvent["status"], assessedChecks = 6): TaskProgressEvent => ({
  type: "task_progress", runId: "run", activityId: "review", stage: "post_execution_review", status,
  target: "corrected.py", assessedChecks, totalChecks: 8, reason: status === "blocked" ? "The review did not assess all source checks." : undefined,
});
const evidence = (): PartialResultEvidence => ({ savedFiles: ["corrected.py"], executions: [{ target: "corrected.py", exitCode: 0 }],
  checkpoints: [review("blocked")], missing: [], verificationFailures: [] });

it("replays the key evidence from run 80d5bac1: file saved, execution succeeded, behavior review incomplete", () => {
  const result = formatPartialResult("Observed output:\nActual supplied observations.", evidence());
  expect(result).toContain("**Partially complete**");
  expect(result).toContain("File saved: `corrected.py`");
  expect(result).toContain("Execution succeeded (exit code 0)");
  expect(result).toContain("Complete behavior coverage");
  expect(result).toContain("6 of 8 checks assessed");
  expect(result).toContain("The review did not assess all source checks.");
  expect(result).toContain("Actual supplied observations.");
  expect(result).not.toContain("checks passed");
  expect(result).not.toContain("fully verified");
});

it("makes no saved-file or execution success claim without the corresponding evidence", () => {
  const result = formatPartialResult("Actual tool error.", { ...evidence(), savedFiles: [], executions: [{ exitCode: 1 }], missing: ["Requested report"], checkpoints: [] });
  expect(result).not.toContain("**Confirmed**");
  expect(result).not.toContain("succeeded");
  expect(result).toContain("Requested report");
  expect(result).toContain("Actual tool error.");
});

it("does not carry a resolved blocker into a later partial answer", () => {
  const result = formatPartialResult("Other work remains.", { ...evidence(), checkpoints: [review("blocked"), { ...review("completed", 8), activityId: "new-review" }], missing: ["Second requested file"] });
  expect(result).not.toContain("The review did not assess all source checks.");
  expect(result).not.toContain("Complete behavior coverage");
  expect(result).toContain("Second requested file");
});

it("keeps dynamic names and reasons literal instead of injecting rich text or links", () => {
  const result = formatPartialResult("Original detail", { ...evidence(), savedFiles: ["[open](https://example.test).py"], stopReason: "<b>error</b>\n**text**" });
  expect(result).toContain("`[open](https://example.test).py`");
  expect(result).not.toContain("<b>");
  expect(result).toContain("Original detail");
});

it("keeps the summary within the saved-message limit and clearly marks shortened details", () => {
  const result = formatPartialResult("Useful diagnosis.\n" + "Observed detail. ".repeat(2500), evidence(), 32768);
  expect(result).toHaveLength(32768);
  expect(result).toContain("**Partially complete**");
  expect(result).toContain("Useful diagnosis.");
  expect(result).toContain("Details shortened");
});

it("shows recorded workspace writes separately from pending acceptance", () => {
  const result = formatPartialResult("Written source still needs validation.", { ...evidence(), checkpoints: [], savedFiles: [], executions: [],
    workspaceOperations: [{ operation: "write", target: "src/source_file.py" }], verificationPending: ["Validate the written implementation"] });
  expect(result).toContain("Workspace write completed: `src/source_file.py`");
  expect(result).toContain("Acceptance not yet verified: Validate the written implementation");
  expect(result).not.toContain("src/source\\_file.py");
  expect(result).not.toContain("Execution succeeded");
});
