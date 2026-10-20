import { simulateCommandSandbox } from "./helpers/command-sandbox.js";
vi.mock("../src/main/tools/child-process.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/main/tools/child-process.js")>();
  return { ...actual, executeProcess: simulateCommandSandbox(actual.executeProcess) };
});
import { describe, expect, it, beforeEach, afterEach , vi } from "vitest";
import { parseToolCallArguments } from "../src/main/gateway/model-gateway.js";
import {
  extractPathArg,
  extractContentArg,
  extractCommandArg,
  writeFileTool,
  readFileTool,
  deleteFileTool,
  runCommandTool,
  normalizeRunCommandArgs,
  searchTool,
} from "../src/main/tools/workspace-tools.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDocxBuffer } from "../src/main/tools/artifacts.js";
import ExcelJS from "exceljs";
import { absoluteDataPath } from "../src/main/run/filesystem.js";
import { generateDeliverableTool } from "../src/main/tools/specialist-tools.js";
import { AgentLoop } from "./helpers/agent-loop-fixture.js";

describe("Tool Argument Parsing Resilience", () => {
  describe("parseToolCallArguments", () => {
    it("parses valid JSON string arguments", () => {
      const input = JSON.stringify({ path: "routes/hello.ts", content: "console.log('hi');" });
      const res = parseToolCallArguments(input);
      expect(res.path).toBe("routes/hello.ts");
      expect(res.content).toBe("console.log('hi');");
    });

    it("unwraps double-stringified JSON", () => {
      const inner = JSON.stringify({ path: "routes/hello.ts", content: "console.log('hi');" });
      const double = JSON.stringify(inner);
      const res = parseToolCallArguments(double);
      expect(res.path).toBe("routes/hello.ts");
      expect(res.content).toBe("console.log('hi');");
    });

    it("decodes complete single-quoted data without changing literal source escapes", () => {
      const raw = String.raw`{path:'module.py', content:'print("a\\nb")',}`;
      expect(parseToolCallArguments(raw)).toEqual({ path: "module.py", content: String.raw`print("a\nb")` });
      expect(parseToolCallArguments("{command:'python3 -B', missing: NaN}")).toHaveProperty("raw");
      expect(parseToolCallArguments("{command:'python3 -B', missing: None}")).toHaveProperty("raw");
    });

    it("repairs and parses raw unescaped newlines and tabs inside string literals", () => {
      // Raw newline (not \n escape sequence) inside JSON string literal
      const badJson = '{"path": "routes/index.ts", "content": "import express from \'express\';\nconst app = express();\nexport default app;"}';
      const res = parseToolCallArguments(badJson);
      expect(res.path).toBe("routes/index.ts");
      expect(res.content).toContain("import express");
      expect(res.content).toContain("export default app;");
    });

    it("rejects truncated executable strings instead of recovering partial code", () => {
      const raw = '{"path":"src/app.ts","content":"console.log(1);';
      expect(parseToolCallArguments(raw)).toEqual({ raw });
    });

    it("rejects Python triple quoted tool arguments", () => {
      const raw = '{"path":"module.py","content": """def parse(text):\n    return text.split(\'\\n\')\n"""}';
      expect(parseToolCallArguments(raw)).toEqual({ raw });
    });

    it("preserves literal source escapes and command escapes exactly", () => {
      const content = String.raw`print('a\nb')`;
      const command = String.raw`python3 -c "print('a\nb')"`;
      const parsed = parseToolCallArguments(JSON.stringify({ content, command }));
      expect(parsed).toEqual({ content, command });
      expect(extractContentArg(parsed)).toBe(content);
    });

  });

  describe("workspace tool extractors", () => {
    it("extracts path across common parameter aliases", () => {
      expect(extractPathArg({ path: "app.ts" })).toBe("app.ts");
      expect(extractPathArg({ filePath: "app.ts" })).toBe("app.ts");
      expect(extractPathArg({ file_path: "app.ts" })).toBe("app.ts");
      expect(extractPathArg({ filename: "app.ts" })).toBe("app.ts");
      expect(extractPathArg({ file: "app.ts" })).toBe("app.ts");
      expect(extractPathArg({ target: "app.ts" })).toBe("app.ts");
      expect(extractPathArg({ destination: "app.ts" })).toBe("app.ts");
    });

    it("unwraps nested parameters and arguments wrappers", () => {
      expect(extractPathArg({ parameters: { path: "routes/hello.ts" } })).toBe("routes/hello.ts");
      expect(extractPathArg({ arguments: { filePath: "routes/hello.ts" } })).toBe("routes/hello.ts");
      expect(extractPathArg({ input: { filename: "routes/hello.ts" } })).toBe("routes/hello.ts");
      expect(extractContentArg({ parameters: { content: "export default {};" } })).toBe("export default {};");
      expect(extractCommandArg({ parameters: { command: "npm test" } })).toBe("npm test");
    });

    it("extracts path and content from raw JSON strings", () => {
      const rawArgs = { raw: '{"path": "routes/ping.ts", "content": "export const ping = true;"}' };
      expect(extractPathArg(rawArgs)).toBe("routes/ping.ts");
      expect(extractContentArg(rawArgs)).toBe("export const ping = true;");
    });

    it("extracts command across aliases", () => {
      expect(extractCommandArg({ command: "npm test" })).toBe("npm test");
      expect(extractCommandArg({ cmd: "npm test" })).toBe("npm test");
      expect(extractCommandArg({ shell_command: "npm test" })).toBe("npm test");
      expect(extractCommandArg({ script: "npm test" })).toBe("npm test");
    });
  });

  describe("tool executions with aliased arguments", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "resilience-test-"));
    });

    afterEach(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it.each(["docx", "xlsx", "pdf"])("rejects text writes to %s documents before creating or corrupting them", async (extension) => {
      const filename = `existing.${extension}`;
      const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
      writeFileSync(path.join(tmpDir, filename), original);
      const context = { workspaceRoot: tmpDir, runId: randomUUID(), gateway: {} as any };
      for (const target of [filename, `new.${extension}`]) {
        await expect(writeFileTool.execute({ path: target, content: "# Revised document" }, context))
          .rejects.toMatchObject({ code: "invalid_arguments", retryable: true });
      }
      expect(readFileSync(path.join(tmpDir, filename))).toEqual(original);
      expect(existsSync(path.join(tmpDir, `new.${extension}`))).toBe(false);
      expect(existsSync(absoluteDataPath(`runs/${context.runId}`))).toBe(false);
    });

    it("writeFileTool succeeds with filePath alias and nested parameters", async () => {
      const context = { workspaceRoot: tmpDir, runId: "test-run", gateway: {} as any };

      // 1. Alias filePath
      const res1 = await writeFileTool.execute({ filePath: "routes/hello.ts", content: "console.log(1);" }, context);
      expect(res1.summary).toContain('Wrote "routes/hello.ts"');

      // 2. Nested parameters with file alias
      const res2 = await writeFileTool.execute({ parameters: { file: "routes/index.ts", code: "console.log(2);" } }, context);
      expect(res2.summary).toContain('Wrote "routes/index.ts"');

      // 3. Raw string
      const res3 = await writeFileTool.execute({ raw: '{"path": "routes/ping.ts", "content": "console.log(3);"}' }, context);
      expect(res3.summary).toContain('Wrote "routes/ping.ts"');
    });

    it("readFileTool succeeds with filename alias", async () => {
      const context = { workspaceRoot: tmpDir, runId: "test-run", gateway: {} as any };
      writeFileSync(path.join(tmpDir, "app.ts"), "const a = 1;");

      const res = await readFileTool.execute({ filename: "app.ts" }, context);
      expect(res.output).toContain("const a = 1;");
    });

    it("reads an exact indexed source when its workspace file is absent without substituting unrelated evidence", async () => {
      let queries = 0;
      let docId = "source-id";
      const context = { workspaceRoot: tmpDir, runId: randomUUID(), gateway: {} as any,
        indexedKnowledgeSources: [{ filename: "flow.txt", docId }],
        grounding: { async prepare() { queries++; return { chunks: [{ docId, chunkId: "chunk-id", page: 2, text: "Measured flow: 27 L/s." }] }; } } as any };
      const result = await readFileTool.execute({ path: "flow.txt" }, context);
      expect(result.output).toContain("Measured flow: 27 L/s.");
      expect(result.summary).toContain("knowledge base; no workspace file");
      expect(existsSync(path.join(tmpDir, "flow.txt"))).toBe(false);
      await expect(readFileTool.execute({ path: "absent.txt" }, context)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFileTool.execute({ path: "../flow.txt" }, context)).rejects.toThrow();
      expect(queries).toBe(1);
      docId = "unrelated-id";
      await expect(readFileTool.execute({ path: "flow.txt" }, context)).rejects.toMatchObject({ code: "ENOENT" });
      expect(queries).toBe(2);
    });

    it("deleteFileTool succeeds with file_path alias", async () => {
      const context = { workspaceRoot: tmpDir, runId: "test-run", gateway: {} as any };
      writeFileSync(path.join(tmpDir, "temp.js"), "const x = 1;");

      const res = await deleteFileTool.execute({ file_path: "temp.js" }, context);
      expect(res.summary).toContain('Deleted "temp.js"');
    });

    it("searchTool succeeds with search_query alias", async () => {
      const context = { workspaceRoot: tmpDir, runId: "test-run", gateway: {} as any };
      writeFileSync(path.join(tmpDir, "greet.ts"), "hello local world");

      const res = await searchTool.execute({ search_query: "local" }, context);
      expect(res.summary).toContain("Found 1 matches");
    });

    it("rejects malformed structured checks without executing a fallback shell command", async () => {
      await expect(runCommandTool.execute({ command: "touch forbidden", python_validation: {
        module: "module", function: "read", cases: [{ text_rows: ["input"] }],
      } }, { workspaceRoot: tmpDir, runId: "invalid", gateway: {} as any })).rejects.toMatchObject({ code: "invalid_arguments" });
      expect(existsSync(path.join(tmpDir, "forbidden"))).toBe(false);
    });

    it("does not accept proposed CSV checks when the mandatory test stage has no durable execution context", async () => {
      writeFileSync(path.join(tmpDir, "README.md"), "protected\n");
      const runId = randomUUID(), events: any[] = [], approvals: any[] = [];
      const turns = [
        { content: null, tool_calls: [{ id: "write", name: "write_file", arguments: { path: "module.py", content: "import csv, io\ndef read_csv(text): return list(csv.DictReader(io.StringIO(text)))\n" } }] },
        { content: null, tool_calls: [{ id: "validate", name: "run_command", arguments: { command: "python3 -B", python_module: "module", python_function: "read_csv", python_reference_pipeline: ["io:StringIO", "csv:DictReader", "builtins:list"], success_marker: "CHECK_OK", python_text_rows: ["field,value", '"quoted, field",17', "", "missing"] } }] },
        { content: "Verified.", tool_calls: null },
      ];
      let turn = 0;
      const gateway = { async chatWithTools() { return { ok: true, value: turns[turn++] }; } };
      const result = await new AgentLoop().run({ runId, driverModelId: "code-qwen25coder",
        userPrompt: "Repair module.py's read_csv(text) CSV parser for quoted fields, blank lines and missing values. Validate the written parser and print CHECK_OK only if it passes.", systemPrompt: "repair",
        semanticIntent: { intentType: "code_modification", workspaceMutationRequested: true, targetFiles: ["module.py"], protectedPaths: ["README.md"], restrictMutationsToTargets: true },
        tools: [writeFileTool, runCommandTool], context: { runId, workspaceRoot: tmpDir, gateway: gateway as any }, emitEvent(event) { events.push(event); },
        async onPlanConfirmationRequired(_plan, calls) { approvals.push(...calls); return true; },
      });
      expect(result.outcome).toBe("partial");
      expect(result.finalText).toContain("durable test execution context");
      expect(readFileSync(path.join(tmpDir, "module.py"), "utf8")).toContain("def read_csv");
      expect(approvals.some(call => call.name === "run_command")).toBe(false);
      expect(events.some(event => event.type === "tool_result" && event.tool === "run_command")).toBe(false);
      expect(existsSync(path.join(tmpDir, "__pycache__"))).toBe(false);
    });

    it("runs structured function checks and prints success only after all assertions pass", async () => {
      writeFileSync(path.join(tmpDir, "module.py"), "import csv, io\ndef read(text): return list(csv.DictReader(io.StringIO(text)))\n");
      const args = { command: "python3 -B", python_validation: {
        module: "module", function: "read", success_marker: "CHECK_OK",
        cases: [{ args: ['field,value\n"quoted, field",17\n'], expected: [{ field: "quoted, field", value: "17" }] },
          { args: ['field,value\nmissing\n'], expected: [{ field: "missing", value: null }] }],
      } };
      expect(normalizeRunCommandArgs(normalizeRunCommandArgs(args))).toEqual(normalizeRunCommandArgs(args));
      const context = { workspaceRoot: tmpDir, runId: "structured", gateway: {} as any };
      const result = JSON.parse((await runCommandTool.execute(args, context)).output!);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CHECK_OK");
      const rowsResult = JSON.parse((await runCommandTool.execute({ command: "python3 -B", python_validation: {
        module: "module", function: "read", success_marker: "ROWS_OK",
        cases: [{ text_rows: ["field,value", "", '"quoted, field",17', "missing"], expected: [
          { field: "quoted, field", value: "17" }, { field: "missing", value: null },
        ] }],
      } }, context)).output!);
      expect(rowsResult.stdout).toContain("ROWS_OK");
      expect(rowsResult.exitCode).toBe(0);
      const flatArgs = { command: "python3 -B", python_module: "module", python_function: "read",
        python_text_rows: ["field,value", "", '"quoted, field",17', "missing"],
        python_reference_pipeline: ["io:StringIO", "csv:DictReader", "builtins:list"], success_marker: "FLAT_OK" };
      expect(normalizeRunCommandArgs(normalizeRunCommandArgs(flatArgs))).toEqual(normalizeRunCommandArgs(flatArgs));
      const flatResult = JSON.parse((await runCommandTool.execute(flatArgs, context)).output!);
      expect(flatResult.stdout).toContain("FLAT_OK");
      expect(flatResult.exitCode).toBe(0);
      const referenceArgs = { command: "python3 -B", python_module: "module", python_function: "read",
        python_text_rows: flatArgs.python_text_rows, python_reference_pipeline: ["io:StringIO", "csv:DictReader", "builtins:list"], success_marker: "REFERENCE_OK" };
      const referenceResult = JSON.parse((await runCommandTool.execute(referenceArgs, context)).output!);
      expect(referenceResult.stdout).toContain("REFERENCE_OK");
      writeFileSync(path.join(tmpDir, "module.py"), "def read(text): return []\n");
      const brokenReferenceResult = JSON.parse((await runCommandTool.execute(referenceArgs, context)).output!);
      expect(brokenReferenceResult.exitCode).toBe(1);
      expect(brokenReferenceResult.stdout).toBe("");
      writeFileSync(path.join(tmpDir, "module.py"), "import csv, io\ndef read(text): return list(csv.DictReader(io.StringIO(text)))\n");
      args.python_validation.cases[0].expected = [];
      const failed = JSON.parse((await runCommandTool.execute(args, context)).output!);
      expect(failed.exitCode).toBe(1);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).toContain("AssertionError");
      expect(existsSync(path.join(tmpDir, "__pycache__"))).toBe(false);
    });

    it("runs typed Python validation with quoted CSV fields preserved and no helper files", async () => {
      writeFileSync(path.join(tmpDir, "module.py"), "import csv, io\ndef read(text): return list(csv.DictReader(io.StringIO(text)))\n");
      const code = String.raw`import module
assert module.read('field,value\n"quoted, field",17\n') == [{'field':'quoted, field','value':'17'}]
print('CHECK_OK')`;
      const args = { command: "python3 -B", python_code: code };
      const normalized = normalizeRunCommandArgs(args);
      expect(String(normalized.command)).toContain(code);
      expect(normalizeRunCommandArgs(normalized)).toEqual(normalized);
      const result = await runCommandTool.execute(normalized, { workspaceRoot: tmpDir, runId: "test-run", gateway: {} as any });
      const execution = JSON.parse(result.output);
      expect(execution.exitCode).toBe(0);
      expect(execution.stdout.trim()).toBe("CHECK_OK");
      expect(requireNoHelpers()).toBe(true);
      function requireNoHelpers() { return !existsSync(path.join(tmpDir, "__pycache__")) && !existsSync(path.join(tmpDir, "test_module.py")); }
    });

    it("createDocxBuffer parses bulleted markdown tables into valid docx without errors", async () => {
      const markdown = `# Technical Inspection Approval Note
## Findings & Measurements
- | Equipment | Location | Measured Value | Allowable Limit | Status |
- | --- | --- | --- | --- | --- |
- | E-201 | Tube Wall | 3.8 mm | 4.6 mm | Non-Compliant |
- | E-202 | Tube Wall | 4.0 mm | 4.6 mm | Non-Compliant |

## Corrective Actions
1. Recheck weld joint 4B.
2. Replace gasket.`;

      const buf = await createDocxBuffer(markdown);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(1000);
    });

    it("generateDeliverableTool rejects template outline placeholders when no completed table exists", async () => {
      const context = { workspaceRoot: tmpDir, runId: "test-run", gateway: {} as any };

      await expect(
        generateDeliverableTool.execute(
          {
            type: "docx",
            filename: "approval-note.docx",
            content: "### Findings & Measurements\nMarkdown table with columns | Equipment | Measured Value |",
          },
          context,
        ),
      ).rejects.toThrow(/template placeholder text/);
    });

    it("generateDeliverableTool enriches template placeholder when context.lastAssistantContent has real table", async () => {
      const context = {
        workspaceRoot: tmpDir,
        runId: randomUUID(),
        gateway: {} as any,
        lastAssistantContent: `### Findings & Measurements\n| Equipment | Measured Value | Allowable Limit | Status |\n| --- | --- | --- | --- |\n| E-201 | 3.8 mm | 4.6 mm | Non-Compliant |\n| E-202 | 4.0 mm | 4.6 mm | Non-Compliant |`,
      };

      const res = await generateDeliverableTool.execute(
        {
          type: "docx",
          filename: "approval-note.docx",
          content: "### Findings & Measurements\nMarkdown table with columns | Equipment | Measured Value |",
        },
        context,
      );

      expect(res.artifacts).toBeDefined();
      expect(res.artifacts?.[0].filename).toBe("approval-note.docx");
      expect(res.summary).toContain("approval-note.docx");
    });

    it("generateDeliverableTool creates styled Excel deliverable from markdown table content", async () => {
      const context = { workspaceRoot: tmpDir, runId: randomUUID(), gateway: {} as any };

      const res = await generateDeliverableTool.execute(
        {
          type: "xlsx",
          filename: "findings.xlsx",
          title: "Engineering Inspection Findings",
          content: `| Component | Thickness (mm) | Limit (mm) | Compliance |\n| --- | --- | --- | --- |\n| Tube Row 12 | 3.8 | 4.6 | FAIL |\n| Shell Nozzle | 1.8 | 3.0 | WARNING |`,
        },
        context,
      );

      expect(res.artifacts).toBeDefined();
      expect(res.artifacts?.[0].kind).toBe("xlsx");
      expect(res.artifacts?.[0].filename).toBe("findings.xlsx");
      expect(res.summary).toContain("findings.xlsx");
    });

    it("keeps the requested document filename and rejects extra artifacts", async () => {
      const context = { workspaceRoot: tmpDir, runId: randomUUID(), gateway: {} as any,
        requestedArtifacts: [{ type: "docx", filename: "inspection-review.docx" }] };
      const content = "# Inspection review\n\nThe source records a completed inspection with no measured torque.";
      await expect(generateDeliverableTool.execute({ type: "docx", filename: "other.docx", content }, context))
        .rejects.toMatchObject({ code: "invalid_arguments", retryable: true });
      expect(existsSync(absoluteDataPath(`runs/${context.runId}`))).toBe(false);
      const result = await generateDeliverableTool.execute({ type: "docx", content }, context);
      expect(result.artifacts?.[0].filename).toBe("inspection-review.docx");
      expect(readFileSync(absoluteDataPath(result.artifacts![0].relativePath)).subarray(0, 2).toString()).toBe("PK");
      rmSync(absoluteDataPath(`runs/${context.runId}`), { recursive: true, force: true });
    });

    it("preserves prose citations and absent measurements alongside Excel tables", async () => {
      const context = { workspaceRoot: tmpDir, runId: randomUUID(), gateway: {} as any };
      const result = await generateDeliverableTool.execute({
        type: "xlsx", filename: "observations.xlsx", content: "# Observations\n\n| Quantity | Value |\n| --- | --- |\n| Flow | 24 L/s |\n\n**Note:** Torque was not measured.\n**Source:** source.pdf, page 3",
      }, context);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(absoluteDataPath(result.artifacts![0].relativePath));
      const cells: string[] = [];
      workbook.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value)))));
      expect(cells.join("\n")).toContain("24 L/s");
      expect(cells.join("\n")).toContain("Torque was not measured");
      expect(cells.join("\n")).toContain("source.pdf, page 3");
    });

    it("compiles real Markdown field lists into Excel without requiring a table", async () => {
      const context = { workspaceRoot: tmpDir, runId: randomUUID(), gateway: {} as any, sourceReferences: [{ filename: "instrument.pdf", page: 7 }] };
      const result = await generateDeliverableTool.execute({ type: "xlsx", filename: "field-report.xlsx", content: "# Measurement Report\n- **Flow:** 24 L/s\n- **Speed:** 120 rpm\n\n**Note:** Torque was not measured.\n**Source:** source.pdf page 3" }, context);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(absoluteDataPath(result.artifacts![0].relativePath));
      expect(workbook.worksheets[0].getRow(2).getCell(1).value).toBe("Flow");
      expect(workbook.worksheets[0].getRow(2).getCell(2).value).toBe("24 L/s");
      const values: string[] = [];
      workbook.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value)))));
      expect(values.join("\n")).toContain("Torque was not measured");
      expect(values.join("\n")).toContain("source.pdf page 3");
      expect(values.join("\n")).toContain("instrument.pdf, page 7");
    });

    it("readFileTool returns friendly advice when reading binary image files instead of crashing", async () => {
      const context = { workspaceRoot: tmpDir, runId: "test-run", gateway: {} as any };
      writeFileSync(path.join(tmpDir, "diagram.png"), "fake binary content");

      const res = await readFileTool.execute({ path: "diagram.png" }, context);
      expect(res.output).toContain("binary image");
      expect(res.output).toContain("extract_document");
    });

    it("generateDeliverableTool automatically substitutes [insert table] placeholder with real assistant table", async () => {
      const context = {
        workspaceRoot: tmpDir,
        runId: randomUUID(),
        gateway: {} as any,
        lastAssistantContent: `### Inspection Findings\n| Component | Value | Limit | Status |\n| --- | --- | --- | --- |\n| Tank A | 12 psi | 15 psi | COMPLIANT |`,
      };

      const res = await generateDeliverableTool.execute(
        {
          type: "docx",
          filename: "report.docx",
          content: "# Inspection Summary\n\n## 1. Findings\n[insert table]\n\n## 2. Recommendation\nProceed with operations.",
        },
        context,
      );

      expect(res.artifacts).toBeDefined();
      expect(res.artifacts?.[0].filename).toBe("report.docx");
    });
  });
});
