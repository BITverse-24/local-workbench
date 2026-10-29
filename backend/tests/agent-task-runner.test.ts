import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTaskRunner } from "../src/main/agent/agent-task-runner.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { countLocalAgentRequest } from "../src/main/gateway/local-token-counter.js";
import * as server from "../src/main/gateway/lmstudio-token-counter.js";
import { saveAgentCountingVerification, verifyLocalAgentCounter } from "../src/main/gateway/agent-admission.js";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { addMessage } from "../src/main/persistence/messages.js";
import { createRun, transition } from "../src/main/run/store.js";
import { dataRoot, setDataDir } from "../src/main/run/filesystem.js";
import { getCurrentAgentTask } from "../src/main/run/agent-task-store.js";
import { getExecutionLedger } from "../src/main/run/execution-ledger.js";
import { withRuntimeScope } from "../src/main/run/runtime-scope.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { MutationPolicyGuard } from "../src/main/harness/policy-guard.js";
import { buildExecutionEnvelope } from "../src/main/run/envelope.js";
import { parseTaskInterpretation } from "../src/main/agent/task-interpretation.js";
import { RunManager } from "../src/main/run/manager.js";
import { HarnessManager } from "../src/main/harness/harness-manager.js";
let root: string, previousRoot: string, chatId: string;
const template = "{% for m in messages %}{{m.role}} {{m.content}} EOS {% endfor %}assistant";
type Reply = (payload: any) => unknown;
let replies: Reply[];
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "agent-runner-")); previousRoot = dataRoot(); setDataDir(root); initDb(path.join(root, "db.sqlite")); chatId = createChat(); replies = [];
  writeFileSync(path.join(root, "tokenizer.json"), JSON.stringify({ version: "1.0", added_tokens: [], normalizer: null, decoder: null, post_processor: null, pre_tokenizer: { type: "WhitespaceSplit" }, model: { type: "WordPiece", unk_token: "UNK", vocab: { UNK: 0, user: 1, EOS: 2, assistant: 3, Setup: 4 }, continuing_subword_prefix: "##", max_input_chars_per_word: 200000 } }));
  writeFileSync(path.join(root, "tokenizer_config.json"), JSON.stringify({ chat_template: template })); writeFileSync(path.join(root, "note.txt"), "saved source\n");
  vi.spyOn(server, "countLMStudioPreparedRequest").mockImplementation(async options => { const local = await countLocalAgentRequest({ assetsDir: root, activeTemplate: template, payload: options.payload }); return { inputTokens: local.inputTokens, renderedDigest: local.renderedDigest, instanceReference: "loaded", modelPath: "local", contextLimit: 8192, counterIdentity: "lmstudio-sdk-1.5.0" }; });
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); setDataDir(previousRoot); rmSync(root, { recursive: true, force: true }); });
function interpretation(kind: string, text: string) { return { disposition: "continue", requirements: [{ kind, description: text, quote: text, checks: [{ description: text, kind: "inspection", operation: "semantic", path: null }] }], updates: [], full_suite: false }; }
async function run(text: string, managerPath = false) {
  let runId = managerPath ? "" : createRun(chatId, text);
  const messageId = addMessage({ chat_id: chatId, role: "user", content: text }).id;
  if (!managerPath) getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,'agent','agent-v3',?)").run(runId, root);
  const verification = await verifyLocalAgentCounter({ binding: { endpoint: "http://127.0.0.1:1234/v1", modelIdentity: "loaded", providerModel: "driver", transport: "json", templateDigest: createHash("sha256").update(template).digest("hex"), contextLimit: 8192 }, assetsDir: root, activeTemplate: template, probes: (["plain", "tools", "tool_result", "unicode"] as const).map(name => ({ name, payload: { model: "driver", messages: [{ role: "user", content: "Setup" }] } })), providerProbe: async () => ({ inputTokens: 4 }) });
  saveAgentCountingVerification(verification);
  const gateway = new ModelGateway({ async request(_url, init) {
    const payload = JSON.parse(init.body!), title = String(payload.messages?.[0]?.content).includes("short chat topic title");
    const answer = title ? () => "Inspect saved source" : replies.shift();
    if (!answer) throw new Error("Unexpected model generation");
    const input = await countLocalAgentRequest({ assetsDir: root, activeTemplate: template, payload });
    const content = answer(payload);
    return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: input.inputTokens, completion_tokens: 30 } }) };
  } }, [{ id: "driver", runtime: "mlx-lm", baseUrl: "http://127.0.0.1:1234/v1", model: "driver", capabilities: ["text"], toolCallingFormat: "json", requestTimeoutMs: 1000, healthPath: "/models", enabled: true, contextLength: 8192 }]);
  vi.spyOn(gateway, "prepareAgentCountingProfiles").mockResolvedValue([{ assetsDir: root, activeTemplate: template, verification }]);
  const approve = vi.fn(async () => true), emit = vi.fn();
  if (managerPath) {
    const manager = new RunManager(gateway, emit, undefined, { agentV3Preview: true });
    const harness = new HarnessManager(); harness.registerWorkspace(root); manager.setHarness(harness);
    const started = await manager.start({ chatId, userMessageId: messageId, userText: text, mode: "agent", selectedModel: "driver" }); runId = started.runId;
    await vi.waitFor(() => expect(["completed", "partial", "failed", "cancelled"]).toContain(manager.getRunSnapshot({ runId })?.state), { timeout: 10000 });
    const snapshot = manager.getRunSnapshot({ runId })!;
    const answer = getDb().prepare("SELECT content FROM messages WHERE run_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1").get(runId) as { content: string };
    return { result: { outcome: snapshot.state, stopReason: getExecutionLedger(runId)?.agentProgress?.stopReason, text: answer.content }, runId, approve, emit, snapshot, manager };
  }
  const result = await withRuntimeScope({ runId, mode: "agent", signal: new AbortController().signal }, () => new AgentTaskRunner().run({ modelId: "driver", chatId, messageId, workspace: { root, registeredAt: "first" }, approve, state: state => { if (getDb().prepare("SELECT state FROM runs WHERE id=?").get(runId)) transition(runId, state); }, context: { runId, workspaceRoot: root, gateway, resultStore: new RunResultStore(runId), policyGuard: new MutationPolicyGuard(), envelope: buildExecutionEnvelope({ runId, mode: "agent", modelId: "driver", hasWorkspace: true, workspaceRoot: root }), emitRunEvent: emit } }));
  transition(runId, result.outcome === "completed" ? "completed" : result.outcome === "cancelled" ? "cancelled" : "partial");
  return { result, runId, approve, emit, manager: undefined };
}
describe("Agent v3 task host loop", () => {
  it("explicitly resumes the saved v3 contract, task, and call budget without repeating interpretation", async () => {
    const text = "Inspect note.txt";
    const covered = (payload: any) => {
      const state = JSON.parse(payload.messages[1].content);
      return { covered: true, missing: [], requirements: state.requirements.map((item: any) => ({ id: item.id, satisfied: true, reason: "Inspected source" })) };
    };
    replies = [() => interpretation("inspect", text), () => "Advice without an inspection.", covered, () => "More advice."];
    const first = await run(text, true);
    expect(first.result.outcome).toBe("partial");
    const before = getExecutionLedger(first.runId)!;
    const task = getCurrentAgentTask(chatId)!;
    expect(before.agentProgress?.reads).toHaveLength(0);
    replies = [() => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "saved source", covered];
    await first.manager!.resume(first.runId);
    await vi.waitFor(() => expect(first.manager!.getRunSnapshot({ runId: first.runId })?.state).toBe("completed"), { timeout: 10000 });
    const after = getExecutionLedger(first.runId)!;
    expect(after.agentTask?.modelCalls).toBe(before.agentTask!.modelCalls + 3);
    expect(after.resumeCount).toBe(1);
    expect(after.agentTask?.taskId).toBe(task.taskId);
    expect(getCurrentAgentTask(chatId)?.snapshot.revision).toBe(task.snapshot.revision);
    expect(after.agentAdmissions.filter(item => item.phase === "requirements")).toHaveLength(1);
  });
  it.skipIf(!process.env.WORKBENCH_LMSTUDIO_RUNNER_PROBE)("runs an actual 7B inspection through the new loop without workspace mutations", async () => {
    vi.restoreAllMocks();
    const endpoint = process.env.WORKBENCH_LMSTUDIO_PROBE_ENDPOINT ?? "http://127.0.0.1:1234";
    const gateway = new ModelGateway(undefined, [{ id: "live-driver", runtime: "mlx-lm", baseUrl: `${endpoint.replace(/\/$/, "")}/v1`, model: "qwen2.5-coder-7b-instruct-mlx", capabilities: ["text"], requestTimeoutMs: 60000, healthPath: "/models", enabled: true, contextLength: 8192, toolCallingFormat: "json" }]);
    const text = "Read note.txt and report its exact content. Do not edit any file.";
    const runId = createRun(chatId, text), messageId = addMessage({ chat_id: chatId, role: "user", content: text }).id;
    getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,'agent','agent-v3',?)").run(runId, root);
    const approve = vi.fn(async () => false), controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const result = await withRuntimeScope({ runId, mode: "agent", signal: controller.signal }, () => new AgentTaskRunner().run({ modelId: "live-driver", chatId, messageId, workspace: { root, registeredAt: "live" }, approve, state: state => transition(runId, state), context: { runId, workspaceRoot: root, gateway, resultStore: new RunResultStore(runId), policyGuard: new MutationPolicyGuard(), envelope: buildExecutionEnvelope({ runId, mode: "agent", modelId: "live-driver", hasWorkspace: true, workspaceRoot: root }) } }));
      const store = new RunResultStore(runId);
      const records = store.listResults({ limit: 50 });
      for (let offset = 50; records.length === offset; offset += 50) records.push(...store.listResults({ limit: 50, offset }));
      const savedResults = records.map(record => {
        let content = "", offset: number | undefined = 0;
        while (offset !== undefined) { const page = store.retrieveResultSlice(record.resultId, { mode: "text", offset, maxChars: 3000 }); content += page.content; offset = page.nextOffset; }
        return { record, content };
      });
      const proof = { recordedAt: new Date().toISOString(), model: "qwen2.5-coder-7b-instruct-mlx", contextLimit: 8192, result, admissions: getExecutionLedger(runId)?.agentAdmissions, progress: getExecutionLedger(runId)?.agentProgress, requirements: getCurrentAgentTask(chatId)?.snapshot.requirements, approvalRequests: approve.mock.calls.length, savedResults };
      if (process.env.WORKBENCH_AGENT_RUNNER_PROBE_REPORT) writeFileSync(process.env.WORKBENCH_AGENT_RUNNER_PROBE_REPORT, JSON.stringify(proof, null, 2));
      expect(result.outcome, result.text).toBe("completed"); expect(result.text).toContain("saved source"); expect(approve).not.toHaveBeenCalled();
      expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("saved source\n");
    } finally { clearTimeout(timeout); }
  }, 120000);
  it("routes an opted-in preview through RunManager and exposes the durable task snapshot", async () => {
    const text = "Inspect note.txt";
    replies = [() => interpretation("inspect", text), () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "Inspected the saved source.", payload => {
      const state = JSON.parse(payload.messages[1].content); return { covered: true, missing: [], requirements: state.requirements.map((item: any) => ({ id: item.id, satisfied: true, reason: "Source evidence saved" })) };
    }];
    const { result, runId, snapshot } = await run(text, true);
    expect(result.outcome, result.text).toBe("completed");
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(4);
    expect(getCurrentAgentTask(chatId)?.status).toBe("completed");
    expect(snapshot?.agentV3Available).toBe(true);
  });
  it("keeps task continuity visible after a Chat run and does not enable v3 from historical engine data", async () => {
    const text = "Inspect note.txt";
    replies = [() => interpretation("inspect", text), () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "saved source", payload => {
      const state = JSON.parse(payload.messages[1].content); return { covered: true, missing: [], requirements: state.requirements.map((item: any) => ({ id: item.id, satisfied: true, reason: "Source read" })) };
    }];
    const first = await run(text, true), taskId = getCurrentAgentTask(chatId)!.taskId;
    const question = "Give a short explanation.", messageId = addMessage({ chat_id: chatId, role: "user", content: question }).id;
    replies = [() => "A direct Chat answer."];
    const next = await first.manager!.start({ chatId, userMessageId: messageId, userText: question, mode: "chat", selectedModel: "driver" });
    await vi.waitFor(() => expect(first.manager!.getRunSnapshot({ runId: next.runId })?.state).toBe("completed"), { timeout: 10000 });
    expect(first.manager!.getRunSnapshot({ runId: next.runId })).toMatchObject({ mode: "chat", agentV3Available: true, agentTask: { taskId } });
    const closed = new RunManager(first.manager!.getGateway());
    expect(closed.getRunSnapshot({ runId: first.runId })).toMatchObject({ engineVersion: "agent-v3", agentV3Available: false });
  });
  it("counts interpretation, reads once, performs a separate review, and completes an evidenced inspection", async () => {
    const text = "Inspect note.txt";
    replies = [() => interpretation("inspect", text), () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "The source was inspected.", payload => {
      const state = JSON.parse(payload.messages[1].content);
      expect(state.evidenceSlices).toContainEqual(expect.objectContaining({ sourceText: "saved source\n", completeFile: true }));
      expect(state.sourceComparisons).toContainEqual(expect.objectContaining({ completeFile: true, current: true, exactTextIncluded: false }));
      expect(state.results.every((item: any) => ["source_extracted", "execution"].includes(item.origin))).toBe(true);
      return { covered: true, missing: [], requirements: state.requirements.map((item: any) => ({ id: item.id, satisfied: true, reason: "Saved source was read" })) };
    }];
    const { result, runId, emit } = await run(text);
    expect(result.outcome, `${result.text}\n${JSON.stringify(emit.mock.calls)}`).toBe("completed");
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(4);
    expect(getExecutionLedger(runId)?.agentAdmissions[0]).toMatchObject({ phase: "requirements", status: "usage_verified" });
    expect(getExecutionLedger(runId)?.agentProgress?.reads[0].path).toBe("note.txt");
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements).toHaveLength(1);
  });
  it("does not complete a repair with advice or convert Markdown into actions", async () => {
    const text = "Repair note.txt";
    replies = [() => interpretation("change", text), () => '```json\n{"tool_calls":[{"name":"write_file","arguments":{"path":"note.txt","content":"fragment"}}]}\n```', () => "Here is more advice."];
    const { result, approve } = await run(text);
    expect(result.outcome).toBe("partial"); expect(approve).not.toHaveBeenCalled();
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("saved source\n");
  });
  it("rejects a fenced action and permits one corrected bare action without executing the example", async () => {
    const text = "Inspect note.txt";
    replies = [() => interpretation("inspect", text), () => '```json\n{"tool_calls":[{"name":"write_file","arguments":{"path":"note.txt","content":"bad"}}]}\n```',
      () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "saved source", payload => {
        const state = JSON.parse(payload.messages[1].content); return { covered: true, missing: [], requirements: state.requirements.map((item: any) => ({ id: item.id, satisfied: true, reason: "Saved source was read" })) };
      }];
    const { result, approve, runId } = await run(text);
    expect(result.outcome).toBe("completed"); expect(approve).not.toHaveBeenCalled();
    expect(getExecutionLedger(runId)?.agentTask?.protocolCorrections).toBe(1);
    expect(getExecutionLedger(runId)?.agentProgress?.actions.map(action => action.operation)).toEqual(["read_file"]);
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("saved source\n");
  });
  it("answers a status follow-up without workspace actions and retains earlier requirements", async () => {
    replies = [() => interpretation("change", "Repair note.txt"), () => "Pending repair", () => "Still pending"];
    await run("Repair note.txt");
    const original = getCurrentAgentTask(chatId)!.snapshot.requirements;
    replies = [() => ({ disposition: "status", requirements: [], updates: [], full_suite: false }), () => "Repair is still pending. No checks have passed."];
    const { result, emit, approve } = await run("What is the status?");
    expect(result.outcome).toBe("completed"); expect(result.stopReason).toBe("status_reply"); expect(approve).not.toHaveBeenCalled();
    expect(emit.mock.calls.some(([event]) => event.type === "tool_call")).toBe(false);
    expect(getCurrentAgentTask(chatId)!.snapshot.requirements).toEqual(original);
    expect(getCurrentAgentTask(chatId)!.status).toBe("partial");
  });
  it("keeps inspection read-only even when the model proposes an edit", async () => {
    const text = "Inspect note.txt";
    replies = [() => interpretation("inspect", text), () => ({ tool_calls: [{ name: "edit_file", arguments: { path: "note.txt", expected_digest: "0".repeat(64), replacements: [{ old: "source", new: "broken" }] } }] })];
    const { result, approve } = await run(text);
    expect(result.stopReason).toBe("read_only_task"); expect(approve).not.toHaveBeenCalled();
  });
  it("corrects literal delivery from saved evidence without another read and audits scope separately", async () => {
    const text = "Read note.txt and report its exact content.";
    replies = [() => ({ disposition: "continue", requirements: [{ kind: "inspect", description: text, quote: text, checks: [{ description: text, kind: "inspection", operation: "verbatim_source", path: "note.txt" }] }], updates: [], full_suite: false }),
      () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "saved source", () => "```\nsaved source\n```", payload => {
        const input = JSON.parse(payload.messages[1].content);
        expect(input.hostVerifiedChecks).toContainEqual(expect.objectContaining({ passed: true, path: "note.txt" }));
        return { covered: true, missing: [] };
      }];
    const { result, runId, approve } = await run(text);
    expect(result.outcome, result.text).toBe("completed"); expect(approve).not.toHaveBeenCalled();
    expect(getExecutionLedger(runId)?.agentProgress?.actions.map(action => action.operation)).toEqual(["read_file"]);
    expect(getExecutionLedger(runId)?.agentProgress?.deliveryAttempts).toHaveLength(2);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(5);
  });
  it("stops a repeated literal delivery proposal without repeatedly reading unchanged source", async () => {
    const text = "Read note.txt and report its exact content.";
    replies = [() => ({ disposition: "continue", requirements: [{ kind: "inspect", description: text, quote: text, checks: [{ description: text, kind: "inspection", operation: "verbatim_source", path: "note.txt" }] }], updates: [], full_suite: false }),
      () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "wrong content", () => "wrong content"];
    const { result, runId } = await run(text);
    expect(result.outcome).toBe("partial"); expect(result.stopReason).toBe("repeated_delivery");
    expect(getExecutionLedger(runId)?.agentProgress?.actions).toHaveLength(1);
  });
  it("keeps an approved observed edit and returns Partial when mandatory project tests are unavailable", async () => {
    const text = "Read note.txt, replace source with content, and run existing tests.";
    const digest = createHash("sha256").update("saved source\n").digest("hex");
    replies = [() => ({ disposition: "continue", requirements: ["inspect", "change", "execute"].map(kind => ({ kind, description: kind, quote: text, checks: [{ description: kind, kind: kind === "execute" ? "execution" : "inspection", operation: "semantic", path: null }] })), updates: [], full_suite: false }),
      () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }),
      () => ({ tool_calls: [{ name: "edit_file", arguments: { path: "note.txt", expected_digest: digest, replacements: [{ old: "source", new: "content" }] } }] }),
      () => ({ tool_calls: [{ name: "finish", arguments: { text: "The edit is saved. Tests are still required." } }] })];
    const { result, runId, approve } = await run(text);
    expect(result.outcome, result.text).toBe("partial"); expect(result.stopReason).toBe("checks_unavailable");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("saved content\n");
    expect(getExecutionLedger(runId)?.completedOperations.some(item => item.tool === "edit_file")).toBe(true);
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements).toHaveLength(3);
  });
  it("permits one malformed-action correction and never executes either multi-action response", async () => {
    const text = "Inspect note.txt", calls = { tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }, { name: "write_file", arguments: { path: "other.txt", content: "bad" } }] };
    replies = [() => interpretation("inspect", text), () => calls, () => calls];
    const { result, emit } = await run(text);
    expect(result.stopReason).toBe("malformed_action"); expect(emit.mock.calls.some(([event]) => event.type === "tool_call")).toBe(false);
  });
  it("retains mixed requirement kinds and rejects fabricated source quotes", () => {
    const text = "Inspect, reproduce, repair both bugs, preserve behavior, and run the full suite.";
    const parsed = parseTaskInterpretation(JSON.stringify({ disposition: "continue", requirements: ["inspect", "execute", "change", "preserve", "deliver"].map(kind => ({ kind, description: kind, quote: text, checks: [{ description: kind, kind: "review", operation: "semantic", path: null }] })), updates: [], full_suite: true }), "11111111-1111-4111-8111-111111111111", text);
    expect(parsed.updates).toHaveLength(5); expect(parsed.fullSuite).toBe(true);
    expect(() => parseTaskInterpretation(JSON.stringify(interpretation("change", "Invented instruction")), "11111111-1111-4111-8111-111111111111", text)).toThrow("exact span");
  });
});
