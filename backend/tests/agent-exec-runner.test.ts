import { describe, it, expect, vi } from "vitest";
import { runExecTurn, extractScriptCode, EXEC_TOOL } from "../src/main/agent/exec/exec-step.js";
import { defaultExecObserveState } from "../src/main/agent/exec/exec-policy.js";
import { ToolDispatcher } from "../src/main/agent/tool-dispatcher.js";
import type { ToolExecutionContext, AgentTool } from "../src/main/tools/types.js";
import type { AgentTask, ModelId } from "../src/shared/contracts.js";
import type { AgentContextPacket } from "../src/main/agent/context-packet.js";

function createMockDispatcher(): ToolDispatcher {
  const tools: AgentTool[] = [
    {
      name: "read_file",
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
      execute: vi.fn().mockImplementation(async (args) => {
        return {
          output: `content of ${args.path}`,
          summary: `Read ${args.path}`,
          intermediate: {
            type: "text",
            status: "complete",
            origin: "source_extracted",
            payload: `content of ${args.path}`,
            sources: [{ filename: args.path, relation: "source" }],
          },
        };
      }),
    },
    {
      name: "list_dir",
      definition: {
        type: "function",
        function: {
          name: "list_dir",
          description: "List directory",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
      execute: vi.fn().mockImplementation(async () => {
        return {
          output: JSON.stringify(["index.ts", "package.json"]),
          summary: "Listed items",
        };
      }),
    },
  ];

  return new ToolDispatcher(tools);
}

function createMockContext(gatewayResponse: any): { context: ToolExecutionContext; resultStore: any } {
  const runId = "12345678-1234-1234-1234-123456789abc";
  const registeredResults: any[] = [];
  const resultStore = {
    runId,
    registerResult: vi.fn().mockImplementation((r) => {
      registeredResults.push(r);
      return { resultId: "res-" + registeredResults.length, storage: { sha256: "sha_mock_" + registeredResults.length }, ...r };
    }),
    registered: registeredResults,
  };

  const context: ToolExecutionContext = {
    runId,
    workspaceRoot: "/workspace",
    resultStore: resultStore as any,
    gateway: {
      chatWithTools: vi.fn().mockResolvedValue(gatewayResponse),
    } as any,
  };

  return { context, resultStore };
}

function createMockTask(): AgentTask {
  return {
    taskId: "task-1234",
    status: "active",
    workspace: { root: "/workspace", registeredAt: "2026-11-07" },
    snapshot: {
      revision: 1,
      requirements: [
        { id: "req-1", text: "Read index.ts", state: "active", kind: "inspect" },
      ],
    },
  } as any;
}

function createMockPacket(): AgentContextPacket {
  return {
    requirement: { id: "req-1", description: "Read index.ts", state: "active", kind: "inspect", source_id: "user" } as any,
    messages: [
      { role: "system", content: "System instructions" },
      { role: "user", content: "Inspect index.ts" },
    ],
    observedSources: [],
  };
}

describe("Exec Turn Step & Gateway Integration", () => {
  it("extracts code from fenced markdown and executes in sandbox", async () => {
    const rawFenced = "```ts\nconst f = await tools.readFile('index.ts');\ntext('Content: ' + f.content);\n```";
    const { context, resultStore } = createMockContext({
      ok: true,
      value: { content: rawFenced },
    });
    const dispatcher = createMockDispatcher();
    const task = createMockTask();
    const packet = createMockPacket();
    const state = defaultExecObserveState("exec");

    const res = await runExecTurn({
      task,
      context,
      packet,
      modelId: "qwen/qwen3.5-9b" as ModelId,
      dispatcher,
      scope: {},
      state,
      transport: "fenced",
    });

    expect(res.outcome.ok).toBe(true);
    expect(res.observation).toContain("content of index.ts");

    // Verify ResultStore records
    expect(resultStore.registered.length).toBeGreaterThanOrEqual(1);
    const execRecord = resultStore.registered.find((r: any) => r.producer?.tool === "agent_exec_output");
    expect(execRecord).toBeDefined();
    expect(execRecord.payload.output).toContain("content of index.ts");
  });

  it("handles toolcall transport when model returns exec tool call", async () => {
    const code = "const list = await tools.listDir('.');\ntext('Files: ' + list.join(','));";
    const { context, resultStore } = createMockContext({
      ok: true,
      value: {
        content: null,
        tool_calls: [
          {
            id: "call-1",
            name: "exec",
            arguments: { code },
          },
        ],
      },
    });
    const dispatcher = createMockDispatcher();
    const task = createMockTask();
    const packet = createMockPacket();
    const state = defaultExecObserveState("exec");

    const res = await runExecTurn({
      task,
      context,
      packet,
      modelId: "qwen/qwen3.5-9b" as ModelId,
      dispatcher,
      scope: {},
      state,
      transport: "toolcall",
    });

    expect(res.outcome.ok).toBe(true);
    expect(res.observation).toBe("Files: index.ts,package.json");
  });

  it("handles empty parse when model returns prose only", async () => {
    const { context, resultStore } = createMockContext({
      ok: true,
      value: {
        content: "I think we should examine the files first before doing anything.",
      },
    });
    const dispatcher = createMockDispatcher();
    const task = createMockTask();
    const packet = createMockPacket();
    const state = defaultExecObserveState("exec");

    const res = await runExecTurn({
      task,
      context,
      packet,
      modelId: "qwen/qwen3.5-9b" as ModelId,
      dispatcher,
      scope: {},
      state,
      transport: "fenced",
    });

    expect(res.outcome.ok).toBe(false);
    expect(res.outcome.error?.kind).toBe("empty_parse");
    expect(resultStore.registered.some((r: any) => r.producer?.tool === "agent_rejected_response")).toBe(true);
  });

  it("code extraction helper handles <think> reasoning tokens cleanly", () => {
    const withThink = `<think>
I need to read index.ts
</think>
\`\`\`ts
const data = await tools.readFile("index.ts");
text(data.content);
\`\`\``;

    const extracted = extractScriptCode(withThink);
    expect(extracted).toContain('tools.readFile("index.ts")');
    expect(extracted).not.toContain("<think>");
  });
});
