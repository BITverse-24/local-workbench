import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ToolDispatcher, classifyToolError } from "../src/main/agent/tool-dispatcher.js";
import { AgentLoop } from "../src/main/agent/agent-loop.js";
import { PermissionError } from "../src/main/harness/path-guard.js";
import { readFileTool, writeFileTool } from "../src/main/tools/workspace-tools.js";
import type { AgentTool, ToolExecutionContext, ToolResult, ToolErrorCode } from "../src/main/tools/types.js";
import type { RunEvent } from "../src/shared/contracts.js";

describe("P0-03: Typed Tool Execution Results", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "workbench-p0-03-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("classifyToolError Error Taxonomy", () => {
    it("classifies invalid arguments with retryable: true", () => {
      const err1 = new Error("path parameter is required. Received arguments: {}");
      const err2 = new Error("extract_document requires a filename or path parameter");
      const err3 = new Error("missing required argument 'content'");
      const err4 = Object.assign(new Error("bad arg"), { code: "INVALID_ARGUMENTS" });

      const res1 = classifyToolError(err1, "read_file");
      const res2 = classifyToolError(err2, "extract_document");
      const res3 = classifyToolError(err3, "write_file");
      const res4 = classifyToolError(err4, "custom");

      expect(res1.code).toBe("invalid_arguments");
      expect(res1.retryable).toBe(true);
      expect(res2.code).toBe("invalid_arguments");
      expect(res2.retryable).toBe(true);
      expect(res3.code).toBe("invalid_arguments");
      expect(res3.retryable).toBe(true);
      expect(res4.code).toBe("invalid_arguments");
      expect(res4.retryable).toBe(true);
    });

    it("classifies permission and sandbox containment denials with retryable: false", () => {
      const err1 = new PermissionError("absolute path rejected: /etc/passwd");
      const err2 = new PermissionError("path resolves outside workspace root");
      const err3 = Object.assign(new Error("EACCES: permission denied, open '/var/log'"), { code: "EACCES" });
      const err4 = Object.assign(new Error("operation not permitted"), { code: "EPERM" });

      const res1 = classifyToolError(err1, "read_file");
      const res2 = classifyToolError(err2, "write_file");
      const res3 = classifyToolError(err3, "run_command");
      const res4 = classifyToolError(err4, "delete_file");

      expect(res1.code).toBe("permission_denied");
      expect(res1.retryable).toBe(false);
      expect(res2.code).toBe("permission_denied");
      expect(res2.retryable).toBe(false);
      expect(res3.code).toBe("permission_denied");
      expect(res3.retryable).toBe(false);
      expect(res4.code).toBe("permission_denied");
      expect(res4.retryable).toBe(false);
    });

    it("classifies file not found with retryable: true", () => {
      const err1 = Object.assign(new Error("ENOENT: no such file or directory, open 'missing.txt'"), { code: "ENOENT" });
      const err2 = new Error("Attached file 'drawing.pdf' not found in run directories or workspace");
      const err3 = new Error("file does not exist: /path/to/log.txt");

      const res1 = classifyToolError(err1, "read_file");
      const res2 = classifyToolError(err2, "extract_document");
      const res3 = classifyToolError(err3, "read_file");

      expect(res1.code).toBe("file_not_found");
      expect(res1.retryable).toBe(true);
      expect(res2.code).toBe("file_not_found");
      expect(res2.retryable).toBe(true);
      expect(res3.code).toBe("file_not_found");
      expect(res3.retryable).toBe(true);
    });

    it("classifies timeouts with retryable: true", () => {
      const err1 = Object.assign(new Error("ETIMEDOUT: connection timed out"), { code: "ETIMEDOUT" });
      const err2 = new Error("Command execution timed out after 60000ms");
      const err3 = new Error("Execution deadline exceeded");

      const res1 = classifyToolError(err1, "gateway");
      const res2 = classifyToolError(err2, "run_command");
      const res3 = classifyToolError(err3, "execute_python");

      expect(res1.code).toBe("timeout");
      expect(res1.retryable).toBe(true);
      expect(res2.code).toBe("timeout");
      expect(res2.retryable).toBe(true);
      expect(res3.code).toBe("timeout");
      expect(res3.retryable).toBe(true);
    });

    it("distinguishes timeout and permission failures clearly", () => {
      const timeoutRes = classifyToolError(new Error("timed out"), "run_command");
      const permRes = classifyToolError(new PermissionError("outside workspace"), "run_command");

      expect(timeoutRes.code).toBe("timeout");
      expect(timeoutRes.retryable).toBe(true);

      expect(permRes.code).toBe("permission_denied");
      expect(permRes.retryable).toBe(false);

      expect(timeoutRes.code).not.toBe(permRes.code);
    });

    it("classifies sandbox failures with retryable: true", () => {
      const err1 = new Error("Python script exited with code 1");
      const err2 = new Error("bwrap: bubblewrap sandbox execution failed");
      const err3 = Object.assign(new Error("process crashed in sandbox"), { name: "SandboxError" });

      const res1 = classifyToolError(err1, "execute_python");
      const res2 = classifyToolError(err2, "run_command");
      const res3 = classifyToolError(err3, "execute_python");

      expect(res1.code).toBe("sandbox_failure");
      expect(res1.retryable).toBe(true);
      expect(res2.code).toBe("sandbox_failure");
      expect(res2.retryable).toBe(true);
      expect(res3.code).toBe("sandbox_failure");
      expect(res3.retryable).toBe(true);
    });

    it("classifies model gateway failures with retryable: true", () => {
      const err1 = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
      const err2 = new Error("Model gateway fetch failed: 502 Bad Gateway");
      const err3 = new Error("Local llama-server endpoint is unavailable");

      const res1 = classifyToolError(err1, "extract_document");
      const res2 = classifyToolError(err2, "draft_note");
      const res3 = classifyToolError(err3, "draft_code");

      expect(res1.code).toBe("gateway_failure");
      expect(res1.retryable).toBe(true);
      expect(res2.code).toBe("gateway_failure");
      expect(res2.retryable).toBe(true);
      expect(res3.code).toBe("gateway_failure");
      expect(res3.retryable).toBe(true);
    });

    it("classifies validation failures with retryable: true", () => {
      const err1 = Object.assign(new Error("Expected string, received number"), { name: "ZodError" });
      const err2 = Object.assign(new Error("Schema validation failed: missing key findings"), { name: "ValidationError" });

      const res1 = classifyToolError(err1, "extract_document");
      const res2 = classifyToolError(err2, "draft_note");

      expect(res1.code).toBe("validation_failure");
      expect(res1.retryable).toBe(true);
      expect(res2.code).toBe("validation_failure");
      expect(res2.retryable).toBe(true);
    });

    it("classifies tool not found with retryable: false", () => {
      const err = new Error('Tool "unknown_tool" is not available in the active environment.');
      const res = classifyToolError(err, "unknown_tool");

      expect(res.code).toBe("tool_not_found");
      expect(res.retryable).toBe(false);
    });

    it("classifies unexpected internal errors as internal_error with retryable: false", () => {
      const err = new Error("Unexpected V8 memory heap allocation failure");
      const res = classifyToolError(err, "any_tool");

      expect(res.code).toBe("internal_error");
      expect(res.retryable).toBe(false);
    });
  });

  describe("ToolDispatcher Boundary Normalization", () => {
    it("returns typed ok: false when tool is not registered", async () => {
      const dispatcher = new ToolDispatcher([]);
      const emittedEvents: RunEvent[] = [];

      const outputs = await dispatcher.dispatchConcurrent(
        [{ id: "call-1", name: "missing_tool", arguments: {} }],
        {
          runId: "run-test",
          workspaceRoot: tempDir,
          gateway: {} as any,
          emitRunEvent: (e) => emittedEvents.push(e),
        },
      );

      expect(outputs).toHaveLength(1);
      const out = outputs[0]!;
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.code).toBe("tool_not_found");
        expect(out.result.error.retryable).toBe(false);
        expect(out.result.error.message).toContain("missing_tool");
      }

      const event = emittedEvents.find((e) => e.type === "tool_result") as any;
      expect(event).toBeDefined();
      expect(event.ok).toBe(false);
      expect(event.error?.code).toBe("tool_not_found");
    });

    it("returns typed ok: true with parsed data for successful tools", async () => {
      const sampleTool: AgentTool = {
        name: "test_tool",
        definition: {
          type: "function",
          function: { name: "test_tool", description: "test", parameters: { type: "object", properties: {} } },
        },
        async execute() {
          return {
            output: JSON.stringify({ status: "success", items: [1, 2, 3] }),
            summary: "Executed test_tool",
          };
        },
      };

      const dispatcher = new ToolDispatcher([sampleTool]);
      const outputs = await dispatcher.dispatchConcurrent(
        [{ id: "call-1", name: "test_tool", arguments: {} }],
        { runId: "run-test", workspaceRoot: tempDir, gateway: {} as any },
      );

      expect(outputs).toHaveLength(1);
      const res = outputs[0]!.result;
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data).toEqual({ status: "success", items: [1, 2, 3] });
        expect(res.output).toContain('"status":"success"');
        expect(res.summary).toBe("Executed test_tool");
        expect(typeof res.durationMs).toBe("number");
      }
    });

    it("CRITICAL: does NOT misclassify legitimate file content beginning with 'Error'", async () => {
      // Create a file whose content literally starts with "Error"
      const errorLogPath = path.join(tempDir, "error.log");
      const fileContent = "Error: [CRITICAL] Database connection pool exhausted at 04:15:22 UTC\nError: Service halted.";
      writeFileSync(errorLogPath, fileContent, "utf8");

      const dispatcher = new ToolDispatcher([readFileTool]);
      const emittedEvents: RunEvent[] = [];

      const outputs = await dispatcher.dispatchConcurrent(
        [{ id: "call-1", name: "read_file", arguments: { path: "error.log" } }],
        {
          runId: "run-test",
          workspaceRoot: tempDir,
          gateway: {} as any,
          emitRunEvent: (e) => emittedEvents.push(e),
        },
      );

      expect(outputs).toHaveLength(1);
      const res = outputs[0]!.result;

      // The execution was completely successful — reading the file succeeded!
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.output).toBe(fileContent);
        expect(res.data).toBe(fileContent);
      }

      // Event emitted should have ok: true
      const resultEvent = emittedEvents.find((e) => e.type === "tool_result") as any;
      expect(resultEvent).toBeDefined();
      expect(resultEvent.ok).toBe(true);
      expect(resultEvent.error).toBeUndefined();
    });

    it("guarantees exceptions cannot accidentally become successful observations", async () => {
      const throwingTool: AgentTool = {
        name: "throwing_tool",
        definition: {
          type: "function",
          function: { name: "throwing_tool", description: "throws", parameters: { type: "object", properties: {} } },
        },
        async execute() {
          throw new PermissionError("Access denied: path outside workspace");
        },
      };

      const dispatcher = new ToolDispatcher([throwingTool]);
      const outputs = await dispatcher.dispatchConcurrent(
        [{ id: "call-1", name: "throwing_tool", arguments: {} }],
        { runId: "run-test", workspaceRoot: tempDir, gateway: {} as any },
      );

      expect(outputs).toHaveLength(1);
      const res = outputs[0]!.result;
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("permission_denied");
        expect(res.error.retryable).toBe(false);
        expect(res.error.message).toContain("Access denied");
      }
    });

    it("normalizes execute_python sandbox failures into typed ok: false", async () => {
      const pythonTool: AgentTool = {
        name: "execute_python",
        definition: {
          type: "function",
          function: { name: "execute_python", description: "py", parameters: { type: "object", properties: {} } },
        },
        async execute() {
          return {
            output: JSON.stringify({
              exitCode: 1,
              stdout: "",
              stderr: "Traceback (most recent call last):\nZeroDivisionError: division by zero",
              timedOut: false,
              outputFiles: [],
              durationMs: 120,
            }),
            summary: "Executed Python script in sandbox",
          };
        },
      };

      const dispatcher = new ToolDispatcher([pythonTool]);
      const outputs = await dispatcher.dispatchConcurrent(
        [{ id: "call-1", name: "execute_python", arguments: {} }],
        { runId: "run-test", workspaceRoot: tempDir, gateway: {} as any },
      );

      expect(outputs).toHaveLength(1);
      const res = outputs[0]!.result;
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("sandbox_failure");
        expect(res.error.retryable).toBe(true);
        expect(res.error.message).toContain("ZeroDivisionError");
      }
    });

    it("normalizes execute_python timeouts into typed ok: false with timeout code", async () => {
      const pythonTool: AgentTool = {
        name: "execute_python",
        definition: {
          type: "function",
          function: { name: "execute_python", description: "py", parameters: { type: "object", properties: {} } },
        },
        async execute() {
          return {
            output: JSON.stringify({
              exitCode: 1,
              stdout: "",
              stderr: "",
              timedOut: true,
              outputFiles: [],
              durationMs: 60000,
            }),
            summary: "Executed Python script in sandbox",
          };
        },
      };

      const dispatcher = new ToolDispatcher([pythonTool]);
      const outputs = await dispatcher.dispatchConcurrent(
        [{ id: "call-1", name: "execute_python", arguments: {} }],
        { runId: "run-test", workspaceRoot: tempDir, gateway: {} as any },
      );

      expect(outputs).toHaveLength(1);
      const res = outputs[0]!.result;
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("timeout");
        expect(res.error.retryable).toBe(true);
        expect(res.error.message).toContain("timed out");
      }
    });

    it("normalizes run_command exit code failures into typed ok: false", async () => {
      const cmdTool: AgentTool = {
        name: "run_command",
        definition: {
          type: "function",
          function: { name: "run_command", description: "cmd", parameters: { type: "object", properties: {} } },
        },
        async execute() {
          return {
            output: JSON.stringify({
              stdout: "",
              stderr: "npm ERR! Test failed.",
              exitCode: 1,
              timedOut: false,
              durationMs: 450,
            }),
            summary: 'Command exit 1 in 450ms: "npm test"',
          };
        },
      };

      const dispatcher = new ToolDispatcher([cmdTool]);
      const outputs = await dispatcher.dispatchConcurrent(
        [{ id: "call-1", name: "run_command", arguments: { command: "npm test" } }],
        { runId: "run-test", workspaceRoot: tempDir, gateway: {} as any },
      );

      expect(outputs).toHaveLength(1);
      const res = outputs[0]!.result;
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("sandbox_failure");
        expect(res.error.retryable).toBe(true);
        expect(res.error.message).toContain("npm ERR!");
      }
    });
  });

  describe("AgentLoop Decision Making on Structured Status", () => {
    it("does not treat reading a file starting with 'Error' as an agent loop failure", async () => {
      const errorLogPath = path.join(tempDir, "service-error.log");
      writeFileSync(errorLogPath, "Error: service stopped due to network timeout", "utf8");

      const loop = new AgentLoop();
      let turnCall = 0;

      const mockGateway = {
        async chatWithTools() {
          turnCall++;
          if (turnCall === 1) {
            return {
              ok: true,
              value: {
                content: "Reading error log to inspect failure reason.",
                tool_calls: [{ id: "call-1", name: "read_file", arguments: { path: "service-error.log" } }],
              },
            };
          }
          return {
            ok: true,
            value: {
              content: "The service stopped because of a network timeout. Analysis complete.",
              tool_calls: null,
            },
          };
        },
      };

      const result = await loop.run({
        runId: "run-read-error-file",
        driverModelId: "draft-qwen3",
        userPrompt: "Why did the service fail? Read service-error.log",
        systemPrompt: "You are an assistant.",
        tools: [readFileTool],
        context: {
          runId: "run-read-error-file",
          workspaceRoot: tempDir,
          gateway: mockGateway as any,
        },
        emitEvent: () => {},
      });

      // Crucial test: because the tool executed cleanly (reading the file containing 'Error'),
      // the agent loop should complete successfully with outcome === 'completed'!
      expect(result.completed).toBe(true);
      expect(result.outcome).toBe("completed");
      expect(result.finalText).toContain("network timeout");
    });

    it("makes loop recovery decisions from typed ok: false when tool fails", async () => {
      const loop = new AgentLoop();
      let turnCall = 0;
      const emittedEvents: RunEvent[] = [];

      const failingTool: AgentTool = {
        name: "read_file",
        definition: {
          type: "function",
          function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
        },
        async execute() {
          throw new Error("ENOENT: no such file or directory, open 'nonexistent.txt'");
        },
      };

      const mockGateway = {
        async chatWithTools() {
          turnCall++;
          if (turnCall === 1) {
            return {
              ok: true,
              value: {
                content: "Let me check nonexistent.txt",
                tool_calls: [{ id: "call-1", name: "read_file", arguments: { path: "nonexistent.txt" } }],
              },
            };
          }
          return {
            ok: true,
            value: {
              content: "The file was not found on disk. I was unable to inspect it.",
              tool_calls: null,
            },
          };
        },
      };

      const result = await loop.run({
        runId: "run-missing-file",
        driverModelId: "draft-qwen3",
        userPrompt: "Read nonexistent.txt",
        systemPrompt: "You are an assistant.",
        tools: [failingTool],
        context: {
          runId: "run-missing-file",
          workspaceRoot: tempDir,
          gateway: mockGateway as any,
          emitRunEvent: (e: any) => emittedEvents.push(e),
        },
        emitEvent: (e) => emittedEvents.push(e),
      });

      const toolResultEvent = emittedEvents.find((e) => e.type === "tool_result") as any;
      expect(toolResultEvent).toBeDefined();
      expect(toolResultEvent.ok).toBe(false);
      expect(toolResultEvent.error.code).toBe("file_not_found");

      // The loop caught the error structured status, provided it to the model,
      // and the model gracefully explained the missing file
      expect(result.completed).toBe(true);
      expect(result.finalText).toContain("not found");
    });
  });
});
