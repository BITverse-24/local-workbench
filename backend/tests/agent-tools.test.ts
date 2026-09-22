import { describe, expect, it } from "vitest";
import { workspaceTools, listDirTool, readFileTool, searchTool, writeFileTool } from "../src/main/tools/workspace-tools.js";
import { specialistTools, generateDeliverableTool } from "../src/main/tools/specialist-tools.js";
import type { ToolExecutionContext } from "../src/main/tools/types.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

describe("Agent Tools Suite", () => {
  const testWorkspace = path.join(process.cwd(), "data", "test-tools-ws");

  it("exports all 6 workspace tools with valid schemas", () => {
    expect(workspaceTools).toHaveLength(6);
    const names = workspaceTools.map((t) => t.name);
    expect(names).toEqual(["list_dir", "read_file", "search", "write_file", "delete_file", "run_command"]);
    for (const tool of workspaceTools) {
      expect(tool.definition.type).toBe("function");
      expect(tool.definition.function.name).toBe(tool.name);
      expect(tool.definition.function.parameters.type).toBe("object");
    }
  });

  it("exports all 6 specialist tools with valid schemas", () => {
    expect(specialistTools).toHaveLength(6);
    const names = specialistTools.map((t) => t.name);
    expect(names).toEqual([
      "extract_document",
      "generate_code",
      "generate_text",
      "retrieve_knowledge",
      "execute_python",
      "generate_deliverable",
    ]);
    for (const tool of specialistTools) {
      expect(tool.definition.type).toBe("function");
      expect(tool.definition.function.name).toBe(tool.name);
      expect(tool.definition.function.parameters.type).toBe("object");
    }
  });

  it("executes workspace tools (write, read, search, list)", async () => {
    if (existsSync(testWorkspace)) rmSync(testWorkspace, { recursive: true, force: true });
    mkdirSync(testWorkspace, { recursive: true });

    const mockContext: ToolExecutionContext = {
      runId: "test-run",
      workspaceRoot: testWorkspace,
      gateway: {} as any,
    };

    // 1. write_file
    const writeRes = await writeFileTool.execute({ path: "test.txt", content: "Hello Sovereign Workbench v2\nLine 2" }, mockContext);
    expect(writeRes.summary).toContain('Wrote "test.txt"');
    expect(writeRes.sideEffects).toEqual(["modified:test.txt"]);

    // 2. read_file
    const readRes = await readFileTool.execute({ path: "test.txt" }, mockContext);
    expect(readRes.output).toContain("Hello Sovereign Workbench v2");

    // 3. search
    const searchRes = await searchTool.execute({ query: "Sovereign" }, mockContext);
    expect(searchRes.output).toContain("test.txt");

    // 4. list_dir
    const listRes = await listDirTool.execute({ path: "." }, mockContext);
    expect(listRes.output).toContain("test.txt");

    rmSync(testWorkspace, { recursive: true, force: true });
  });

  it("generates markdown deliverable via generate_deliverable", async () => {
    const runId = "11111111-2222-3333-4444-555555555555";
    const runDir = path.join(process.cwd(), "data", "runs", runId, "output");
    mkdirSync(runDir, { recursive: true });

    const mockContext: ToolExecutionContext = {
      runId,
      workspaceRoot: process.cwd(),
      gateway: {} as any,
    };

    const res = await generateDeliverableTool.execute(
      { type: "md", title: "Test Doc", content: "# Title\nDeliverable body", filename: "test.md" },
      mockContext,
    );

    expect(res.artifacts).toBeDefined();
    expect(res.artifacts?.[0].filename).toBe("test.md");
    expect(res.summary).toBe("Created deliverable: test.md");

    rmSync(path.join(process.cwd(), "data", "runs", runId), { recursive: true, force: true });
  });

  it("reads generated files from run output directory via read_file", async () => {
    const runId = "22222222-3333-4444-5555-666666666666";
    const runOutputDir = path.join(process.cwd(), "data", "runs", runId, "output");
    mkdirSync(runOutputDir, { recursive: true });
    writeFileSync(path.join(runOutputDir, "deliverable.txt"), "Official inspection deliverable content on disk.", "utf8");

    const mockContext: ToolExecutionContext = {
      runId,
      workspaceRoot: undefined,
      gateway: {} as any,
    };

    const res = await readFileTool.execute({ path: "deliverable.txt" }, mockContext);
    expect(res.output).toContain("Official inspection deliverable content on disk.");

    rmSync(path.join(process.cwd(), "data", "runs", runId), { recursive: true, force: true });
  });
});
