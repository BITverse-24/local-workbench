import { approvedPythonTool as executePythonTool } from "./helpers/approved-python.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "./helpers/agent-loop-fixture.js";

import { createRunDirectories, resolveRunPath } from "../src/main/run/filesystem.js";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { normalizeRunContract } from "../src/main/run/contract.js";
import { validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";
import type { RunEvent } from "../src/shared/contracts.js";
import { reviewProposedPython, reviewSourceResponse } from "../src/main/agent/source-review.js";
import { RunManager } from "../src/main/run/manager.js";
import { getState } from "../src/main/run/store.js";
import { listMessages } from "../src/main/persistence/messages.js";
import { getVerificationReport } from "../src/main/run/verification.js";
import { createChat } from "../src/main/persistence/chats.js";

describe("V0 attached-source transport and execution integrity", () => {
  let root: string;
  let previousRoot: string | undefined;
  let runId: string;
  const source = "import sys\nprint(open(sys.argv[1]).read().strip())\n";

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "v0-regression-"));
    previousRoot = process.env.WORKBENCH_DATA_ROOT;
    process.env.WORKBENCH_DATA_ROOT = root;
    initDb(path.join(root, "workbench.sqlite"));
    runId = randomUUID();
    createRunDirectories(runId);
    writeFileSync(resolveRunPath(runId, "input/original.py", "input"), source);
    writeFileSync(resolveRunPath(runId, "input/input.txt", "input"), "actual supplied text\n");
  });
  afterEach(() => {
    closeDb();
    if (previousRoot === undefined) delete process.env.WORKBENCH_DATA_ROOT;
    else process.env.WORKBENCH_DATA_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });

  async function run(work: (messages: any[]) => any, preflight?: () => any[], behaviorReview?: () => any) {
    const events: RunEvent[] = [];
    const intent = validateAndNormalizeIntent({ requestedAction: "modify_software", responseMode: "chat_and_files", primaryGoal: "Repair supplied source", workspaceMutationRequested: false,
      expectedDeliverables: [{ type: "file", filename: "corrected.py" }], validationRequested: true }, { userPrompt: "Repair and execute the attached source on input.txt.", hasWorkspace: false, workspaceFiles: [] });
    const contract = normalizeRunContract(runId, intent);
    const gateway = {
      registry: new Map([["primary-model", { maxOutputTokens: 1536 }]]),
      async chatWithTools(_model: string, messages: any[], _tools: any[], options: any) {
        if (options?.responseSchema?.name === "proposed_source_behavior_review") return { ok: true, value: { content: JSON.stringify({ gaps: preflight?.() ?? [] }), finishReason: "stop" } };
        if (options?.responseSchema?.name === "source_derived_code_behavior_review") return behaviorReview?.() ?? { ok: true, value: { content: JSON.stringify([{ index: 0, status: "satisfied", issue: "The CLI retains access to its supplied arguments.", sourceEvidence: "import sys", implementationEvidence: "import sys" }]), finishReason: "stop" } };
        return { ok: true, value: work(messages) };
      },
    };
    const result = await new AgentLoop().run({ runId, driverModelId: "primary-model", semanticIntent: intent, runContract: contract,
      userPrompt: "Repair and execute the attached source on input.txt.", systemPrompt: `Complete original source:\n${source}\nSupplied input: input.txt`,
      tools: [executePythonTool], context: { runId, gateway: gateway as any, workspaceRoot: root, sourceReviewEvidence: source },
      emitEvent: event => events.push(event), onPlanConfirmationRequired: async () => true });
    return { result, events };
  }

  it("dispatches a complete source emitted as text only under the persisted repair contract", async () => {
    const { result, events } = await run(() => ({ content: `\`\`\`python\n${source}\`\`\``, finishReason: "stop" }));
    expect(result.outcome).toBe("completed");
    expect(events.filter(e => e.type === "tool_call" && e.tool === "execute_python")).toHaveLength(1);
    expect(readFileSync(resolveRunPath(runId, "output/corrected.py", "output"), "utf8")).toBe(source);
    expect(result.finalText).toContain("actual supplied text");
  });

  it.each([
    ["missing checks", { ok: true, value: { content: "[]", finishReason: "stop" } }, "did not assess every source-derived check"],
    ["malformed results", { ok: true, value: { content: "not JSON", finishReason: "stop" } }, "did not assess every source-derived check"],
    ["truncated results", { ok: true, value: { content: "[]", finishReason: "length" } }, "did not assess every source-derived check"],
    ["unavailable reviewer", { ok: false, error: { message: "actual review endpoint error" } }, "actual review endpoint error"],
  ])("preserves executed work as partial when the behavior review has %s", async (_case, response, reason) => {
    const { result, events } = await run(() => ({ content: `\`\`\`python\n${source}\`\`\``, finishReason: "stop" }), undefined, () => response);
    expect(result.outcome).toBe("partial");
    expect(result.completed).toBe(false);
    expect(result.finalText).toContain("exit code 0");
    expect(result.finalText).toContain("actual supplied text");
    expect(result.finalText).toContain("Behavior validation is incomplete");
    expect(result.finalText).toContain(String(reason));
    expect(result.finalText).toContain("has not been fully verified");
    expect(result.deliverables).toMatchObject({ produced: ["corrected.py"], missing: [] });
    expect(events.filter(e => e.type === "tool_call" && e.tool === "execute_python")).toHaveLength(1);
    expect(events.filter(e => e.type === "artifact_ready")).toHaveLength(1);
    expect(readFileSync(resolveRunPath(runId, "output/corrected.py", "output"), "utf8")).toBe(source);
  });

  it("does not soften an unexpected internal review exception", async () => {
    await expect(run(() => ({ content: `\`\`\`python\n${source}\`\`\``, finishReason: "stop" }), undefined,
      () => { throw new Error("unexpected internal review fault"); })).rejects.toThrow("unexpected internal review fault");
  });

  it("persists a partial run and final explanation after an incomplete post-execution review", async () => {
    const events: RunEvent[] = [];
    const requests: any[] = [];
    const gateway = {
      registry: new Map([["primary-model", { id: "primary-model", enabled: true, model: "test-model", maxOutputTokens: 1536 }]]),
      inferenceGroupFor: () => undefined,
      async execute() { return { ok: true, value: { result: {
        requestedAction: "modify_software", responseMode: "chat_and_files", primaryGoal: "Repair supplied source",
        workspaceMutationRequested: false, expectedDeliverables: [{ type: "file", filename: "corrected.py" }], validationRequested: true,
      } } }; },
      async chatWithTools(_model: string, _messages: any[], _tools: any[], options: any) {
        requests.push(options);
        const schema = options?.responseSchema?.name;
        const content = schema === "work_requirements" ? JSON.stringify({checks:[]})
          : schema === "software_repair_review" ? JSON.stringify({ defects: [], checks: ["Preserve the supplied CLI input."], preservedBehavior: [] })
          : schema === "proposed_source_behavior_review" ? JSON.stringify({ gaps: [] })
          : schema === "source_derived_code_behavior_review" ? "[]" : `\`\`\`python\n${source}\`\`\``;
        return { ok: true, value: { content, finishReason: "stop" } };
      },
    };
    const manager = new RunManager(gateway as any, event => {
      events.push(event);
      if (event.type === "confirmation_required") void manager.confirm({ runId: event.runId, actionId: event.action.actionId, approved: true });
    });
    const chatId=createChat();
    const uploaded = manager.registerAttachment({ chatId, filename: "original.py", mediaType: "text/x-python", sizeBytes: Buffer.byteLength(source), base64OrBuffer: Buffer.from(source) });
    const input = Buffer.from("actual supplied text\n");
    const data = manager.registerAttachment({ chatId, filename: "input.txt", mediaType: "text/plain", sizeBytes: input.length, base64OrBuffer: input });
    const previousV2 = process.env.WORKBENCH_AGENT_V2;
    process.env.WORKBENCH_AGENT_V2 = "true";
    try {
      const started = await manager.start({ chatId, mode:'work', userText: "Repair and execute the attached source on input.txt. Return corrected.py.", attachmentTokens: [uploaded.attachment.attachmentId, data.attachment.attachmentId], groundingEnabled: false });
      await vi.waitFor(() => expect(["completed", "partial", "failed", "cancelled"]).toContain(getState(started.runId)), { timeout: 10000 });
      expect(getState(started.runId)).toBe("partial");
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(events.filter(event => event.type === "artifact_ready")).toHaveLength(1);
      expect(readFileSync(resolveRunPath(started.runId, "output/corrected.py", "output"), "utf8")).toBe(source);
      const savedRun = getDb().prepare("SELECT chat_id FROM runs WHERE id=?").get(started.runId) as { chat_id: string };
      const finalMessage = listMessages(savedRun.chat_id).find(message => message.run_id === started.runId && message.role === "assistant")!;
      expect(finalMessage.content).toContain("**Partially complete**");
      expect(finalMessage.content).toContain("File saved: `corrected.py`");
      expect(finalMessage.content).toContain("Execution succeeded (exit code 0)");
      expect(finalMessage.content).toContain("Complete behavior coverage");
      expect(finalMessage.content).toContain("0 of 2 checks assessed");
      expect(events.filter(event => event.type === "task_progress" && event.stage === "post_execution_review").at(-1))
        .toMatchObject({ status: "blocked", assessedChecks: 0, totalChecks: 2 });
      expect(events.filter(event => event.type === "assistant_message").at(-1)).toMatchObject({ messageId: finalMessage.id, text: finalMessage.content });
      expect(finalMessage.content).toContain("Behavior validation is incomplete");
      expect(finalMessage.content).toContain("actual supplied text");
      expect(finalMessage.artifacts?.map(artifact => artifact.filename)).toEqual(["corrected.py"]);
      expect(requests).toHaveLength(8);
      expect(events.filter(event=>event.type==='tool_call'&&event.tool==='execute_python')).toHaveLength(1);
      expect(requests.filter(options => options.responseSchema?.name === "source_derived_code_behavior_review").map(options => options.maxTokens)).toEqual([1536, 1536, 1536]);
      closeDb();
      initDb(path.join(root, "workbench.sqlite"));
      expect(listMessages(savedRun.chat_id).find(message => message.id === finalMessage.id)?.content).toBe(finalMessage.content);
      const report = getVerificationReport(started.runId)!;
      expect(report.checks.find(check => check.criterionId === "acceptance:validated-python:corrected.py")?.status).toBe("unverified");
    } finally {
      if (previousV2 === undefined) delete process.env.WORKBENCH_AGENT_V2;
      else process.env.WORKBENCH_AGENT_V2 = previousV2;
    }
  });

  it("repairs from the latest source and real error, preserving actual supplied input", async () => {
    const failed = "import sys\nraise RuntimeError('actual execution fault')\n";
    let turns = 0;
    const { result, events } = await run(messages => {
      if (++turns === 1) return { content: null, finishReason: "stop", tool_calls: [{ id: "first", name: "execute_python", arguments: { filename: "corrected.py", code: failed, input_files: ["input.txt"] } }] };
      const feedback = [...messages].reverse().find(message => message.role === "user").content;
      expect(feedback).toContain(failed.trim());
      expect(feedback).toContain("actual execution fault");
      expect(existsSync(resolveRunPath(runId, "output/corrected.py", "output"))).toBe(false);
      return { content: `\`\`\`python\n${source}\`\`\``, finishReason: "stop" };
    });
    expect(turns).toBe(2);
    expect(result.outcome).toBe("completed");
    expect(events.filter(e => e.type === "tool_result" && e.tool === "execute_python").map(e => (e as any).ok)).toEqual([false, true]);
    expect(events.filter(e => e.type === "artifact_ready")).toHaveLength(1);
    expect(result.finalText).toContain("actual supplied text");
    expect(readFileSync(resolveRunPath(runId, "input/original.py", "input"), "utf8")).toBe(source);
  });

  it("never executes or exports a source response with a length finish reason", async () => {
    const { result, events } = await run(() => ({ content: `\`\`\`python\n${source}\`\`\``, finishReason: "length" }));
    expect(result.outcome).toBe("partial");
    expect(events.some(e => e.type === "tool_call")).toBe(false);
    expect(existsSync(resolveRunPath(runId, "output/corrected.py", "output"))).toBe(false);
  });

  it("shares the two-correction budget across source review and execution recovery", async () => {
    let workTurns = 0;
    let reviews = 0;
    const { result, events } = await run(() => ({ finishReason: "stop", content: null,
      tool_calls: [{ id: String(++workTurns), name: "execute_python", arguments: { filename: "corrected.py", input_files: ["input.txt"], code: `import sys\nraise RuntimeError('fault ${workTurns}')\n` } }],
    }), () => ++reviews === 1 ? [{ check: "Preserve printed output", issue: "The existing CLI output was removed.", sourceEvidence: "print(open(sys.argv[1]).read().strip())", implementationEvidence: "raise RuntimeError" }] : []);
    expect(workTurns).toBe(3);
    expect(result.outcome).toBe("failed");
    expect(events.filter(e => e.type === "tool_call" && e.tool === "execute_python")).toHaveLength(2);
    expect(events.some(e => e.type === "artifact_ready")).toBe(false);
  });

  it("keeps optional empty validation separate from exact saved-program execution", async () => {
    const result = await executePythonTool.execute({ filename: "corrected.py", code: source, input_files: ["input.txt"], validation_code: "" }, { runId, workspaceRoot: root, gateway: {} as any, requestedArtifacts: [{ type: "file", filename: "corrected.py" }] });
    expect(result.ok).not.toBe(false);
    expect(JSON.parse(result.output).stdout.trim()).toBe("actual supplied text");
    expect(readFileSync(resolveRunPath(runId, "output/corrected.py", "output"), "utf8")).toBe(source);
  });

  it("does not let unsupported assertions or expected values reject a working repair", async () => {
    const intent = validateAndNormalizeIntent({ requestedAction: "modify_software", responseMode: "chat_and_files", primaryGoal: "Repair supplied source", workspaceMutationRequested: false,
      expectedDeliverables: [{ type: "file", filename: "corrected.py" }], validationRequested: true }, { userPrompt: "Repair and execute the attached source.", hasWorkspace: false, workspaceFiles: [] });
    const result = await executePythonTool.execute({ filename: "corrected.py", code: source, input_files: ["input.txt"],
      validation_code: "assert False, 'invented behavior'", checks: [{ function: "invented_function", args: [], expected: "invented result" }] },
    { runId, workspaceRoot: root, gateway: {} as any, runContract: normalizeRunContract(runId, intent), originalUserRequest: "Repair and execute the attached source.", sourceReviewEvidence: source });
    const observation = JSON.parse(result.output);
    expect(result.ok).not.toBe(false);
    expect(observation.stdout.trim()).toBe("actual supplied text");
    expect(observation.validationAssertionsPassed).toBe(false);
    expect(observation.validationChecksIgnored).toHaveLength(2);
    expect(readFileSync(resolveRunPath(runId, "output/corrected.py", "output"), "utf8")).toBe(source);
  });

  it("keeps a check explicitly supplied by the user authoritative", async () => {
    const check = "assert False, 'required check'";
    const request = `Repair the attached source and run this required check: ${check}`;
    const intent = validateAndNormalizeIntent({ requestedAction: "modify_software", responseMode: "chat_and_files", primaryGoal: "Repair supplied source", workspaceMutationRequested: false,
      expectedDeliverables: [{ type: "file", filename: "corrected.py" }], validationRequested: true }, { userPrompt: request, hasWorkspace: false, workspaceFiles: [] });
    const result = await executePythonTool.execute({ filename: "corrected.py", code: source, input_files: ["input.txt"], validation_code: check },
    { runId, workspaceRoot: root, gateway: {} as any, runContract: normalizeRunContract(runId, intent), originalUserRequest: request, sourceReviewEvidence: source });
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.output).failureStage).toBe("behavior_checks");
    expect(existsSync(resolveRunPath(runId, "output/corrected.py", "output"))).toBe(false);
  });

  it("does not treat a model-generated checklist assertion as source authority", async () => {
    const gateway = { async chatWithTools() { return { ok: true, value: { finishReason: "stop", content: JSON.stringify({ gaps: [{
      check: "Return the invented total.", issue: "Change the total to 77.", sourceEvidence: "Expect total 77.", implementationEvidence: "return total",
    }] }) } }; } };
    const gaps = await reviewProposedPython({ runId, gateway: gateway as any, modelId: "primary-model", request: "Repair the attached source.",
      sourceEvidence: "def tally(items):\n    return len(items)", sourceChecklist: JSON.stringify({ checks: ["Expect total 77."] }), proposedSource: "def tally(items):\n    total = len(items)\n    return total" });
    expect(gaps).toEqual([]);
  });

  it("accepts an inclusive boundary expressed by the opposite branch", async () => {
    const gateway = { async chatWithTools() { return { ok: true, value: { finishReason: "stop", content: JSON.stringify({ gaps: [] }) } }; } };
    const gaps = await reviewProposedPython({ runId, gateway: gateway as any, modelId: "primary-model", request: "Preserve the documented behavior.",
      sourceEvidence: "# The alarm has an inclusive 8 upper limit.\ndef alarm(value):\n    return value >= 8\n",
      sourceChecklist: JSON.stringify({ checks: ["Preserve the inclusive 8 upper limit."] }),
      proposedSource: "def alarm(value):\n    if value < 8:\n        return False\n    else:\n        return True\n" });
    expect(gaps).toEqual([]);
  });

  it("corrects a known document omission with its current output and exact source evidence", async () => {
    const candidate = "# Review\n## Identifier: UNIT-MOSS\nSurface inspection complete.";
    const corrected = candidate + "\nAction: Replace the damaged seal before reuse. (record.md, page 2)";
    let correctionTurns = 0;
    const gateway = { async chatWithTools(_model: string, messages: any[], _tools: any[], options: any) {
      if (!options.responseSchema) {
        correctionTurns++;
        const feedback = JSON.parse(messages[1].content);
        expect(feedback.currentCandidate).toBe(candidate);
        expect(feedback.requiredCorrections.join(" ")).toContain("Replace the damaged seal before reuse.");
        return { ok: true, value: { content: corrected, finishReason: "stop" } };
      }
      return { ok: true, value: { content: JSON.stringify({ edits: [], unresolvedIssues: [], coverageGaps: [], sourceCoverage: [{
        subject: "UNIT-MOSS", sourceQuote: "Replace the damaged seal before reuse.", status: "covered",
        candidateQuote: "Action: Replace the damaged seal before reuse. (record.md, page 2)",
      }] }), finishReason: "stop" } };
    } };
    const result = await reviewSourceResponse({ runId, modelId: "primary-model", gateway: gateway as any, request: "Write a grounded review with next actions.", candidate,
      evidence: "--- ATTACHED FILE: record.md ---\nIdentifier: UNIT-MOSS\n--- Page 2 ---\nReplace the damaged seal before reuse.\n--- END ATTACHED FILE: record.md ---" });
    expect(correctionTurns).toBe(1);
    expect(result.content).toContain("Replace the damaged seal before reuse.");
    expect(result.unresolvedIssues).toEqual([]);
  });
});
