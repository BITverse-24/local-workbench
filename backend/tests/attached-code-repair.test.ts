import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSemanticIntent, validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";
import { composeTools, constrainToolsToIntent } from "../src/main/router/tool-compositor.js";
import { createRunDirectories, resolveRunPath } from "../src/main/run/filesystem.js";
import { executePythonTool, generateDeliverableTool } from "../src/main/tools/specialist-tools.js";
import { runCommandTool } from "../src/main/tools/workspace-tools.js";
import { AgentLoop } from "../src/main/agent/agent-loop.js";
import { RunManager } from "../src/main/run/manager.js";
import { HarnessManager } from "../src/main/harness/harness-manager.js";
import { closeDb, initDb } from "../src/main/persistence/db.js";

const attachment = { attachmentId: "source", filename: "broken-reader.py", mediaType: "text/x-python-script", sizeBytes: 30, relativePath: "runs/source/input/broken-reader.py" };
const prompt = "This is crashing on our input files. Fix it and make sure it actually works.";
const code = 'def read(path):\n    with open(path) as handle:\n        return handle.read().strip()\n';
const attachedRepairIntent = {
  intentType: "code_modification", primaryGoal: "Repair attached source", driverModel: "code-qwen25coder", taskType: "code",
  isActionable: true, chatResponseOnly: false, workspaceMutationRequested: false, targetFiles: [], protectedPaths: [],
  restrictMutationsToTargets: false,
  expectedDeliverables: [{ filename: "fixed-reader.py", type: "file", description: "Corrected attached source" }],
  reason: "Attached Python repair returns a source artifact.",
};
const classifyAttachedRepair = vi.fn(async () => ({ ok: true, value: { result: attachedRepairIntent } }));

describe("Attached code repair scope and validation", () => {
  let tempDir: string;
  let previousDataRoot: string | undefined;
  beforeEach(() => {
    classifyAttachedRepair.mockClear();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "attached-repair-"));
    previousDataRoot = process.env.WORKBENCH_DATA_ROOT;
    process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
  });
  afterEach(() => {
    closeDb();
    if (previousDataRoot === undefined) delete process.env.WORKBENCH_DATA_ROOT;
    else process.env.WORKBENCH_DATA_ROOT = previousDataRoot;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses semantic classification for a clear attached repair", async () => {
    const intent = await resolveSemanticIntent({ userPrompt: prompt, attachments: [attachment], hasWorkspace: true, workspaceFiles: ["notes.md"] }, { execute: classifyAttachedRepair } as any);
    expect(classifyAttachedRepair).toHaveBeenCalledTimes(1);
    expect(intent.driverModel).toBe("code-qwen25coder");
    expect(intent.workspaceMutationRequested).toBe(false);
    expect(intent.targetFiles).toEqual([]);
    expect(intent.expectedDeliverables).toEqual([{ type: "file", filename: "fixed-reader.py", description: "Corrected attached source" }]);
  });

  it("preserves the classifier's workspace and artifact decisions", () => {
    const raw = { intentType: "code_modification", primaryGoal: "Repair source", driverModel: "code-qwen25coder", taskType: "code", workspaceMutationRequested: true, isActionable: true, targetFiles: [attachment.filename] };
    const context = { hasWorkspace: true, workspaceFiles: ["reader.py"], attachments: [attachment], userPrompt: prompt };
    expect(validateAndNormalizeIntent(raw, context).workspaceMutationRequested).toBe(true);
    expect(validateAndNormalizeIntent(raw, { ...context, userPrompt: "Fix the attached source and write it into the workspace." }).workspaceMutationRequested).toBe(true);
    expect(validateAndNormalizeIntent(raw, { ...context, userPrompt: "Fix reader.py using the attached source." }).workspaceMutationRequested).toBe(true);
  });

  it("uses semantic classification for constraints and keeps attachment repair isolated", async () => {
    const execute = vi.fn(async () => ({ ok: true, value: { result: {
      ...attachedRepairIntent, primaryGoal: "Repair attachment", protectedPaths: ["notes.md"],
    } } }));
    const intent = await resolveSemanticIntent({ userPrompt: "Fix the attached script. Do not modify the workspace or notes.md.", attachments: [attachment], hasWorkspace: true, workspaceFiles: ["notes.md"] }, { execute } as any);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(intent.workspaceMutationRequested).toBe(false);
    expect(intent.protectedPaths).toContain("notes.md");
    const names = constrainToolsToIntent(composeTools({ hasWorkspace: true, hasAttachments: true, hasKnowledgeBaseDocs: false }, intent.driverModel), intent).map((t) => t.name);
    expect(names).toContain("execute_python");
    expect(names).not.toContain("generate_deliverable");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("delete_file");
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("generate_text");
  });

  it("executes assertions against the exact repaired source and exports only the source", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    writeFileSync(resolveRunPath(runId, "input/source.txt", "input"), "actual input\n");
    const context = { runId, workspaceRoot: resolveRunPath(runId, "intermediate", "intermediate"), gateway: {} as any, requestedArtifacts: [{ type: "file", filename: "fixed-reader.py" }] };
    const result = await executePythonTool.execute({ filename: "fixed-reader.py", code, input_files: ["source.txt"], validation_code: 'assert repaired["read"]("source.txt") == "actual input"\nprint("CHECK_PASSED")' }, context);
    expect(result.ok).not.toBe(false);
    expect(JSON.parse(result.output).stdout).toContain("CHECK_PASSED");
    expect(result.artifacts?.map((a) => a.filename)).toEqual(["fixed-reader.py"]);
    expect(readFileSync(resolveRunPath(runId, "output/fixed-reader.py", "output"), "utf8")).toBe(code);
    expect(existsSync(resolveRunPath(runId, "output/fixed_reader.py", "output"))).toBe(false);
  });

  it("rejects helper scripts and missing validation before executing or exporting a repair", async () => {
    const execute = vi.fn(async () => ({ output: "unexpected", summary: "unexpected" }));
    const intent = validateAndNormalizeIntent(attachedRepairIntent, { hasWorkspace: true, workspaceFiles: [], userPrompt: prompt });
    const tool = constrainToolsToIntent([{ ...executePythonTool, execute }], intent)[0];
    expect(tool.definition.function.parameters.required).toEqual(["code", "filename", "validation_code"]);
    const context = { runId: "unused", workspaceRoot: tempDir, gateway: {} as any };
    const missing = await tool.execute({ filename: "fixed-reader.py", code }, context);
    const helper = await tool.execute({ filename: "validate.py", code: "print('passed')", validation_code: "assert True" }, context);
    expect(missing.ok).toBe(false);
    expect(helper.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns real assertion failures without publishing a successful repaired artifact", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    const result = await executePythonTool.execute({ filename: "fixed-reader.py", code: "def read(): return 'wrong'\n", validation_code: 'assert repaired["read"]() == "correct"' }, { runId, workspaceRoot: tempDir, gateway: {} as any });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation_failure");
    expect(result.output).toContain("AssertionError");
    expect(result.artifacts).toBeUndefined();
    expect(existsSync(resolveRunPath(runId, "output/fixed-reader.py", "output"))).toBe(false);
  });

  it("supports custom filename-based tests without an unrelated reference pipeline", async () => {
    writeFileSync(path.join(tempDir, "reader.py"), code);
    writeFileSync(path.join(tempDir, "sample.txt"), "actual input\n");
    const result = await runCommandTool.execute({ command: "python3 -B", python_code: 'import reader\nassert reader.read("sample.txt") == "actual input"\nprint("CHECK_PASSED")' }, { runId: "test", workspaceRoot: tempDir, gateway: {} as any });
    const execution = JSON.parse(result.output);
    expect(execution.exitCode).toBe(0);
    expect(execution.stdout).toContain("CHECK_PASSED");
  });

  it("writes source deliverables exactly within run output and rejects escaping filenames", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    const context = { runId, workspaceRoot: tempDir, gateway: {} as any };
    const content = 'export const label = "[TOOL_RESULT]";\n';
    const result = await generateDeliverableTool.execute({ type: "file", filename: "reader.ts", content }, context);
    expect(readFileSync(resolveRunPath(runId, "output/reader.ts", "output"), "utf8")).toBe(content);
    expect(result.artifacts?.[0].filename).toBe("reader.ts");
    await expect(generateDeliverableTool.execute({ type: "file", filename: "../../outside.ts", content }, context)).rejects.toThrow();
  });

  it("does not complete an attached Python repair before assertions succeed", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    const intent = await resolveSemanticIntent({ userPrompt: prompt, attachments: [attachment], hasWorkspace: false }, { execute: classifyAttachedRepair } as any);
    let turn = 0;
    let validationFeedback = false;
    const gateway = { async chatWithTools(_model: any, messages: any[]) {
      turn++;
      validationFeedback ||= messages.some((m) => String(m.content).includes("exact repaired source must pass"));
      if (turn === 1 || turn === 3) return { ok: true, value: { content: null, tool_calls: [{ id: String(turn), name: "execute_python", arguments: {
        filename: "fixed-reader.py", code: "def read(): return 7\n", ...(turn === 3 ? { validation_code: 'assert repaired["read"]() == 7' } : {}),
      } }] } };
      return { ok: true, value: { content: "Repair verified.", tool_calls: null } };
    } };
    const result = await new AgentLoop().run({ runId, driverModelId: intent.driverModel, userPrompt: prompt, systemPrompt: "Repair attachment", semanticIntent: intent, tools: [executePythonTool], context: { runId, workspaceRoot: tempDir, gateway: gateway as any }, emitEvent() {} });
    expect(validationFeedback).toBe(true);
    expect(turn).toBe(4);
    expect(result.outcome).toBe("completed");
  });

  it("keeps a mounted workspace unchanged throughout a RunManager attachment repair", async () => {
    initDb(path.join(tempDir, "workbench.sqlite"));
    const workspace = path.join(tempDir, "workspace");
    mkdirSync(workspace);
    writeFileSync(path.join(workspace, "notes.md"), "workspace content\n");
    const events: any[] = [];
    const execute = classifyAttachedRepair;
    let turn = 0;
    const gateway = { execute, async chatWithTools(_model: any, messages: any[], options: any) {
      // chatWithTools receives tool definitions as the third argument.
      expect(messages[0].content).not.toContain("workspace content");
      expect(messages[0].content).not.toContain("Complete the requested workspace repair");
      const names = options.map((tool: any) => tool.function.name);
      expect(names).not.toContain("write_file");
      expect(names).not.toContain("run_command");
      turn++;
      return { ok: true, value: turn === 1 ? { content: null, tool_calls: [{ id: "repair", name: "execute_python", arguments: {
        filename: "fixed-reader.py", code, input_files: ["source.txt"], validation_code: 'assert repaired["read"]("source.txt") == "actual input"',
      } }] } : { content: "Repair verified.", tool_calls: null } };
    } };
    const manager = new RunManager(gateway as any, (event) => {
      events.push(event);
      if (event.type === "confirmation_required") {
        expect(turn).toBe(0);
        void manager.confirm({ runId: event.runId, actionId: event.action.actionId, approved: true });
      }
    });
    const harness = new HarnessManager();
    harness.registerWorkspace(workspace);
    manager.setHarness(harness);
    const source = Buffer.from(code), data = Buffer.from("actual input\n");
    const uploaded = manager.registerAttachment({ filename: attachment.filename, mediaType: attachment.mediaType, sizeBytes: source.length, base64OrBuffer: source });
    const input = manager.registerAttachment({ filename: "source.txt", mediaType: "text/plain", sizeBytes: data.length, base64OrBuffer: data });
    const previousV2 = process.env.WORKBENCH_AGENT_V2;
    process.env.WORKBENCH_AGENT_V2 = "true";
    try {
      const started = await manager.start({ userText: prompt, attachmentTokens: [uploaded.attachment.attachmentId, input.attachment.attachmentId] });
      await vi.waitFor(() => expect(events.some((e) => e.type === "run_state" && ["completed", "failed"].includes(e.state))).toBe(true), { timeout: 10000 });
      expect(events.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(readdirSync(workspace)).toEqual(["notes.md"]);
      expect(readFileSync(path.join(workspace, "notes.md"), "utf8")).toBe("workspace content\n");
      expect(readFileSync(resolveRunPath(started.runId, "output/fixed-reader.py", "output"), "utf8")).toBe(code);
    } finally {
      if (previousV2 === undefined) delete process.env.WORKBENCH_AGENT_V2;
      else process.env.WORKBENCH_AGENT_V2 = previousV2;
    }
  });
});
