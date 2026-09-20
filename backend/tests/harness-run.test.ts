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
import { closeDb, initDb, getDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { addMessage } from "../src/main/persistence/messages.js";
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

  it("creates a standalone artifact without touching the active workspace when user specifies negative workspace constraint", async () => {
    const mockGateway = createMockGateway(() => ({
      filename: "task.py",
      content: "print('isolated')",
    }));

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);

    harness.registerWorkspace(workspaceRoot);
    expect(harness.isWorkspaceActive()).toBe(true);

    const { runId } = await manager.start({
      userText: "generate a python file saying 'print(123)' but not save it in the workspace directory",
    });

    await waitForCompletion(runEvents);

    // 1. Verify workspace directory was NOT touched
    const { readdirSync } = await import("node:fs");
    const wsFiles = readdirSync(workspaceRoot);
    expect(wsFiles.filter((f) => !f.startsWith("."))).toHaveLength(0);

    // 2. Verify artifact_ready event WAS emitted
    const artifactEvent = runEvents.find((e) => e.type === "artifact_ready");
    expect(artifactEvent).toBeDefined();
    if (artifactEvent && artifactEvent.type === "artifact_ready") {
      expect(artifactEvent.artifact.filename).toBe("task.py");

      const artifactRow = manager.artifact(runId, artifactEvent.artifact.artifactId);
      expect(artifactRow).toBeDefined();
      expect(artifactRow.filename).toBe("task.py");

      const { absoluteDataPath } = await import("../src/main/run/filesystem.js");
      const absPath = absoluteDataPath(artifactRow.relativePath);
      expect(existsSync(absPath)).toBe(true);
      expect(readFileSync(absPath, "utf8")).toBe("print('isolated')");
    }

    // 3. Verify assistant message confirms isolation
    const assistantMsg = runEvents.find((e) => e.type === "assistant_message");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg && assistantMsg.type === "assistant_message") {
      expect(assistantMsg.text).toContain("isolated from workspace");
    }
  });

  it("handles model returning action as tool name (e.g. action: list_dir) without dumping raw JSON", async () => {
    const mockGateway = createMockGateway((_req, count) => {
      if (count === 1) {
        return {
          thought: "checking directory",
          action: "list_dir",
          args: { path: "." },
        };
      }
      return {
        thought: "finished",
        action: "final_answer",
        text: "Exploration completed successfully.",
      };
    });

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);

    harness.registerWorkspace(workspaceRoot);
    expect(harness.isWorkspaceActive()).toBe(true);

    await manager.start({
      userText: "list files in this directory",
    });

    await waitForCompletion(runEvents);

    // Verify tool was called
    const toolCall = runEvents.find((e) => e.type === "tool_call" && (e as any).tool === "list_dir");
    expect(toolCall).toBeDefined();

    // Verify assistant message contains final answer and NOT raw JSON
    const assistantMsg = runEvents.find((e) => e.type === "assistant_message");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg && assistantMsg.type === "assistant_message") {
      expect(assistantMsg.text).toBe("Exploration completed successfully.");
      expect(assistantMsg.text).not.toContain('"action": "list_dir"');
    }
  });

  it("routes approval note drafting with Word document request to draft model and creates document artifact", async () => {
    const mockGateway = createMockGateway(() => ({
      text: "# Approval Note: Proposed Reactor Maintenance Shutdown\n\n**Status:** Conditional Approval\n\nAll safety limits verified.",
    }));

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);

    harness.registerWorkspace(workspaceRoot);
    expect(harness.isWorkspaceActive()).toBe(true);

    const { runId } = await manager.start({
      userText: "Draft an approval note for a proposed maintenance nuclear reactor shutdown and save it as a Word document.",
    });

    await waitForCompletion(runEvents);

    // 1. Verify workspace was NOT touched
    const { readdirSync } = await import("node:fs");
    const wsFiles = readdirSync(workspaceRoot);
    expect(wsFiles.filter((f) => !f.startsWith("."))).toHaveLength(0);

    // 2. Verify routing was draft-qwen3
    const routingEvent = runEvents.find((e) => e.type === "routing");
    expect(routingEvent).toBeDefined();
    if (routingEvent && routingEvent.type === "routing") {
      expect(routingEvent.modelId).toBe("draft-qwen3");
      expect(routingEvent.taskType).toBe("draft");
    }

    // 3. Verify assistant message has formatted approval note text
    const assistantMsg = runEvents.find((e) => e.type === "assistant_message");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg && assistantMsg.type === "assistant_message") {
      expect(assistantMsg.text).toContain("Approval Note: Proposed Reactor Maintenance Shutdown");
      expect(assistantMsg.modelId).toBe("draft-qwen3");
    }

    // 4. Verify artifact was created in run output
    const artifactEvent = runEvents.find((e) => e.type === "artifact_ready");
    expect(artifactEvent).toBeDefined();
    if (artifactEvent && artifactEvent.type === "artifact_ready") {
      expect(artifactEvent.artifact.kind).toBe("docx");
      expect(artifactEvent.artifact.filename).toBe("approval-note.docx");
    }
  });

  it("handles multi-turn conversation: drafting approval note then saving it to active workspace on follow-up turn", async () => {
    const mockGateway = createMockGateway(() => ({
      text: "# Approval Note: Reactor Maintenance Shutdown\nApproved.",
    }));

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);

    harness.registerWorkspace(workspaceRoot);
    const chatId = createChat("Nuclear Reactor Review");

    // Turn 1: User asks to draft an approval note and save as Word document
    const turn1Text = "Draft an approval note for a proposed maintenance nuclear reactor shutdown and save it as a Word document.";
    addMessage({ chat_id: chatId, role: "user", content: turn1Text });
    await manager.start({ userText: turn1Text, chatId });
    await waitForCompletion(runEvents);

    // Verify Turn 1 generated approval-note.docx artifact in run output
    const turn1Artifact = runEvents.find((e) => e.type === "artifact_ready");
    expect(turn1Artifact).toBeDefined();

    // Turn 2: User says "Save it in the workspace"
    runEvents = [];
    const turn2Text = "Save it in the workspace";
    addMessage({ chat_id: chatId, role: "user", content: turn2Text });
    await manager.start({ userText: turn2Text, chatId });
    await waitForCompletion(runEvents);

    // Verify Turn 2 saved approval-note.docx directly into workspace root
    const wsTarget = path.join(workspaceRoot, "approval-note.docx");
    expect(existsSync(wsTarget)).toBe(true);

    // Verify assistant confirmed saving to workspace
    const turn2Assistant = runEvents.find((e) => e.type === "assistant_message");
    expect(turn2Assistant).toBeDefined();
    if (turn2Assistant && turn2Assistant.type === "assistant_message") {
      expect(turn2Assistant.text).toContain("Saved **approval-note.docx** directly to your active workspace");
    }

    // Verify run completed
    const stateEvent = runEvents.find((e) => e.type === "run_state" && (e as any).state === "completed");
    expect(stateEvent).toBeDefined();
  });

  it("preserves multi-turn conversation history across consecutive runs", async () => {
    const interceptedRequests: ModelRequest[] = [];
    const mockGateway = createMockGateway((req) => {
      interceptedRequests.push(req);
      return { text: "Step 2 involves cooling loop inspection." };
    });

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    const chatId = createChat("Multi Turn Chat");

    // Turn 1
    const prompt1 = "What is SOP-114?";
    addMessage({ chat_id: chatId, role: "user", content: prompt1 });
    await manager.start({ userText: prompt1, chatId });
    await waitForCompletion(runEvents);

    // Turn 2
    runEvents = [];
    const prompt2 = "Summarize step 2 of it";
    addMessage({ chat_id: chatId, role: "user", content: prompt2 });
    await manager.start({ userText: prompt2, chatId });
    await waitForCompletion(runEvents);

    // Check that Turn 2 request contained history from Turn 1
    const turn2Req = interceptedRequests[interceptedRequests.length - 1];
    expect(turn2Req).toBeDefined();
    expect(turn2Req.history).toBeDefined();
    expect(turn2Req.history?.length).toBeGreaterThanOrEqual(1);
    expect(turn2Req.history?.some((m) => m.content.includes("SOP-114"))).toBe(true);
  });

  it("handles start with client-provided runId and executes cleanly", async () => {
    const mockGateway = createMockGateway(() => ({
      text: "Hello from test!",
    }));

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    const customRunId = "11111111-2222-3333-4444-555555555555";
    const res = await manager.start({
      userText: "Say hi",
      runId: customRunId,
    });

    expect(res.runId).toBe(customRunId);
    await waitForCompletion(runEvents);

    const completeEvent = runEvents.find((e) => e.type === "run_state" && (e as any).state === "completed");
    expect(completeEvent).toBeDefined();
    expect((completeEvent as any).runId).toBe(customRunId);
  });

  it("executes 'Give me the solution for LC: Two Sum Problem in C++' cleanly", async () => {
    const mockGateway = createMockGateway(() => ({
      text: "```cpp\n#include <vector>\n#include <unordered_map>\nusing namespace std;\n\nvector<int> twoSum(vector<int>& nums, int target) {\n    unordered_map<int, int> seen;\n    for (int i = 0; i < nums.size(); ++i) {\n        int complement = target - nums[i];\n        if (seen.count(complement)) return {seen[complement], i};\n        seen[nums[i]] = i;\n    }\n    return {};\n}\n```",
    }));

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    const prompt = "Give me the solution for LC: Two Sum Problem in C++";
    await manager.start({
      userText: prompt,
    });

    await waitForCompletion(runEvents);

    const assistantMsg = runEvents.find((e) => e.type === "assistant_message");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg && assistantMsg.type === "assistant_message") {
      expect(assistantMsg.text).toContain("vector<int> twoSum");
    }

    const completeEvent = runEvents.find((e) => e.type === "run_state" && (e as any).state === "completed");
    expect(completeEvent).toBeDefined();
  });

  it("does not duplicate prior conversation context in userPrompt during workspace harness run", async () => {
    const interceptedRequests: ModelRequest[] = [];
    const mockGateway = createMockGateway((req) => {
      interceptedRequests.push(req);
      return {
        thought: "Check workspace files",
        action: "final_answer",
        text: "Workspace inspected.",
      };
    });

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);
    harness.registerWorkspace(workspaceRoot);

    const chatId = createChat("Workspace Context Test");

    addMessage({ chat_id: chatId, role: "user", content: "Hey!" });
    addMessage({ chat_id: chatId, role: "assistant", content: "Hello! How can I assist you today?" });
    addMessage({ chat_id: chatId, role: "user", content: "Please fix the broken script" });
    addMessage({
      chat_id: chatId,
      role: "assistant",
      content: "The script executed successfully without any errors.",
    });

    const userPrompt = "Save the new corrected file in the workspace";
    addMessage({ chat_id: chatId, role: "user", content: userPrompt });

    await manager.start({
      userText: userPrompt,
      chatId,
    });
    await waitForCompletion(runEvents);

    expect(interceptedRequests.length).toBeGreaterThanOrEqual(1);
    const harnessReq = interceptedRequests[0];

    // Prior history should be passed as structured history messages
    expect(harnessReq.history).toBeDefined();
    expect(harnessReq.history?.length).toBe(4);
    expect(harnessReq.history?.[0].content).toBe("Hey!");
    expect(harnessReq.history?.[1].content).toBe("Hello! How can I assist you today?");

    // userPrompt must NOT contain the duplicated stringified prior context
    expect(harnessReq.userPrompt).not.toContain("=== Prior Conversation Context ===");
    expect(harnessReq.userPrompt).not.toContain("=== End Prior Context ===");
    expect(harnessReq.userPrompt).toContain("User Task: Save the new corrected file in the workspace");
  });

  it("handles compound command: 'Delete the file in the test workspace and save this file in the workspace'", async () => {
    const mockGateway = createMockGateway(() => ({
      text: "# Mock deliverable\nprint('fixed')",
    }));

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);
    harness.registerWorkspace(workspaceRoot);

    // Create an existing file in workspace that should be deleted
    const oldFilePath = path.join(workspaceRoot, "existing-broken-script.py");
    writeFileSync(oldFilePath, "broken_code = True\n", "utf8");
    expect(existsSync(oldFilePath)).toBe(true);

    const chatId = createChat("Script Repair Chat");

    // Turn 1: generate a repaired deliverable script artifact in chat
    const turn1Text = "Please fix the broken script and output python code";
    addMessage({ chat_id: chatId, role: "user", content: turn1Text });
    await manager.start({ userText: turn1Text, chatId });
    await waitForCompletion(runEvents);

    // Save a mock artifact in the chat persistence
    const dataDir = process.env.WORKBENCH_DATA_ROOT ?? path.join(tempRoot, "data");
    const run1Id = runEvents.find((e) => e.type === "run_state" && (e as any).state === "completed")?.runId!;
    const outDir = path.join(dataDir, "runs", run1Id, "output");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "repaired-script.py"), "print('all fixed')\n", "utf8");

    getDb()
      .prepare(
        "INSERT INTO artifacts(artifact_id, run_id, kind, filename, relative_path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "art-1234",
        run1Id,
        "txt",
        "repaired-script.py",
        `runs/${run1Id}/output/repaired-script.py`,
        20,
        new Date().toISOString(),
      );

    // Turn 2: User says "Delete the file in the test workspace and save this file in the workspace"
    runEvents = [];
    const turn2Text = "Delete the file in the test workspace and save this file in the workspace";
    addMessage({ chat_id: chatId, role: "user", content: turn2Text });
    await manager.start({ userText: turn2Text, chatId });
    await waitForCompletion(runEvents);

    // 1. Existing file in workspace should have been deleted
    expect(existsSync(oldFilePath)).toBe(false);

    // 2. New repaired script should be saved in workspace
    const newFilePath = path.join(workspaceRoot, "repaired-script.py");
    expect(existsSync(newFilePath)).toBe(true);
    expect(readFileSync(newFilePath, "utf8")).toBe("print('all fixed')\n");

    // 3. Assistant message should report both deletion and save
    const assistantMsg = runEvents.find((e) => e.type === "assistant_message");
    expect(assistantMsg).toBeDefined();
    if (assistantMsg && assistantMsg.type === "assistant_message") {
      expect(assistantMsg.text).toContain("Deleted **existing-broken-script.py**");
      expect(assistantMsg.text).toContain("saved **repaired-script.py**");
    }

    // 4. Only ONE artifact_ready event emitted in turn 2
    const artifactEvents = runEvents.filter((e) => e.type === "artifact_ready");
    expect(artifactEvents.length).toBe(1);
    expect(artifactEvents[0].artifact.filename).toBe("repaired-script.py");
  });

  it("deletes file when model calls delete_file tool in workspace", async () => {
    const targetFile = path.join(workspaceRoot, "obsolete-script.py");
    writeFileSync(targetFile, "print('remove me')\n", "utf8");
    expect(existsSync(targetFile)).toBe(true);

    const mockGateway = createMockGateway((_req, count) => {
      if (count === 1) {
        return {
          thought: "Deleting the obsolete script",
          action: "tool_call",
          tool: "delete_file",
          args: { path: "obsolete-script.py" },
        };
      }
      return {
        thought: "Done",
        action: "final_answer",
        text: "The file 'obsolete-script.py' has been deleted from the workspace.",
      };
    });

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);
    harness.registerWorkspace(workspaceRoot);

    await manager.start({ userText: "Delete the obsolete-script.py file in the workspace" });
    await waitForCompletion(runEvents);

    expect(existsSync(targetFile)).toBe(false);
    const artifactReadyEvents = runEvents.filter((e) => e.type === "artifact_ready");
    expect(artifactReadyEvents).toHaveLength(0);
  });

  it("safeguards against model attempting write_file with empty content to delete file", async () => {
    const targetFile = path.join(workspaceRoot, "repaired-broken-vendor-log-parser.py");
    writeFileSync(targetFile, "print('should be deleted')\n", "utf8");
    expect(existsSync(targetFile)).toBe(true);

    // Simulate the exact scenario from user's screenshot: model calls write_file with empty content
    const mockGateway = createMockGateway((_req, count) => {
      if (count === 1) {
        return {
          thought: "To remove the file, I need to call the write_file tool with an empty content string and the path of the file.",
          action: "tool_call",
          tool: "write_file",
          args: { path: "repaired-broken-vendor-log-parser.py", content: "" },
        };
      }
      return {
        thought: "The file has been successfully removed.",
        action: "final_answer",
        text: "The file 'repaired-broken-vendor-log-parser.py' has been removed from the workspace.",
      };
    });

    manager = new RunManager(mockGateway as any, (event) => runEvents.push(event));
    harness = new HarnessManager(undefined, (event) => runEvents.push(event));
    manager.setHarness(harness);
    harness.registerWorkspace(workspaceRoot);

    await manager.start({ userText: "Remove the file in the workspace (there is only one right now)" });
    await waitForCompletion(runEvents);

    // The file should be truly deleted, not left as 0 bytes!
    expect(existsSync(targetFile)).toBe(false);

    // No 0-byte artifact ready card should be emitted to the user!
    const artifactReadyEvents = runEvents.filter((e) => e.type === "artifact_ready");
    expect(artifactReadyEvents).toHaveLength(0);
  });

  it("manager.health returns distinct models keyed by port without repeating for multiple roles", async () => {
    const mockGateway = {
      isDevRoutingActive: () => false,
      healthDistinct: vi.fn().mockResolvedValue([
        { modelId: "qwen2.5-coder-7b-instruct-mlx", port: 1234, available: true, latencyMs: 12, checkedAt: new Date().toISOString() },
      ]),
      health: vi.fn().mockResolvedValue([]),
    };

    manager = new RunManager(mockGateway as any);
    const health = await manager.health();

    expect(health).toHaveLength(1);
    expect(health[0].modelId).toBe("qwen2.5-coder-7b-instruct-mlx");
    expect(health[0].port).toBe(1234);
    expect(health[0].available).toBe(true);
  });
});



