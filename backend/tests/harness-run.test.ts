import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { RunManager } from "../src/main/run/manager.js";
import { HarnessManager } from "../src/main/harness/harness-manager.js";
import { closeDb, initDb } from "../src/main/persistence/db.js";
import type { ModelRequest, ModelResponse, RunEvent } from "../src/shared/contracts.js";

describe("Workspace Task Execution Loop (HARNESS.md)", () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let manager: RunManager;
  let harness: HarnessManager;
  let runEvents: RunEvent[];
  let modelCallCount = 0;

  beforeEach(() => {
    tempRoot = path.join(
      os.tmpdir(),
      `wb-harness-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(tempRoot, { recursive: true });
    process.env.WORKBENCH_DATA_ROOT = path.join(tempRoot, "data");
    initDb(path.join(tempRoot, "workbench.sqlite"));

    const rawWs = path.join(tempRoot, "workspace");
    mkdirSync(rawWs, { recursive: true });
    workspaceRoot = realpathSync(rawWs);

    runEvents = [];
    modelCallCount = 0;
  });

  afterEach(() => {
    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function createMockGateway(handler: (req: ModelRequest, count: number) => unknown) {
    return {
      registry: new Map(),
      execute: vi.fn().mockImplementation(async (req: ModelRequest) => {
        modelCallCount++;
        const result = handler(req, modelCallCount);
        return {
          ok: true,
          value: {
            requestId: req.requestId,
            runId: req.runId,
            modelId: req.modelId,
            taskType: req.taskType,
            completedAt: new Date().toISOString(),
            result,
          } as ModelResponse,
        };
      }),
      complete: vi.fn().mockImplementation(async (req: ModelRequest) => {
        modelCallCount++;
        const result = handler(req, modelCallCount);
        return {
          ok: true,
          value: {
            requestId: req.requestId,
            runId: req.runId,
            modelId: req.modelId,
            taskType: req.taskType,
            completedAt: new Date().toISOString(),
            result,
          } as ModelResponse,
        };
      }),
      health: vi.fn().mockResolvedValue([]),
    };
  }

  function waitForCompletion(events: RunEvent[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const error = events.find((e) => e.type === "error");
        if (error) {
          reject(new Error(`Run failed with error: ${(error as any).message}`));
          return;
        }
        const completed = events.find(
          (e) => e.type === "run_state" && (e as any).state === "completed",
        );
        if (completed) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  it("writes a file into the workspace directory when user says 'Write a txt file in the directory saying hello'", async () => {
    // Mock LLM behavior:
    // Turn 1: Outputs tool_call to write_file for hello.txt
    // Turn 2: Outputs final_answer
    const mockGateway = createMockGateway((req, count) => {
      if (count === 1) {
        return {
          thought: "User wants a txt file saying hello. Calling write_file.",
          action: "tool_call",
          tool: "write_file",
          args: {
            path: "hello.txt",
            content: "hello",
          },
        };
      }
      return {
        thought: "hello.txt was written.",
        action: "final_answer",
        text: "I have created hello.txt in the workspace directory with content 'hello'.",
      };
    });

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);

    // 1. Activate workspace
    harness.registerWorkspace(workspaceRoot);

    // 2. Start run with prompt
    const { runId } = await manager.start({
      userText: "Write a txt file in the directory saying hello",
    });

    // 3. Wait for run completion
    await waitForCompletion(runEvents);

    // 4. VERIFY: The file was ACTUALLY written to the workspace directory on disk!
    const targetFile = path.join(workspaceRoot, "hello.txt");
    expect(existsSync(targetFile)).toBe(true);
    expect(readFileSync(targetFile, "utf8")).toBe("hello");

    // 5. VERIFY: RunEvent pipeline emitted the full set of events
    const routing = runEvents.find((e) => e.type === "routing");
    expect(routing).toBeDefined();
    if (routing && routing.type === "routing") {
      expect(routing.taskType).toBe("code");
      expect(routing.modelId).toBe("code-qwen25coder");
    }

    const toolCall = runEvents.find((e) => e.type === "tool_call");
    expect(toolCall).toBeDefined();

    const toolResult = runEvents.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();

    const artifact = runEvents.find((e) => e.type === "artifact_ready");
    expect(artifact).toBeDefined();
    if (artifact && artifact.type === "artifact_ready") {
      expect(artifact.artifact.filename).toBe("hello.txt");
    }

    const assistantMsg = runEvents.find((e) => e.type === "assistant_message");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg && assistantMsg.type === "assistant_message") {
      expect(assistantMsg.text).toContain("hello.txt");
    }
  });

  it("nudges model to call write_file if it lazily returns text without writing the file", async () => {
    // Mock LLM behavior:
    // Turn 1: Lazily returns { text: "hello" } without calling write_file
    // Turn 2: Sees system feedback nudge and calls write_file
    // Turn 3: Returns final_answer
    const mockGateway = createMockGateway((req, count) => {
      if (count === 1) {
        return {
          text: "hello",
        };
      }
      if (count === 2) {
        return {
          action: "tool_call",
          tool: "write_file",
          args: {
            path: "greeting.txt",
            content: "hello world\n",
          },
        };
      }
      return {
        action: "final_answer",
        text: "Created greeting.txt with 'hello world'.",
      };
    });

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);

    harness.registerWorkspace(workspaceRoot);

    await manager.start({
      userText: "Write a txt file in the directory saying hello",
    });

    await waitForCompletion(runEvents);

    // Verify greeting.txt was written despite initial lazy response
    const targetFile = path.join(workspaceRoot, "greeting.txt");
    expect(existsSync(targetFile)).toBe(true);
    expect(readFileSync(targetFile, "utf8")).toBe("hello world\n");
  });

  it("falls back to standard chat execution when no workspace is active", async () => {
    const mockGateway = createMockGateway(() => ({
      text: "Hello! How can I help you today?",
    }));

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);

    // Workspace NOT registered
    expect(harness.isWorkspaceActive()).toBe(false);

    await manager.start({
      userText: "Say hello",
    });

    await waitForCompletion(runEvents);

    const routing = runEvents.find((e) => e.type === "routing");
    expect(routing).toBeDefined();
    if (routing && routing.type === "routing") {
      expect(routing.taskType).toBe("draft");
      expect(routing.modelId).toBe("draft-qwen3");
    }

    const assistantMsg = runEvents.find((e) => e.type === "assistant_message");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg && assistantMsg.type === "assistant_message") {
      expect(assistantMsg.text).toBe("Hello! How can I help you today?");
    }
  });

  it("intercepts Python with open(...) code emitted by model and writes the file to disk", async () => {
    // Simulated model behavior: instead of structured tool_call, model returns Python code trying to write Krishay.txt
    const mockGateway = createMockGateway((req, count) => {
      if (count === 1) {
        return {
          text: "with open('Krishay.txt', 'w') as file:\n    file.write('Krishay')",
        };
      }
      return {
        action: "final_answer",
        text: "I have written Krishay to Krishay.txt",
      };
    });

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);

    harness.registerWorkspace(workspaceRoot);

    const { runId } = await manager.start({
      userText: "Write a txt file in the directory saying 'Krishay'",
    });

    await waitForCompletion(runEvents);

    // Verify Krishay.txt was physically created in the workspace!
    const targetFile = path.join(workspaceRoot, "Krishay.txt");
    expect(existsSync(targetFile)).toBe(true);
    expect(readFileSync(targetFile, "utf8")).toBe("Krishay");

    // Verify Artifact resolution: workbench:openArtifact can resolve the artifact from SQLite!
    const artifactEvent = runEvents.find((e) => e.type === "artifact_ready");
    expect(artifactEvent).toBeDefined();
    if (artifactEvent && artifactEvent.type === "artifact_ready") {
      const artifactId = artifactEvent.artifact.artifactId;
      const artifactRow = manager.artifact(runId, artifactId);
      expect(artifactRow).toBeDefined();
      expect(artifactRow.filename).toBe("Krishay.txt");

      // Verify that absoluteDataPath resolves to an existing file that shell.openPath can open
      const { absoluteDataPath } = await import("../src/main/run/filesystem.js");
      const absPath = absoluteDataPath(artifactRow.relativePath);
      expect(existsSync(absPath)).toBe(true);
      expect(readFileSync(absPath, "utf8")).toBe("Krishay");
    }
  });

  it("creates a downloadable artifact when file write is requested without an active workspace", async () => {
    const mockGateway = createMockGateway(() => ({
      filename: "Krishay.txt",
      content: "Krishay",
    }));

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);

    expect(harness.isWorkspaceActive()).toBe(false);

    await manager.start({
      userText: "Write a txt file in the directory saying 'Krishay'",
    });

    await waitForCompletion(runEvents);

    // Verify artifact_ready event was emitted
    const artifactEvent = runEvents.find((e) => e.type === "artifact_ready");
    expect(artifactEvent).toBeDefined();
    if (artifactEvent && artifactEvent.type === "artifact_ready") {
      expect(artifactEvent.artifact.filename).toBe("Krishay.txt");
    }

    const assistantMsg = runEvents.find((e) => e.type === "assistant_message");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg && assistantMsg.type === "assistant_message") {
      expect(assistantMsg.text).toContain("Krishay.txt");
    }
  });
});

