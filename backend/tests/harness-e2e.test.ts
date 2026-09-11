import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { HarnessManager } from "../src/main/harness/harness-manager.js";
import { PermissionError } from "../src/main/harness/path-guard.js";
import { buildHarnessSystemPrompt, formatTreeForPrompt } from "../src/main/harness/harness-prompt.js";
import type { RunEvent, WorkspaceEvent } from "../src/shared/contracts.js";

describe("HARNESS.md End-to-End Acceptance Criteria Suite", () => {
  let workspaceRoot: string;
  let harness: HarnessManager;
  let workspaceEvents: WorkspaceEvent[];
  let runEvents: RunEvent[];

  beforeEach(() => {
    const rawRoot = path.join(
      os.tmpdir(),
      `harness-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );

    // Setup a simulated project repository with:
    // - .git/ and node_modules/ (which must be ignored)
    // - A CSV parsing utility that has a bug
    // - A test suite script that fails on the bug
    mkdirSync(path.join(rawRoot, ".git", "objects"), { recursive: true });
    mkdirSync(path.join(rawRoot, "node_modules", "lodash"), { recursive: true });
    mkdirSync(path.join(rawRoot, "src", "parsers"), { recursive: true });
    mkdirSync(path.join(rawRoot, "tests"), { recursive: true });

    workspaceRoot = realpathSync(rawRoot);

    writeFileSync(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "csv-service", version: "1.0.0" }, null, 2) + "\n",
    );

    // Deliberately broken CSV parser: throws on empty lines
    writeFileSync(
      path.join(workspaceRoot, "src", "parsers", "csv.js"),
      `// CSV Parser utility with bug
function parseCSV(content) {
  const lines = content.split("\\n");
  return lines.map(line => {
    if (line.length === 0) throw new Error("empty line error");
    return line.split(",");
  });
}
module.exports = { parseCSV };
`,
    );

    // Test script that tests parseCSV with trailing newline
    writeFileSync(
      path.join(workspaceRoot, "tests", "test-parser.js"),
      `const { parseCSV } = require("../src/parsers/csv.js");
try {
  const data = "a,b,c\\n1,2,3\\n";
  const rows = parseCSV(data);
  console.log("PARSER_SUCCESS: " + rows.length);
  process.exit(0);
} catch (err) {
  console.error("PARSER_FAILURE: " + err.message);
  process.exit(1);
}
`,
    );

    workspaceEvents = [];
    runEvents = [];

    harness = new HarnessManager(
      (ev) => workspaceEvents.push(ev),
      (ev) => runEvents.push(ev),
    );
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // ── Criterion 1: Fast directory registration with ignore-list ───────
  it("Criterion 1: registers directory and returns filtered tree excluding node_modules and .git", () => {
    const info = harness.registerWorkspace(workspaceRoot);
    expect(info.root).toBe(workspaceRoot);

    const tree = harness.getDirectoryTree();
    const names = tree.map((e) => e.name);

    // Should include project source files
    expect(names).toContain("package.json");
    expect(names).toContain("src");
    expect(names).toContain(path.join("src", "parsers", "csv.js"));
    expect(names).toContain(path.join("tests", "test-parser.js"));

    // Should strictly exclude .git and node_modules
    expect(names).not.toContain(".git");
    expect(names).not.toContain("node_modules");
    expect(names.some((n) => n.startsWith("node_modules"))).toBe(false);
    expect(names.some((n) => n.startsWith(".git"))).toBe(false);

    // Lazy context formatted string should be compact
    const promptTree = formatTreeForPrompt(tree);
    expect(promptTree).toContain("csv.js");
    expect(promptTree).not.toContain("lodash");
  });

  // ── Criterion 2: Search finds file without hardcoded paths ──────────
  it("Criterion 2: finds relevant file via search query rather than hardcoded path", async () => {
    harness.registerWorkspace(workspaceRoot);

    // Agent given task: "fix the empty line error in csv parsing"
    const searchResult = await harness.executeTool({
      tool: "search",
      args: { query: "empty line error" },
    });

    if (searchResult.tool !== "search") throw new Error("expected search");
    expect(searchResult.result.length).toBeGreaterThan(0);

    const match = searchResult.result[0];
    expect(match.file).toBe(path.join("src", "parsers", "csv.js"));
    expect(match.matchingLine).toContain("empty line error");

    // Agent then opens the discovered file
    const fileContent = await harness.executeTool({
      tool: "read_file",
      args: { path: match.file },
    });

    if (fileContent.tool !== "read_file") throw new Error("expected read_file");
    expect(fileContent.result).toContain("function parseCSV");
  });

  // ── Criterion 3: Timestamped backup before overwrite with diff ───────
  it("Criterion 3: creates timestamped backup before overwrite and reports diff", async () => {
    harness.registerWorkspace(workspaceRoot);

    const originalContent = readFileSync(
      path.join(workspaceRoot, "src", "parsers", "csv.js"),
      "utf8",
    );

    const fixedCode = `// CSV Parser utility - FIXED
function parseCSV(content) {
  return content
    .split("\\n")
    .filter(line => line.trim().length > 0)
    .map(line => line.split(","));
}
module.exports = { parseCSV };
`;

    const writeResult = await harness.executeTool({
      tool: "write_file",
      args: { path: "src/parsers/csv.js", content: fixedCode },
    });

    if (writeResult.tool !== "write_file") throw new Error("expected write_file");
    expect(writeResult.result.backedUp).toBe(true);
    expect(writeResult.result.backupPath).toBeTruthy();
    expect(writeResult.result.backupPath).toContain(".harness_backups");
    expect(writeResult.result.diff).toBeTruthy();

    // Verify backup contains exact original content
    const backupFullPath = path.join(workspaceRoot, writeResult.result.backupPath!);
    expect(existsSync(backupFullPath)).toBe(true);
    expect(readFileSync(backupFullPath, "utf8")).toBe(originalContent);

    // Verify workspace file has fixed content
    expect(readFileSync(path.join(workspaceRoot, "src", "parsers", "csv.js"), "utf8")).toBe(
      fixedCode,
    );
  });

  // ── Criterion 4: run_command executes with workspace as cwd ──────────
  it("Criterion 4: run_command executes inside workspace directory as cwd", async () => {
    harness.registerWorkspace(workspaceRoot);

    const res = await harness.executeTool({
      tool: "run_command",
      args: { command: "node -e 'console.log(process.cwd())'" },
    });

    if (res.tool !== "run_command") throw new Error("expected run_command");
    expect(res.result.exitCode).toBe(0);
    expect(res.result.stdout.trim()).toBe(workspaceRoot);
  });

  // ── Criterion 5: Path escape rejected by EVERY tool ──────────────────
  it("Criterion 5: path escape is rejected by every harness tool", async () => {
    harness.registerWorkspace(workspaceRoot);

    // list_dir
    await expect(
      harness.executeTool({ tool: "list_dir", args: { path: "../../" } }),
    ).rejects.toThrow(PermissionError);

    // read_file
    await expect(
      harness.executeTool({ tool: "read_file", args: { path: "../../../etc/passwd" } }),
    ).rejects.toThrow(PermissionError);

    await expect(
      harness.executeTool({ tool: "read_file", args: { path: "/etc/passwd" } }),
    ).rejects.toThrow(PermissionError);

    // search
    await expect(
      harness.executeTool({ tool: "search", args: { query: "root", path: "../../" } }),
    ).rejects.toThrow(PermissionError);

    // write_file
    await expect(
      harness.executeTool({
        tool: "write_file",
        args: { path: "../outside.txt", content: "bad" },
      }),
    ).rejects.toThrow(PermissionError);

    await expect(
      harness.executeTool({
        tool: "write_file",
        args: { path: "/tmp/escape.txt", content: "bad" },
      }),
    ).rejects.toThrow(PermissionError);
  });

  // ── Criterion 6: Full Loop: list → search → read → edit → run → fix → re-run
  it("Criterion 6: completes full autonomous task loop (list → search → read → run → fix → re-run)", async () => {
    // 1. User registers workspace
    harness.registerWorkspace(workspaceRoot);

    // 2. Initial listing to see shape of project (lazy context)
    const listRes = await harness.executeTool({ tool: "list_dir", args: {} }, "run-e2e");
    if (listRes.tool !== "list_dir") throw new Error("expected list_dir");
    expect(listRes.result.length).toBeGreaterThan(0);

    // 3. Initial verification: run the test suite to observe the failure
    const initialRun = await harness.executeTool(
      { tool: "run_command", args: { command: "node tests/test-parser.js" } },
      "run-e2e",
    );
    if (initialRun.tool !== "run_command") throw new Error("expected run_command");
    expect(initialRun.result.exitCode).toBe(1);
    expect(initialRun.result.stderr).toContain("empty line error");

    // 4. Search for the error string observed in the failure traceback
    const searchRes = await harness.executeTool(
      { tool: "search", args: { query: "empty line error" } },
      "run-e2e",
    );
    if (searchRes.tool !== "search") throw new Error("expected search");
    expect(searchRes.result.length).toBeGreaterThan(0);
    const targetFile = searchRes.result[0].file;

    // 5. Read the buggy file
    const readRes = await harness.executeTool(
      { tool: "read_file", args: { path: targetFile } },
      "run-e2e",
    );
    if (readRes.tool !== "read_file") throw new Error("expected read_file");
    expect(readRes.result).toContain("throw new Error(\"empty line error\")");

    // 6. Fix the code by writing the repaired version
    const fixedCode = `function parseCSV(content) {
  return content
    .split("\\n")
    .filter(line => line.trim().length > 0)
    .map(line => line.split(","));
}
module.exports = { parseCSV };
`;

    const writeRes = await harness.executeTool(
      { tool: "write_file", args: { path: targetFile, content: fixedCode } },
      "run-e2e",
    );
    if (writeRes.tool !== "write_file") throw new Error("expected write_file");
    expect(writeRes.result.backedUp).toBe(true);

    // 7. Re-run verification command: must now exit 0!
    const reRun = await harness.executeTool(
      { tool: "run_command", args: { command: "node tests/test-parser.js" } },
      "run-e2e",
    );
    if (reRun.tool !== "run_command") throw new Error("expected run_command");
    expect(reRun.result.exitCode).toBe(0);
    expect(reRun.result.stdout).toContain("PARSER_SUCCESS: 2");

    // 8. Verify live transcript events streamed into RunEvent pipeline
    const toolCalls = runEvents.filter((e) => e.type === "tool_call");
    const toolResults = runEvents.filter((e) => e.type === "tool_result");
    expect(toolCalls.length).toBeGreaterThanOrEqual(5);
    expect(toolResults.length).toBeGreaterThanOrEqual(5);
  });
});
