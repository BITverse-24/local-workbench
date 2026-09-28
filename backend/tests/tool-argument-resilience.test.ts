import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { parseToolCallArguments } from "../src/main/gateway/model-gateway.js";
import {
  extractPathArg,
  extractContentArg,
  extractCommandArg,
  writeFileTool,
  readFileTool,
  deleteFileTool,
  runCommandTool,
  searchTool,
} from "../src/main/tools/workspace-tools.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDocxBuffer } from "../src/main/tools/artifacts.js";
import { generateDeliverableTool } from "../src/main/tools/specialist-tools.js";

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

    it("repairs and parses raw unescaped newlines and tabs inside string literals", () => {
      // Raw newline (not \n escape sequence) inside JSON string literal
      const badJson = '{"path": "routes/index.ts", "content": "import express from \'express\';\nconst app = express();\nexport default app;"}';
      const res = parseToolCallArguments(badJson);
      expect(res.path).toBe("routes/index.ts");
      expect(res.content).toContain("import express");
      expect(res.content).toContain("export default app;");
    });

    it("falls back to regex extraction when JSON syntax is truncated or corrupted", () => {
      const brokenJson = '{"path": "src/app.ts", "content": "import express from \\"express\\"; console.log(1);';
      const res = parseToolCallArguments(brokenJson);
      expect(res.path).toBe("src/app.ts");
      expect(res.content).toContain("import express");
    });

    it("unescapes double-escaped newlines and tabs from JSON string arguments", () => {
      // LLMs frequently emit \\n inside string arguments when generating function calls
      const doubleEscapedJson = '{"path": "fixed-parser.py", "content": "import sys\\\\nimport csv\\\\n\\\\ndef summarize():\\\\n    return 42"}';
      const res = parseToolCallArguments(doubleEscapedJson);
      expect(res.path).toBe("fixed-parser.py");
      expect(typeof res.content).toBe("string");
      expect(res.content).toContain("\n");
      expect(res.content).not.toContain("\\n");
      expect((res.content as string).split("\n").length).toBe(5);
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

    it("deleteFileTool succeeds with file_path alias", async () => {
      const context = { workspaceRoot: tmpDir, runId: "test-run", gateway: {} as any };
      writeFileSync(path.join(tmpDir, "temp.js"), "const x = 1;");

      const res = await deleteFileTool.execute({ file_path: "temp.js" }, context);
      expect(res.summary).toContain('Deleted "temp.js"');
    });

    it("searchTool succeeds with search_query alias", async () => {
      const context = { workspaceRoot: tmpDir, runId: "test-run", gateway: {} as any };
      writeFileSync(path.join(tmpDir, "greet.ts"), "hello sovereign world");

      const res = await searchTool.execute({ search_query: "sovereign" }, context);
      expect(res.summary).toContain("Found 1 matches");
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

    it("generateDeliverableTool rejects template outline placeholders and requests completed rows", async () => {
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
  });
});
