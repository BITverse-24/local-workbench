import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { reviewAgentTaskCoverage } from "../src/main/agent/requirement-review.js";
import { agentWorkspaceActions } from "../src/main/agent/workspace-actions.js";
import { parseTaskInterpretation } from "../src/main/agent/task-interpretation.js";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { addMessage } from "../src/main/persistence/messages.js";
import { createRun } from "../src/main/run/store.js";
import { bindAgentTaskRun, getAgentTask } from "../src/main/run/agent-task-store.js";
import { bindAgentExecutionLedger, getExecutionLedger, initializeExecutionLedger } from "../src/main/run/execution-ledger.js";
import { persistRunContract } from "../src/main/run/contract.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { dataRoot, setDataDir } from "../src/main/run/filesystem.js";
import { withRuntimeScope, type RuntimeScope } from "../src/main/run/runtime-scope.js";
import type { ToolExecutionContext } from "../src/main/tools/types.js";

it.skipIf(!process.env.WORKBENCH_LMSTUDIO_REVIEW_PROBE)("compares literal source delivery with the actual 7B coverage reviewer", async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-review-live-")), previous = dataRoot();
  const workspace = path.join(temporary, "workspace"); mkdirSync(workspace);
  const source = "saved source\n", request = "Read note.txt and report its exact content. Do not edit any file.";
  writeFileSync(path.join(workspace, "note.txt"), source);
  setDataDir(temporary); initDb(path.join(temporary, "db.sqlite"));
  const endpoint = process.env.WORKBENCH_LMSTUDIO_PROBE_ENDPOINT ?? "http://127.0.0.1:1234";
  const gateway = new ModelGateway(undefined, [{ id: "live-driver", runtime: "mlx-lm", baseUrl: `${endpoint.replace(/\/$/, "")}/v1`, model: "qwen2.5-coder-7b-instruct-mlx", capabilities: ["text"], requestTimeoutMs: 60000, healthPath: "/models", enabled: true, contextLength: 8192, toolCallingFormat: "json" }]);
  const chatId = createChat(), runId = createRun(chatId, request), messageId = addMessage({ chat_id: chatId, role: "user", content: request }).id;
  getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,'agent','agent-v3',?)").run(runId, workspace);
  const interpreted = parseTaskInterpretation(JSON.stringify({ disposition: "continue", requirements: [{ kind: "inspect", description: "Read the content of note.txt and report it exactly as is.", source_id: "request", checks: [{ description: "Verify that the content of note.txt is reported exactly as it appears in the file.", kind: "inspection", operation: "verbatim_source", path: "note.txt" }] }], updates: [], full_suite: false }), messageId, request);
  const binding = bindAgentTaskRun({ runId, chatId, messageId, workspace: { root: workspace, registeredAt: "review-probe" }, disposition: "continue", updates: interpreted.updates });
  const contract = persistRunContract({ schemaVersion: 1, runId, createdAt: new Date().toISOString(), objective: request, resolution: { status: "resolved" }, routing: { intentType: "general_qa", taskType: "code", driverModel: "live-driver", actionable: true }, response: { required: true, chatOnly: false }, workspace: { requested: false, operations: [] }, deliverables: [], constraints: { protectedPaths: [], restrictMutationsToTargets: false, userConstraints: [] }, acceptance: { validateWrittenCode: false, validatedPythonDeliverables: [], artifactChecks: [] } });
  initializeExecutionLedger(contract); bindAgentExecutionLedger(binding);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90000);
  const context: ToolExecutionContext = { runId, workspaceRoot: workspace, gateway, resultStore: new RunResultStore(runId), signal: controller.signal };
  const scope: RuntimeScope = { runId, mode: "agent", agentPhase: "actions", signal: controller.signal };
  const cases: Array<{ name: string; answer: string; expected: boolean; result?: unknown; error?: string }> = [
    { name: "byte-identical", answer: source, expected: true },
    { name: "quoted-literal", answer: `\`\`\`\n${source}\`\`\``, expected: true },
    { name: "wrong-content", answer: "different source\n", expected: false },
  ];
  try {
    await withRuntimeScope(scope, async () => {
      scope.agentCountingProfiles = await gateway.prepareAgentCountingProfiles("live-driver", { signal: controller.signal });
      const observed = await agentWorkspaceActions.find(tool => tool.name === "read_file")!.execute({ path: "note.txt" }, context);
      context.resultStore!.registerResult({ ...observed.intermediate!, producer: { tool: "read_file", callId: randomUUID() }, summary: observed.summary });
      for (const item of cases) {
        try { item.result = await reviewAgentTaskCoverage(getAgentTask(binding.taskId)!, context, "live-driver", [], item.answer); }
        catch (error) { item.error = String(error); }
      }
    });
    const store = context.resultStore!;
    const savedResults = store.listResults({ limit: 50 }).map(record => {
      let content = "", offset: number | undefined = 0;
      while (offset !== undefined) { const page = store.retrieveResultSlice(record.resultId, { mode: "text", offset, maxChars: 3000 }); content += page.content; offset = page.nextOffset; }
      return { record, content };
    });
    const proof = { recordedAt: new Date().toISOString(), scope: "Read-only review diagnostic, not a full repair trial", model: "qwen2.5-coder-7b-instruct-mlx", contextLimit: 8192, cases, admissions: getExecutionLedger(runId)?.agentAdmissions, savedResults, sourceUnchanged: readFileSync(path.join(workspace, "note.txt"), "utf8") === source };
    if (process.env.WORKBENCH_AGENT_REVIEW_PROBE_REPORT) writeFileSync(process.env.WORKBENCH_AGENT_REVIEW_PROBE_REPORT, JSON.stringify(proof, null, 2));
    expect(proof.sourceUnchanged).toBe(true);
    for (const item of cases) expect(item.result, JSON.stringify(item)).toMatchObject({ ok: item.expected });
  } finally { clearTimeout(timer); closeDb(); setDataDir(previous); rmSync(temporary, { recursive: true, force: true }); }
}, 100000);
