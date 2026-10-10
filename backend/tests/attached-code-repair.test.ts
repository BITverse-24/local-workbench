import { approvedPythonTool as executePythonTool } from "./helpers/approved-python.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSemanticIntent, validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";
import { composeTools, constrainToolsToIntent } from "../src/main/router/tool-compositor.js";
import { createRunDirectories, resolveRunPath } from "../src/main/run/filesystem.js";
import { generateDeliverableTool } from "../src/main/tools/specialist-tools.js";
import { runCommandTool } from "../src/main/tools/workspace-tools.js";
import { AgentLoop } from "./helpers/agent-loop-fixture.js";
import { RunManager } from "../src/main/run/manager.js";
import { HarnessManager } from "../src/main/harness/harness-manager.js";
import { closeDb, initDb, getDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import type { RunEvent } from "../src/shared/contracts.js";

const attachment = { attachmentId: "source", filename: "broken-reader.py", mediaType: "text/x-python-script", sizeBytes: 30, relativePath: "runs/source/input/broken-reader.py" };
const prompt = "This is crashing on our input files. Fix it and make sure it actually works.";
const code = 'def read(path):\n    with open(path) as handle:\n        return handle.read().strip()\n';
const attachedRepairIntent = {
  intentType: "code_modification", primaryGoal: "Repair attached source", driverModel: "primary-model", taskType: "code",
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
    expect(intent.driverModel).toBe("primary-model");
    expect(intent.workspaceMutationRequested).toBe(false);
    expect(intent.targetFiles).toEqual([]);
    expect(intent.expectedDeliverables).toEqual([{ type: "file", filename: "fixed-reader.py", description: "Corrected attached source" }]);
  });

  it("preserves validated workspace scope without matching prompt keywords", () => {
    const raw = { intentType: "code_modification", primaryGoal: "Repair source", driverModel: "primary-model", taskType: "code", workspaceMutationRequested: true, isActionable: true, targetFiles: [attachment.filename] };
    const context = { hasWorkspace: true, workspaceFiles: ["reader.py"], attachments: [attachment], userPrompt: prompt };
    expect(validateAndNormalizeIntent(raw, context).workspaceMutationRequested).toBe(true);
    const standalone = { ...raw, workspaceMutationRequested: false, expectedDeliverables: [{ type: "file", filename: "fixed-reader.py" }] };
    expect(validateAndNormalizeIntent(standalone, context).workspaceMutationRequested).toBe(false);
    expect(validateAndNormalizeIntent(standalone, context).targetFiles).toEqual([]);
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
    const pythonTool = constrainToolsToIntent(composeTools({ hasWorkspace: true, hasAttachments: true, hasKnowledgeBaseDocs: false }, intent.driverModel), intent)
      .find((tool) => tool.name === "execute_python")!;
    expect(pythonTool.definition.function.parameters.properties.validation_code.description).toContain('original evidence');
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

  it("preserves Python subscription assignments and argv indexing for ordinary execution", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    const source = [
      "import sys",
      "counts = {'malformed': 0}",
      "counts['malformed'] += 1",
      "print(counts['malformed'], sys.argv[1] if len(sys.argv) > 1 else 'no-input')",
    ].join("\n") + "\n";
    const result = await executePythonTool.execute({ filename: "task.py", code: source }, { runId, workspaceRoot: tempDir, gateway: {} as any });
    expect(result.ok).not.toBe(false);
    expect(JSON.parse(result.output).stdout).toContain("1 no-input");
    expect(readFileSync(resolveRunPath(runId, "intermediate/task.py", "intermediate"), "utf8")).toBe(source);
  });

  it("allows direct execution without invented assertions and rejects helper scripts", async () => {
    const execute = vi.fn(async (_args: Record<string, unknown>) => ({ ok: true, output: "executed", summary: "execution accepted" }));
    const intent = validateAndNormalizeIntent({...attachedRepairIntent,expectedDeliverables:[{filename:'fixed-reader.py',filenameRequired:true,type:'file'}]}, { hasWorkspace: true, workspaceFiles: [], userPrompt: prompt });
    const tool = constrainToolsToIntent([{ ...executePythonTool, execute }], intent)[0];
    expect(tool.definition.function.parameters.required).toEqual(["code", "filename"]);
    const context = { runId: "unused", workspaceRoot: tempDir, gateway: {} as any };
    const direct = await tool.execute({ filename: "fixed-reader.py", code }, context);
    const helper = await tool.execute({ filename: "validate.py", code: "print('passed')", validation_code: "assert True" }, context);
    expect(direct.ok).toBe(true);
    expect(helper.ok).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).not.toHaveProperty("validation_code");
  });

  it("treats successful execution on the supplied inputs as execution evidence", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    writeFileSync(resolveRunPath(runId, "input/source.txt", "input"), "actual input\n");
    const result = await executePythonTool.execute({ filename: "fixed-reader.py", code, input_files: ["source.txt"] }, {
      runId, workspaceRoot: resolveRunPath(runId, "intermediate", "intermediate"), gateway: {} as any,
      runContract: { deliverables: [{ type: "file", filename: "fixed-reader.py" }] } as any,
    });
    expect(result.ok).not.toBe(false);
    expect(JSON.parse(result.output).executionPassed).toBe(true);
    expect(JSON.parse(result.output).validationAssertionsPassed).toBe(false);
    expect(result.artifacts?.map((artifact) => artifact.filename)).toEqual(["fixed-reader.py"]);
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
    const assertion='assert repaired["read"]() == 7';
    const request=`Repair the attached source and run this supplied assertion: ${assertion}`;
    const events:RunEvent[]=[];
    const gateway = { registry:new Map([['primary-model',{maxOutputTokens:1536}]]), async chatWithTools(_model: any, _messages: any[], _tools:any[], options:any) {
      if(options?.responseSchema?.name==='proposed_source_behavior_review')return {ok:true,value:{content:'{"gaps":[]}',finishReason:'stop'}};
      if(options?.responseSchema?.name==='source_derived_code_behavior_review')return {ok:true,value:{content:JSON.stringify([{index:0,status:'satisfied',issue:'The supplied assertion passed on the saved function.',sourceEvidence:assertion,implementationEvidence:'return 7'}]),finishReason:'stop'}};
      if (++turn<=2) return { ok: true, value: { content: null, tool_calls: [{ id: String(turn), name: "execute_python", arguments: {
        filename: "fixed-reader.py", code: `def read(): return ${turn===1?6:7}\n`, validation_code:assertion,
      } }] } };
      return { ok: true, value: { content: "Repair verified.", tool_calls: null } };
    } };
    const result = await new AgentLoop().run({ runId, driverModelId: intent.driverModel, userPrompt: request, systemPrompt: "Repair attachment", semanticIntent: intent, tools: [executePythonTool], context: { runId, workspaceRoot: tempDir, gateway: gateway as any,sourceReviewEvidence:`def read(): return 6\n${assertion}`,originalUserRequest:request }, emitEvent:event=>events.push(event) });
    expect(events.filter(event=>event.type==='tool_result'&&event.tool==='execute_python'&&!event.ok)).toHaveLength(1);
    expect(events.filter(event=>event.type==='tool_result'&&event.tool==='execute_python'&&event.ok)).toHaveLength(1);
    expect(readFileSync(resolveRunPath(runId,'output/fixed-reader.py','output'),'utf8')).toBe('def read(): return 7\n');
    expect(result.outcome).toBe("completed");
  });

  it.each(['fenced source','exact edits'])("keeps a mounted workspace unchanged throughout a RunManager attachment repair using %s", async transport => {
    initDb(path.join(tempDir, "workbench.sqlite"));
    const workspace = path.join(tempDir, "workspace");
    mkdirSync(workspace);
    writeFileSync(path.join(workspace, "notes.md"), "workspace content\n");
    const events: any[] = [];
    const gateway=new ModelGateway();
    const execute = vi.spyOn(gateway,'execute').mockImplementation(classifyAttachedRepair as any);
    let turn = 0;
    vi.spyOn(gateway,'chatWithTools').mockImplementation(async (_model: any, messages: any[], definitions: any[], options: any) => {
      // chatWithTools receives tool definitions as the third argument.
      expect(messages[0].content).not.toContain("workspace content");
      expect(messages[0].content).not.toContain("Complete the requested workspace repair");
      const names = definitions.map((tool: any) => tool.function.name);
      expect(names).not.toContain("write_file");
      expect(names).not.toContain("run_command");
      turn++;
      const schema=options?.responseSchema?.name;
      const proposal=transport==='exact edits'?JSON.stringify({edits:[{old:'return handle.read()',new:'return handle.read().strip()'}]}):'```python\n'+code+'```';
      const content=schema==='work_requirements'?'{"checks":[]}':schema==='software_repair_review'?'{"defects":[],"checks":[],"preservedBehavior":[]}':schema==='proposed_source_behavior_review'?'{"gaps":[]}':schema==='source_derived_code_behavior_review'?JSON.stringify([0,1].map(index=>({index,status:'satisfied',issue:'The original function and input handling are preserved.',sourceEvidence:'def read(path):',implementationEvidence:'def read(path):'}))):String(messages[0].content).startsWith('Independently check')?JSON.stringify({checks:[{id:'content:complete_request',status:'passed',reason:'The original source function is retained and executed.',outputQuotes:['def read(path):'],sourceQuotes:['def read(path):']}],coverageGaps:[]}):proposal;
      return {ok:true,value:{content,tool_calls:[],finishReason:'stop'}} as any;
    });
    const manager = new RunManager(gateway as any, (event) => {
      events.push(event);
      if (event.type === "confirmation_required") {
        expect(event.action.kind).toBe('uncontained_python');
        expect(turn).toBeGreaterThan(0);
        void manager.confirm({ runId: event.runId, actionId: event.action.actionId, approved: true });
      }
    });
    const harness = new HarnessManager();
    harness.registerWorkspace(workspace);
    manager.setHarness(harness);
    const source = Buffer.from(transport==='exact edits'?code.replace('.strip()',''):code), data = Buffer.from("actual input\n"), chatId=createChat();
    const uploaded = manager.registerAttachment({ chatId, filename: attachment.filename, mediaType: attachment.mediaType, sizeBytes: source.length, base64OrBuffer: source });
    const input = manager.registerAttachment({ chatId, filename: "source.txt", mediaType: "text/plain", sizeBytes: data.length, base64OrBuffer: data });
    const previousV2 = process.env.WORKBENCH_AGENT_V2;
    process.env.WORKBENCH_AGENT_V2 = "true";
    try {
      const started = await manager.start({ chatId, mode:'work', userText: prompt, attachmentTokens: [uploaded.attachment.attachmentId, input.attachment.attachmentId] });
      await vi.waitFor(() => expect(events.some((e) => e.type === "run_state" && ["completed", "partial", "failed"].includes(e.state))).toBe(true), { timeout: 10000 });
      expect(events.some(e=>e.type==='run_state'&&e.state==='completed'), JSON.stringify(getDb().prepare('SELECT checks_json FROM run_artifact_validations WHERE run_id=?').get(started.runId))).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(readdirSync(workspace)).toEqual(["notes.md"]);
      expect(readFileSync(path.join(workspace, "notes.md"), "utf8")).toBe("workspace content\n");
      expect(readFileSync(resolveRunPath(started.runId, "output/fixed-reader.py", "output"), "utf8")).toBe(code);
      expect(readFileSync(path.join(process.env.WORKBENCH_DATA_ROOT!,uploaded.attachment.relativePath))).toEqual(source);
    } finally {
      if (previousV2 === undefined) delete process.env.WORKBENCH_AGENT_V2;
      else process.env.WORKBENCH_AGENT_V2 = previousV2;
    }
  });
});
