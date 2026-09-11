import { describe, it, expect } from "vitest";
import {
  buildHarnessSystemPrompt,
  HARNESS_TOOL_DEFINITIONS,
  formatTreeForPrompt,
} from "../src/main/harness/harness-prompt.js";

describe("Harness Prompt & Tool Definitions", () => {
  it("formats directory tree cleanly with icons and sizes", () => {
    const entries = [
      { name: "src", type: "directory" as const, size: 0 },
      { name: "src/index.ts", type: "file" as const, size: 1024 },
      { name: "README.md", type: "file" as const, size: 250 },
    ];
    const tree = formatTreeForPrompt(entries);
    expect(tree).toContain("📁 src");
    expect(tree).toContain("src/index.ts (1.0KB)");
    expect(tree).toContain("README.md (250B)");
  });

  it("handles empty directory tree", () => {
    expect(formatTreeForPrompt([])).toBe("(empty directory)");
  });

  it("builds harness system prompt with tree injected", () => {
    const prompt = buildHarnessSystemPrompt("📁 src\n   src/index.ts (1.0KB)");
    expect(prompt).toContain("WORKSPACE DIRECTORY TREE:");
    expect(prompt).toContain("📁 src");
    expect(prompt).toContain("list_dir");
    expect(prompt).toContain("search");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("write_file");
    expect(prompt).toContain("run_command");
    expect(prompt).toContain("NEVER use absolute paths");
  });

  it("defines exactly the 5 harness tools matching OpenAI function schema", () => {
    expect(HARNESS_TOOL_DEFINITIONS.length).toBe(5);
    const names = HARNESS_TOOL_DEFINITIONS.map((t) => t.function.name);
    expect(names).toEqual([
      "list_dir",
      "read_file",
      "search",
      "write_file",
      "run_command",
    ]);

    for (const tool of HARNESS_TOOL_DEFINITIONS) {
      expect(tool.type).toBe("function");
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters).toBeDefined();
    }
  });
});
