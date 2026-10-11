import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { addMessage } from "../src/main/persistence/messages.js";
import { createRun, getState } from "../src/main/run/store.js";
import { createRunDirectories, runRoot, setDataDir, writeRunFile, artifactRef } from "../src/main/run/filesystem.js";
import { getRunContract, normalizeRunContract } from "../src/main/run/contract.js";
import { resolveArtifactTransfer } from "../src/main/run/artifact-transfer.js";
import { verifyRunEvidence } from "../src/main/run/verification.js";
import { ModelGateway, extractEmbeddedToolCalls } from "../src/main/gateway/model-gateway.js";
import { RunManager } from "../src/main/run/manager.js";
import { HarnessManager } from "../src/main/harness/harness-manager.js";
import { validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";
import { generateDeliverableTool } from "../src/main/tools/specialist-tools.js";
import { extractDocxText } from "../src/main/tools/document-reader.js";
import { writeFileTool } from "../src/main/tools/workspace-tools.js";
import { composeTools, constrainToolsToIntent } from "../src/main/router/tool-compositor.js";
import { AgentLoop } from "./helpers/agent-loop-fixture.js";
import type { RunEvent } from "../src/shared/contracts.js";

let dir: string, workspace: string, previousEngine: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "artifact-transfer-")); workspace = path.join(dir, "workspace"); mkdirSync(workspace);
  setDataDir(dir); initDb(path.join(dir, "db.sqlite"));
  previousEngine = process.env.WORKBENCH_AGENT_V2; process.env.WORKBENCH_AGENT_V2 = "true";
});
afterEach(() => {
  closeDb(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true });
  if (previousEngine === undefined) delete process.env.WORKBENCH_AGENT_V2; else process.env.WORKBENCH_AGENT_V2 = previousEngine;
});
const originalRequest = "Now add this file into the workspace. Either by moving it or by creating new file with exact content into workspace";
function saveSource(chatId: string, filename: string, content: Buffer | string, existingRun?: string) {
  const runId = existingRun ?? createRun(chatId, "Create saved artifact"); createRunDirectories(runId);
  const artifact = artifactRef(runId, filename.endsWith(".docx") ? "docx" : "md", filename, writeRunFile(runId, "output", filename, content));
  getDb().prepare("INSERT INTO artifacts(artifact_id,run_id,kind,filename,relative_path,size_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(artifact.artifactId, runId, artifact.kind, filename, artifact.relativePath, artifact.sizeBytes, artifact.sha256, artifact.createdAt);
  return artifact;
}
function setup() {
  const gateway = new ModelGateway();
  const classify = vi.spyOn(gateway, "execute").mockRejectedValue(new Error("Copy must not classify"));
  const generate = vi.spyOn(gateway, "chatWithTools").mockRejectedValue(new Error("Copy must not generate"));
  const events: RunEvent[] = []; const manager = new RunManager(gateway, event => events.push(event));
  const harness = new HarnessManager(); harness.registerWorkspace(workspace); manager.setHarness(harness);
  return { manager, gateway, classify, generate, events, harness };
}
async function pending(manager: RunManager, runId: string) {
  await vi.waitFor(() => expect(manager.getRunSnapshot({ runId })?.pendingAction).toBeDefined());
  return manager.getRunSnapshot({ runId })!.pendingAction!;
}
async function terminal(runId: string) {
  await vi.waitFor(() => expect(["completed", "partial", "failed", "cancelled"]).toContain(getState(runId)));
}

describe("Saved artifact workspace transfer", () => {
  it.each(["HelloWorld.md", "engineering-notes.md", "binary.docx"])("copies %s exactly after approval, without an extra export or model call", async filename => {
    const content = filename.endsWith(".docx") ? Buffer.from([0x50, 0x4b, 0, 0xff, 0x80, 10]) : Buffer.from("\ufeff# Hello, World!\r\nExact source.\r\n");
    const chatId = createChat(); const source = saveSource(chatId, filename, content);
    addMessage({ chat_id: chatId, role: "user", content: "Make an md artifact with the text 'Hello, World!'", run_id: source.runId });
    addMessage({ chat_id: chatId, role: "assistant", content: `${filename} saved. All required checks passed.`, run_id: source.runId });
    const { manager, classify, generate, events } = setup();
    const { runId } = await manager.start({ chatId, mode: "agent", userText: originalRequest });
    const action = await pending(manager, runId);
    const contract = getRunContract(runId)!;
    expect(contract.deliverables).toEqual([]); expect(contract.workspace.operations).toHaveLength(1);
    expect(contract.workspace.operations[0]).toMatchObject({ operation: "write", targetPath: filename, sourceId: source.artifactId, sourceSha256: source.sha256 });
    expect(action.prompt).toContain(filename); expect(action.prompt).not.toContain("generate_deliverable");
    expect(existsSync(path.join(workspace, filename))).toBe(false);
    await manager.confirm({ runId, actionId: action.actionId, approved: true }); await terminal(runId);
    expect(getState(runId)).toBe("completed"); expect(readFileSync(path.join(workspace, filename))).toEqual(content);
    expect(readFileSync(path.join(dir, source.relativePath))).toEqual(content);
    expect(manager.getRunSnapshot({ runId })!.artifacts).toEqual([]);
    expect(events.some(event => event.type === "tool_call" && event.tool === "generate_deliverable")).toBe(false);
    expect(classify).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    expect(manager.getRunSnapshot({ runId })!.verification?.checks.find(check => check.criterionId === "workspace:workspace-1")?.method).toBe("sha256");
    writeFileSync(path.join(workspace, filename), "tampered");
    expect(verifyRunEvidence(runId)?.checks.find(check => check.criterionId === "workspace:workspace-1")?.status).toBe("failed");
  });

  it("preserves the existing workspace file in a backup and uses an explicit destination", async () => {
    const chatId = createChat(); saveSource(chatId, "draft.md", "exact copy");
    mkdirSync(path.join(workspace, "docs")); writeFileSync(path.join(workspace, "docs/final.md"), "previous file");
    const { manager } = setup(); const { runId } = await manager.start({ chatId, mode: "agent", userText: "Copy draft.md into the workspace as docs/final.md" });
    const action = await pending(manager, runId); await manager.confirm({ runId, actionId: action.actionId, approved: true }); await terminal(runId);
    expect(getState(runId)).toBe("completed"); expect(readFileSync(path.join(workspace, "docs/final.md"), "utf8")).toBe("exact copy");
    // The writer records the actual backup path in its persisted tool output.
    const ledger = JSON.parse((getDb().prepare("SELECT ledger_json FROM run_execution_ledgers WHERE run_id=?").get(runId) as any).ledger_json);
    expect(ledger.operationAttempts[0].status).toBe("completed"); expect(existsSync(path.join(workspace, ".harness_backups"))).toBe(true);
    const backup = readdirSync(path.join(workspace, ".harness_backups"))[0];
    expect(readFileSync(path.join(workspace, ".harness_backups", backup, "docs/final.md"), "utf8")).toBe("previous file");
  });

  it.each(["denied", "changed-input", "changed-workspace", "cancelled", "symlink"])("does not write when %s", async problem => {
    const chatId = createChat(); saveSource(chatId, "source.md", "exact source");
    const { manager, harness } = setup();
    if (problem === "symlink") { const outside = path.join(dir, "outside.md"); writeFileSync(outside, "untouched"); symlinkSync(outside, path.join(workspace, "source.md")); }
    const { runId } = await manager.start({ chatId, mode: "agent", userText: "Copy this file into the workspace" });
    const action = await pending(manager, runId);
    if (problem === "changed-input") writeFileSync(path.join(runRoot(runId), "input/source.md"), "changed bytes");
    if (problem === "changed-workspace") { const other = path.join(dir, "other"); mkdirSync(other); harness.registerWorkspace(other); }
    if (problem === "cancelled") manager.cancel(runId);
    else await manager.confirm({ runId, actionId: action.actionId, approved: problem !== "denied" });
    await terminal(runId); expect(getState(runId)).not.toBe("completed");
    if (problem === "symlink") expect(readFileSync(path.join(dir, "outside.md"), "utf8")).toBe("untouched");
    else expect(existsSync(path.join(workspace, "source.md"))).toBe(false);
  });

  it("does not select another chat's source or guess between multiple previous artifacts", async () => {
    saveSource(createChat(), "secret.md", "private"); const chatId = createChat(); const { manager, classify } = setup();
    const { runId } = await manager.start({ chatId, mode: "agent", userText: "Copy this file into the workspace" }); await terminal(runId);
    expect(getState(runId)).toBe("failed"); expect(classify).not.toHaveBeenCalled();
    const first = saveSource(chatId, "one.md", "one"); saveSource(chatId, "two.md", "two", first.runId);
    const next = await manager.start({ chatId, mode: "agent", userText: "Copy this file into the workspace" }); await terminal(next.runId);
    expect(getState(next.runId)).toBe("failed"); expect(existsSync(path.join(workspace, "one.md"))).toBe(false);
  });
  it("prefers the attached input ID over an older artifact with the same name", async () => {
    const chatId = createChat(); saveSource(chatId, "source.md", "older output");
    const { manager, classify, generate } = setup();
    const upload = manager.registerAttachment({ chatId, filename: "source.md", mediaType: "text/markdown", sizeBytes: 12, base64OrBuffer: Buffer.from("new attached") });
    const { runId } = await manager.start({ chatId, mode: "agent", userText: "Copy this file into the workspace", attachmentToken: upload.attachment.attachmentId });
    const action = await pending(manager, runId);
    expect(getRunContract(runId)!.workspace.operations[0].sourceId).toBe(upload.attachment.attachmentId);
    await manager.confirm({ runId, actionId: action.actionId, approved: true }); await terminal(runId);
    expect(getState(runId)).toBe("completed"); expect(readFileSync(path.join(workspace, "source.md"), "utf8")).toBe("new attached");
    expect(classify).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });
  it("rejects a saved artifact that changed before it was staged", async () => {
    const chatId = createChat(); const source = saveSource(chatId, "source.md", "original bytes");
    writeFileSync(path.join(dir, source.relativePath), "tampered");
    const { manager, classify, generate } = setup();
    const { runId } = await manager.start({ chatId, mode: "agent", userText: "Copy this file into the workspace" }); await terminal(runId);
    expect(getState(runId)).toBe("failed"); expect(existsSync(path.join(workspace, "source.md"))).toBe(false);
    expect(classify).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });
});

describe("Intent and generator request boundaries", () => {
  const raw = { requestedAction: "draft", responseMode: "chat_and_files", primaryGoal: "Workspace edits", workspaceMutationRequested: true,
    targetFiles: ["module.py"], workspaceOperations: [{ operation: "write", targetPath: "module.py" }], expectedDeliverables: [{ filename: "invented.docx", type: "docx" }] };
  it.each([originalRequest, "Fix module.py in my workspace", "Write newfile.txt in the workspace"])("removes unrequested exports from %s", prompt => {
    const intent = validateAndNormalizeIntent(raw, { hasWorkspace: true, workspaceFiles: [], userPrompt: prompt });
    expect(intent.expectedDeliverables).toEqual([]); expect(intent.workspaceMutationRequested).toBe(true); expect(intent.status).toBe("resolved");
  });
  it("retains an additional explicit export and honors an explicit output filename", () => {
    const intent = validateAndNormalizeIntent(raw, { hasWorkspace: true, workspaceFiles: [], userPrompt: "Fix module.py in my workspace and export a Word report" });
    expect(intent.expectedDeliverables).toHaveLength(1);
    const source = validateAndNormalizeIntent({ ...raw, workspaceMutationRequested: false }, { hasWorkspace: false, workspaceFiles: [], userPrompt: "Save the example to example.py" });
    expect(source.expectedDeliverables[0]).toMatchObject({ filename: "example.py", type: "file", filenameRequired: true });
  });
  it("applies the same boundary to a legacy classifier response", () => {
    const intent = validateAndNormalizeIntent({ intentType: "document_drafting", taskType: "draft", primaryGoal: "Workspace edits", isActionable: true,
      chatResponseOnly: false, workspaceMutationRequested: true, targetFiles: ["module.py"], expectedDeliverables: [{ type: "docx", filename: "invented.docx" }] },
    { hasWorkspace: true, workspaceFiles: [], userPrompt: "Fix module.py in my workspace" });
    expect(intent.expectedDeliverables).toEqual([]); expect(intent.intentType).toBe("code_modification");
  });
  it("preserves the explicitly requested Markdown format when a classifier selects Word", () => {
    const intent = validateAndNormalizeIntent({ ...raw, workspaceMutationRequested: false, targetFiles: [], workspaceOperations: [] },
      { hasWorkspace: false, workspaceFiles: [], userPrompt: "Make an md artifact with the text 'Hello, World!'" });
    expect(intent.expectedDeliverables[0]).toMatchObject({ type: "md", filename: "invented.md" });
  });
  it.each(["Do not generate a DOCX, just fix module.py in the workspace", "Fix module.py in my workspace. No new artifacts.", "Fix module.py without a Word document"])("honors an explicit export exclusion: %s", prompt => {
    const intent = validateAndNormalizeIntent(raw, { hasWorkspace: true, workspaceFiles: [], userPrompt: prompt });
    expect(intent.expectedDeliverables).toEqual([]); expect(intent.workspaceMutationRequested).toBe(true);
  });
  it("never increases a legacy chat-only classification's authority", () => {
    const intent = validateAndNormalizeIntent({ intentType: "document_drafting", primaryGoal: "Answer", chatResponseOnly: true, isActionable: false,
      workspaceMutationRequested: true, targetFiles: ["module.py"], expectedDeliverables: [{ type: "docx" }] },
    { hasWorkspace: true, workspaceFiles: [], userPrompt: "Fix module.py in the workspace" });
    expect(intent.workspaceMutationRequested).toBe(false); expect(intent.isActionable).toBe(false);
  });
  it("exposes a general drafting schema without inspection report rows", () => {
    const tools = composeTools({ hasWorkspace: false, hasAttachments: true, hasKnowledgeBaseDocs: false }, "primary-model");
    const schema = tools.find(tool => tool.name === "generate_deliverable")!.definition.function.parameters;
    expect(schema.properties).toHaveProperty("content");
    expect(schema.properties).not.toHaveProperty("report_rows");
    expect(schema.required).not.toContain("report_rows");
  });
  it.each([undefined, [], null])("drafts a sourced document without a report table when optional rows are %j", async report_rows => {
    const runId = createRun(createChat(), "Create document"); createRunDirectories(runId);
    const context = { runId, workspaceRoot: workspace, gateway: new ModelGateway(), sourceReferences: [{ filename: "source.pdf", page: 1 }, { filename: "source.pdf", page: 2 }] };
    const args = { type: "docx", filename: "plain.docx", content: "# Letter\nThank you for the proposal.", ...(report_rows !== undefined ? { report_rows } : {}) };
    const result = await generateDeliverableTool.execute(args, context);
    const text = (await extractDocxText(path.join(dir, result.artifacts![0].relativePath))).text;
    expect(text).toContain("Thank you for the proposal.");
    expect(text).toContain("source.pdf, page 1");
    expect(text).toContain("source.pdf, page 2");
    expect(text).not.toContain("inspector_notes");
    expect(text).not.toContain("equipment");
    expect(args).toEqual({ type: "docx", filename: "plain.docx", content: "# Letter\nThank you for the proposal.", ...(report_rows !== undefined ? { report_rows } : {}) });
  });
  it("allows empty optional report rows for plain documents without sources", async () => {
    const runId = createRun(createChat(), "Create document"); createRunDirectories(runId);
    const result = await generateDeliverableTool.execute({ type: "docx", filename: "plain.docx", content: "Hello, World!", report_rows: [] },
      { runId, workspaceRoot: workspace, gateway: new ModelGateway() });
    expect((await extractDocxText(path.join(dir, result.artifacts![0].relativePath))).text).toContain("Hello, World!");
  });
  it.each([{ report_rows: [{}] }, { report_rows: [{ source: "" }] }, { report_rows: "invalid" }])("rejects malformed non-empty legacy rows: %j", async ({ report_rows }) => {
    const runId = createRun(createChat(), "Create document"); createRunDirectories(runId);
    await expect(generateDeliverableTool.execute({ type: "docx", filename: "plain.docx", content: "Hello", report_rows },
      { runId, workspaceRoot: workspace, gateway: new ModelGateway() }))
      .rejects.toMatchObject({ code: "invalid_arguments" });
    expect(readdirSync(path.join(runRoot(runId), "output"))).toEqual([]);
  });
  it("rejects a forged export at execution even if the tool was exposed", async () => {
    const runId = createRun(createChat(), "Fix source"); createRunDirectories(runId);
    const intent = validateAndNormalizeIntent(raw, { hasWorkspace: true, workspaceFiles: [], userPrompt: "Fix module.py in my workspace" });
    await expect(generateDeliverableTool.execute({ type: "docx", filename: "invented.docx", content: "Hello" }, {
      runId, workspaceRoot: workspace, gateway: new ModelGateway(), runContract: normalizeRunContract(runId, intent),
    })).rejects.toMatchObject({ code: "permission_denied" });
    const environment = { hasWorkspace: true, hasAttachments: false, hasKnowledgeBaseDocs: false };
    const contract = normalizeRunContract(runId, intent);
    expect(constrainToolsToIntent(composeTools(environment, "primary-model"), { ...intent, intentType: "document_drafting" }, contract, environment).some(tool => tool.name === "generate_deliverable")).toBe(false);
  });
});

describe("Fallback tool-call recovery", () => {
  const call = { name: "generate_deliverable", arguments: { type: "docx", filename: "greeting.docx", content: "Hello, World!", report_rows: [] } };
  it("decodes the exact recorded retry shape without losing string escapes", () => {
    const raw = "Understood. I'll correct the JSON and try again.\n" + JSON.stringify({ tool_calls: [call] });
    expect(extractEmbeddedToolCalls(raw, true).toolCalls[0]).toMatchObject(call);
    expect(extractEmbeddedToolCalls(raw).toolCalls).toEqual([]);
  });
  it.each([false, true])("delivers a requested DOCX from fallback JSON with empty rows (sourced: %s)", async sourced => {
    const runId = createRun(createChat(), "Create greeting.docx"); createRunDirectories(runId);
    const narrated = "Understood. I'll correct the JSON and try again.\n" + JSON.stringify({ tool_calls: [call] });
    const request = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: narrated }, finish_reason: "stop" }] }) }));
    const gateway = new ModelGateway({ request }, [{ id: "primary-model", model: "local-text-model", runtime: "mlx-lm", baseUrl: "http://127.0.0.1:1234/v1",
      taskTypes: ["draft"], capabilities: ["text"], toolCallingFormat: "json", requestTimeoutMs: 1000, enabled: true, healthPath: "/models" }]);
    const intent = validateAndNormalizeIntent({ ...rawIntent(), expectedDeliverables: [{ type: "docx", filename: "greeting.docx", filenameRequired: true }] },
      { hasWorkspace: false, workspaceFiles: [], userPrompt: "Create greeting.docx containing Hello, World!" });
    const result = await new AgentLoop().run({ runId, driverModelId: "primary-model", userPrompt: "Create greeting.docx containing Hello, World!", systemPrompt: "Create the requested file",
      tools: [generateDeliverableTool], runContract: normalizeRunContract(runId, intent), context: { runId, workspaceRoot: workspace, gateway,
        ...(sourced ? { sourceReferences: [{ filename: "source.pdf", page: 1 }] } : {}) }, emitEvent() {} });
    expect(result.outcome, JSON.stringify(result)).toBe("completed"); expect(request).toHaveBeenCalledTimes(1);
    const text = (await extractDocxText(path.join(runRoot(runId), "output/greeting.docx"))).text;
    expect(text).toContain("Hello, World!");
    if (sourced) expect(text).toContain("source.pdf, page 1");
    expect(text).not.toContain("inspector_notes");
    expect(result.finalText).not.toContain("tool_calls");
  });
  it.each(["truncated", "multiple", "example", "string"])("rejects %s envelopes", kind => {
    const json = JSON.stringify({ tool_calls: [call] });
    const raw = kind === "truncated" ? "Retry\n" + json.slice(0, -3) : kind === "multiple" ? "Retry\n" + json + json
      : kind === "example" ? "Example of a tool request\n" + json : "Retry\n" + JSON.stringify(json);
    expect(extractEmbeddedToolCalls(raw, true).toolCalls).toEqual([]);
  });
  it("reports the actual tool failure after bounded recovery instead of exposing raw retry JSON", async () => {
    const runId = createRun(createChat(), "Create report"); createRunDirectories(runId);
    const intent = validateAndNormalizeIntent({ ...rawIntent(), expectedDeliverables: [{ filename: "report.docx", type: "docx" }] }, { hasWorkspace: false, workspaceFiles: [], userPrompt: "Create report.docx" });
    let turn = 0;
    const gateway = { registry: new Map(), chatWithTools: vi.fn(async () => ({ ok: true, value: turn++ === 0
      ? { content: null, tool_calls: [{ id: "failed", ...call, arguments: { ...call.arguments, filename: "report.docx" } }] }
      : { content: "Understood. I'll correct the JSON and try again.", tool_calls: [] } })) };
    const result = await new AgentLoop().run({ runId, driverModelId: "primary-model", userPrompt: "Create report.docx", systemPrompt: "Create the requested file", runContract: normalizeRunContract(runId, intent),
      tools: [{ ...generateDeliverableTool, async execute() { throw { code: "invalid_arguments", retryable: true, message: "Source citations are missing." }; } }],
      context: { runId, workspaceRoot: workspace, gateway: gateway as any }, emitEvent() {} });
    expect(result.outcome).toBe("failed"); expect(result.finalText).toContain("Source citations are missing.");
    expect(result.finalText).not.toContain("Understood"); expect(result.error?.code).toBe("invalid_arguments"); expect(turn).toBe(5);
  });
});
function rawIntent() { return { requestedAction: "draft", responseMode: "files", primaryGoal: "Create report", workspaceMutationRequested: false }; }

describe("Transfer resolution safety", () => {
  const source = { artifactId: "saved-id", runId: "source-run", filename: "file.md" };
  it("preserves a folder destination", () => expect(resolveArtifactTransfer("Copy this file into workspace/docs", [source])).toEqual({ sourceId: "saved-id", targetPath: "docs/file.md" }));
  it("does not mistake a known destination filename for a second source", () => {
    const other = { artifactId: "other-id", runId: "other-run", filename: "other.md" };
    expect(resolveArtifactTransfer("Copy file.md into the workspace as other.md", [source, other])).toEqual({ sourceId: "saved-id", targetPath: "other.md" });
  });
  it("does not interpret source filenames as extra actions", () => {
    expect(resolveArtifactTransfer("Copy test.py into the workspace", [{ ...source, filename: "test.py" }])).toEqual({ sourceId: "saved-id", targetPath: "test.py" });
  });
  it("does not choose between same-name selected inputs", () => {
    expect(() => resolveArtifactTransfer("Copy file.md into the workspace", [source, { ...source, artifactId: "second-id" }])).toThrow("More than one");
  });
  it.each(["../escape.md", "/tmp/escape.md"])("rejects destination %s", target => expect(() => resolveArtifactTransfer(`Copy this file into workspace as ${target}`, [source])).toThrow());
  it.each(["Copy this file into workspace and also export a Word report", "Copy this file into workspace and delete old.md", "Revise this file and add it to the workspace"])("does not shortcut compound or transformed work: %s", text => expect(resolveArtifactTransfer(text, [source])).toBeUndefined());
  it("does not allow a forged source ID or replacement text for an approved copy", async () => {
    const runId = createRun(createChat(), "Copy"); createRunDirectories(runId);
    const input = path.join(runRoot(runId), "input/file.md"); writeFileSync(input, "real content");
    const sha256 = createHash("sha256").update("real content").digest("hex");
    const context = { runId, workspaceRoot: workspace, gateway: new ModelGateway(), inputSources: [{ id: "saved-id", filename: "file.md", relativePath: `runs/${runId}/input/file.md`, sha256 }] };
    await expect(writeFileTool.execute({ path: "file.md", source_id: "forged-id" }, context)).rejects.toThrow("not an authorized input");
    await expect(writeFileTool.execute({ path: "file.md", source_id: "saved-id", content: "replacement" }, context)).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(existsSync(path.join(workspace, "file.md"))).toBe(false);
  });
});
