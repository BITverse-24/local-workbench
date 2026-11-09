import { describe, it, expect, vi } from "vitest";
import { createReadFacade, READ_ALLOWLIST } from "../src/main/agent/exec/facade.js";
import { ToolDispatcher, type ExecutedToolOutput } from "../src/main/agent/tool-dispatcher.js";
import type { ToolExecutionContext, AgentTool } from "../src/main/tools/types.js";

function createMockDispatcher(toolNames: string[]): ToolDispatcher {
  const tools: AgentTool[] = toolNames.map((name) => ({
    name,
    definition: {
      type: "function",
      function: {
        name,
        description: `Mock ${name}`,
        parameters: { type: "object", properties: { path: { type: "string" }, query: { type: "string" } } },
      },
    },
    execute: vi.fn().mockImplementation(async (args) => {
      if (name === "read_file") {
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
      }
      if (name === "search") {
        return {
          output: JSON.stringify([{ path: "file.ts", line: 5, text: `match for ${args.query}` }]),
          summary: `Found matches`,
        };
      }
      if (name === "list_dir") {
        return {
          output: JSON.stringify(["a.ts", "b.ts"]),
          summary: `Listed items`,
        };
      }
      return { output: `executed ${name}`, summary: `Mock ${name}` };
    }),
  }));

  return new ToolDispatcher(tools);
}

function createBaseContext(): ToolExecutionContext {
  return {
    runId: "11111111-2222-3333-4444-555555555555",
    workspaceRoot: "/workspace",
    gateway: {} as any,
  };
}

describe("Read Facade Dispatch & Scope Verification", () => {
  it("dispatches readFile through ToolDispatcher and returns structured payload", async () => {
    const dispatcher = createMockDispatcher(["read_file"]);
    const context = createBaseContext();
    const facade = createReadFacade(dispatcher, context, {
      parentExecId: "22222222-3333-4444-5555-666666666666",
      requirementId: "req-1",
    });

    const res = await facade.readFile("src/index.ts");
    expect(res.content).toBe("content of src/index.ts");
    expect(facade.getCallCount()).toBe(1);

    const executed = facade.getExecutedTools();
    expect(executed.length).toBe(1);
    expect(executed[0].name).toBe("read_file");
    expect(executed[0].args.path).toBe("src/index.ts");
    expect(executed[0].args.requirement_id).toBeUndefined();
  });

  it("enforces allowedPaths scope restriction when configured", async () => {
    const dispatcher = createMockDispatcher(["read_file"]);
    const context = createBaseContext();
    const facade = createReadFacade(dispatcher, context, {
      parentExecId: "22222222-3333-4444-5555-666666666666",
      requirementId: "req-1",
      allowedPaths: ["src/allowed.ts"],
    });

    await expect(facade.readFile("src/secret.ts")).rejects.toThrow(/outside the allowed read scope/);
    expect(facade.getCallCount()).toBe(0);

    const allowed = await facade.readFile("src/allowed.ts");
    expect(allowed.content).toBe("content of src/allowed.ts");
    expect(facade.getCallCount()).toBe(1);
  });

  it("strictly rejects non-allowlisted / mutating tools", async () => {
    const dispatcher = createMockDispatcher(["write_file", "delete_file", "run_command"]);
    const context = createBaseContext();
    const facade = createReadFacade(dispatcher, context, {
      parentExecId: "22222222-3333-4444-5555-666666666666",
      requirementId: "req-1",
    });

    // Check allowlist constants
    expect(READ_ALLOWLIST.has("read_file")).toBe(true);
    expect(READ_ALLOWLIST.has("search")).toBe(true);
    expect(READ_ALLOWLIST.has("list_dir")).toBe(true);
    expect(READ_ALLOWLIST.has("write_file")).toBe(false);
    expect(READ_ALLOWLIST.has("delete_file")).toBe(false);
    expect(READ_ALLOWLIST.has("run_command")).toBe(false);
  });

  it("enforces the maxCalls tool budget", async () => {
    const dispatcher = createMockDispatcher(["list_dir"]);
    const context = createBaseContext();
    const facade = createReadFacade(dispatcher, context, {
      parentExecId: "22222222-3333-4444-5555-666666666666",
      requirementId: "req-1",
      maxCalls: 3,
    });

    await facade.listDir(".");
    await facade.listDir(".");
    await facade.listDir(".");
    expect(facade.getCallCount()).toBe(3);

    await expect(facade.listDir(".")).rejects.toThrow(/budget exceeded/i);
    expect(facade.getCallCount()).toBe(3);
  });

  it("handles search and listDir formatting", async () => {
    const dispatcher = createMockDispatcher(["search", "list_dir"]);
    const context = createBaseContext();
    const facade = createReadFacade(dispatcher, context, {
      parentExecId: "22222222-3333-4444-5555-666666666666",
      requirementId: "req-1",
    });

    const searchMatches = await facade.search("auth");
    expect(searchMatches).toEqual([{ path: "file.ts", line: 5, text: "match for auth" }]);

    const entries = await facade.listDir(".");
    expect(entries).toEqual(["a.ts", "b.ts"]);
  });
});
