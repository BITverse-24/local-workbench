import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentLoop } from "../src/main/agent/agent-loop.js";
import { ModelGateway, extractEmbeddedToolCalls } from "../src/main/gateway/model-gateway.js";
import { resolveSemanticIntent, validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";
import { composeTools, constrainToolsToIntent } from "../src/main/router/tool-compositor.js";
import { normalizeRunContract } from "../src/main/run/contract.js";
import type { ModelRegistryEntry } from "../src/shared/contracts.js";

const runId = "00000000-0000-4000-8000-000000000081";
const incorrectFileIntent = {
  requestedAction: "draft", responseMode: "chat_and_files", primaryGoal: "Provide implementation guidance",
  workspaceMutationRequested: false,
  expectedDeliverables: [{ filename: "implementation.docx", type: "docx" }],
};
const registry: ModelRegistryEntry[] = [{ id: "primary-model", taskTypes: ["draft"], runtime: "mlx-lm",
  baseUrl: "http://127.0.0.1:1234/v1", model: "test-model", capabilities: ["text"],
  requestTimeoutMs: 60000, healthPath: "/models", enabled: true, toolCallingFormat: "json" }];

describe("Implementation guidance and file delivery boundaries", () => {
  let directory: string;
  let previousRoot: string | undefined;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "guidance-"));
    previousRoot = process.env.WORKBENCH_DATA_ROOT;
    process.env.WORKBENCH_DATA_ROOT = directory;
  });
  afterEach(() => {
    if (previousRoot === undefined) delete process.env.WORKBENCH_DATA_ROOT;
    else process.env.WORKBENCH_DATA_ROOT = previousRoot;
    rmSync(directory, { recursive: true, force: true });
  });

  it("replays the 0a81eae5 request without inventing a file or retrying the answer", async () => {
    const userPrompt = "Can u help me implement it myself?";
    const classification = vi.fn(async () => ({ ok: true, value: { result: incorrectFileIntent } }));
    const intent = await resolveSemanticIntent({ userPrompt, runId, verifyContract: true,
      history: [{ role: "user", content: "What is speculative decoding" }],
    }, { execute: classification } as any);
    expect(classification).toHaveBeenCalledTimes(1);
    expect(intent.status).toBe("resolved");
    expect(intent.intentType).toBe("general_qa");
    const contract = normalizeRunContract(runId, intent);
    expect(contract.deliverables).toEqual([]);
    expect(contract.workspace.operations).toEqual([]);
    expect(contract.acceptance.validateWrittenCode).toBe(false);
    expect(contract.acceptance.validatedPythonDeliverables).toEqual([]);

    const environment = { hasWorkspace: false, hasAttachments: false, hasKnowledgeBaseDocs: false };
    const tools = constrainToolsToIntent(composeTools(environment, "primary-model"), intent, contract, environment);
    expect(tools.some(tool => ["execute_python", "generate_deliverable"].includes(tool.name))).toBe(false);
    const answer = "Start with a small example. Implement each step, then check the result yourself.";
    const chatWithTools = vi.fn(async (_model, messages, definitions) => {
      expect(messages[0].content).toContain("Answer the user's request in chat");
      expect(definitions).toEqual([]);
      return { ok: true, value: { content: answer, tool_calls: null, finishReason: "stop" } };
    });
    const result = await new AgentLoop().run({ runId, driverModelId: "primary-model", userPrompt,
      systemPrompt: "Help the user", semanticIntent: intent, runContract: contract, tools,
      context: { runId, workspaceRoot: directory, gateway: { chatWithTools } as any }, emitEvent() {},
    });
    expect(result.outcome).toBe("completed");
    expect(result.finalText).toBe(answer);
    expect(chatWithTools).toHaveBeenCalledTimes(1);
  });

  it("removes invented execution and validation from self-directed help with a mounted workspace", () => {
    const intent = validateAndNormalizeIntent({ ...incorrectFileIntent,
      requestedAction: "modify_software", workspaceMutationRequested: true, targetFiles: ["example.py"],
      workspaceOperations: [{ operation: "write", targetPath: "example.py" }], validationRequested: true,
    }, { userPrompt: "Guide me through implementing this on my own", hasWorkspace: true, workspaceFiles: ["example.py"] });
    expect(intent.chatResponseOnly).toBe(true);
    expect(intent.workspaceMutationRequested).toBe(false);
    expect(intent.validationRequested).toBe(false);
    expect(intent.targetFiles).toEqual([]);
    expect(intent.expectedDeliverables).toEqual([]);
  });

  it.each([
    "Help me implement it myself, and export the guide as a Word document",
    "Help me implement it myself. Also create a document with the steps.",
    "Help me implement it myself and save the example to example.py",
  ])("preserves an additional explicit file request: %s", userPrompt => {
    const intent = validateAndNormalizeIntent(incorrectFileIntent, { userPrompt, hasWorkspace: false, workspaceFiles: [] });
    expect(intent.expectedDeliverables).toHaveLength(1);
    expect(intent.chatResponseOnly).toBe(false);
  });

  it("preserves an explicit source export alongside guidance", () => {
    const intent = validateAndNormalizeIntent({ ...incorrectFileIntent, requestedAction: "modify_software",
      expectedDeliverables: [{ filename: "example.py", type: "file" }],
    }, { userPrompt: "Help me implement it myself and create example.py", hasWorkspace: false, workspaceFiles: [] });
    expect(intent.expectedDeliverables[0].filename).toBe("example.py");
    expect(intent.intentType).toBe("code_modification");
  });

  it("decodes a complete fenced tool envelope through the existing JSON fallback without another request", async () => {
    const responseText = 'Creating the requested file.\n```json\n' + JSON.stringify({ tool_calls: [{
      name: "generate_deliverable", arguments: { type: "docx", filename: "guide.docx", content: ["# Guide", "", "Steps"] },
    }], content: "" }) + '\n```\n';
    const request = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ choices: [{
      message: { content: responseText }, finish_reason: "stop",
    }] }) }));
    const gateway = new ModelGateway({ request }, registry);
    const result = await gateway.chatWithTools("primary-model", [{ role: "user", content: "Export a Word guide" }], [{
      type: "function", function: { name: "generate_deliverable", description: "Compile a document",
        parameters: { type: "object", properties: { content: { type: "string", format: "multiline" } } },
      },
    }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.tool_calls?.[0]).toMatchObject({ name: "generate_deliverable",
      arguments: { filename: "guide.docx", content: "# Guide\n\nSteps" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not recover truncated JSON or interpret ordinary fenced examples as tool calls", () => {
    const truncated = 'Narration\n```json\n{"tool_calls":[{"name":"generate_deliverable","arguments":{"content":"cut off\n```';
    expect(extractEmbeddedToolCalls(truncated, true).toolCalls).toEqual([]);
    const example = 'Example\n```json\n{"name":"write_file","arguments":{"path":"example.py"}}\n```';
    expect(extractEmbeddedToolCalls(example, true).toolCalls).toEqual([]);
    const envelope = 'Example\n```json\n{"tool_calls":[{"name":"write_file","arguments":{"path":"example.py"}}]}\n```';
    expect(extractEmbeddedToolCalls(envelope).toolCalls).toEqual([]);
  });
});
