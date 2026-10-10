import { describe, expect, it, vi, afterEach } from "vitest";
import {
  getUsableConfiguredModels,
  countUsableModels,
  resolveModelSelection,
} from "../src/main/gateway/model-selection.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { resolveModel } from "../src/main/gateway/registry.js";
import { HarnessManager } from "../src/main/harness/harness-manager.js";
import { RunManager } from "../src/main/run/manager.js";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import { getRunContract } from "../src/main/run/contract.js";
import type { ModelConfigRow, ModelRegistryEntry, RunEvent } from "../src/shared/contracts.js";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";

describe("Phase 1: Model Selection & Classification Removal", () => {
  let tempDir = "";

  afterEach(() => {
    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    delete process.env.WORKBENCH_AGENT_V2;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("does not use task categories to gate access to the configured model endpoint", () => {
    const model: ModelRegistryEntry = {
      id: "primary-model",
      taskTypes: ["code"],
      runtime: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "general-model",
      capabilities: ["text"],
      requestTimeoutMs: 1000,
      healthPath: "/models",
      enabled: true,
    };
    expect(resolveModel(new Map([[model.id, model]]), model.id, "vision")).toBe(model);
  });

  describe("resolveModelSelection contract logic", () => {
    const singleModels: ModelConfigRow[] = [
      {
        role: "primary",
        modelName: "qwen2.5:7b",
        host: "127.0.0.1",
        port: 11434,
        contextLength: 8192,
      },
    ];

    const multiModels: ModelConfigRow[] = [
      {
        role: "primary",
        modelName: "qwen2.5:7b",
        host: "127.0.0.1",
        port: 11434,
        contextLength: 8192,
      },
      {
        role: "primary",
        modelName: "qwen2.5-coder:7b",
        host: "127.0.0.1",
        port: 11435,
        contextLength: 8192,
      },
      {
        role: "primary",
        modelName: "qwen2.5-vl:7b",
        host: "127.0.0.1",
        port: 11436,
        contextLength: 8192,
      },
    ];

    it("Scenario: One model configured -> automatically uses it, marks isSingleModel=true", () => {
      const usable = getUsableConfiguredModels(undefined, singleModels);
      expect(usable.length).toBe(1);
      expect(countUsableModels(undefined, singleModels)).toBe(1);

      const resolved = resolveModelSelection({ configuredModels: singleModels });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.modelId).toBe("primary-model");
        expect(resolved.isSingleModel).toBe(true);
        expect(resolved.reason).toBe("single configured model");
      }
    });

    it("Scenario: Multiple models configured, no explicit selection -> uses configured primary model (primary-model)", () => {
      const usable = getUsableConfiguredModels(undefined, multiModels);
      expect(usable.length).toBe(3);
      expect(countUsableModels(undefined, multiModels)).toBe(3);

      const resolved = resolveModelSelection({ configuredModels: multiModels });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.modelId).toBe("primary-model");
        expect(resolved.isSingleModel).toBe(false);
        expect(resolved.reason).toBe("configured primary model");
      }
    });

    it("Scenario: Multiple models configured, explicit selection -> uses selected model", () => {
      const resolved = resolveModelSelection({ configuredModels: multiModels, explicitSelection: "model-2" });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.modelId).toBe("model-2");
        expect(resolved.isSingleModel).toBe(false);
        expect(resolved.reason).toBe("explicit user selection");
      }
    });

    it("Scenario: Code-related or Vision-related request does NOT override explicit user selection", () => {
      // Regardless of modality, explicit selection of primary-model is authoritative
      const resolvedDraft = resolveModelSelection({ configuredModels: multiModels, explicitSelection: "primary-model" });
      expect(resolvedDraft.ok).toBe(true);
      if (resolvedDraft.ok) {
        expect(resolvedDraft.modelId).toBe("primary-model");
      }

      // Explicit selection of model-2 remains model-2 even for text or vision prompt
      const resolvedCode = resolveModelSelection({ configuredModels: multiModels, explicitSelection: "model-2" });
      expect(resolvedCode.ok).toBe(true);
      if (resolvedCode.ok) {
        expect(resolvedCode.modelId).toBe("model-2");
      }
    });

    it("Scenario: Explicitly selected model becomes unavailable -> clear error, NO silent substitution", () => {
      const resolved = resolveModelSelection({ configuredModels: multiModels, explicitSelection: "non-existent-model" });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.code).toBe("model_unavailable");
        expect(resolved.error).toContain("non-existent-model");
        expect(resolved.error).toContain("unavailable or not configured");
      }
      const single=resolveModelSelection({configuredModels:singleModels,explicitSelection:'missing-primary-model'});
      expect(single.ok).toBe(false);
      if(!single.ok)expect(single.error).toContain('missing-primary-model');
    });

    it("Scenario: Zero usable models configured -> returns model_unavailable error", () => {
      const emptyModels: ModelConfigRow[] = [];
      const resolved = resolveModelSelection({ configuredModels: emptyModels });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.code).toBe("model_unavailable");
        expect(resolved.error).toContain("No usable LLM models are configured");
      }
    });

    it("Scenario: Model configuration changes dynamically -> resolves updated models", () => {
      const dynamicModels: ModelConfigRow[] = [...singleModels];
      expect(countUsableModels(undefined, dynamicModels)).toBe(1);

      // Add a second model dynamically
      dynamicModels.push({
        role: "primary",
        modelName: "qwen2.5-coder:7b",
        host: "127.0.0.1",
        port: 11435,
        contextLength: 8192,
      });

      expect(countUsableModels(undefined, dynamicModels)).toBe(2);
      const resolved = resolveModelSelection({ configuredModels: dynamicModels, explicitSelection: "model-2" });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.modelId).toBe("model-2");
      }
    });
  });

  describe("RunManager Execution Lifecycles (V2)", () => {
    it("Scenario: Simple Chat request -> direct response without classification", async () => {
      tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-p1-chat-"));
      process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
      process.env.WORKBENCH_AGENT_V2 = "true";
      initDb(path.join(tempDir, "workbench.sqlite"));

      let classifications = 0;
      const events: RunEvent[] = [];

      const mockGateway = {
        async execute() {
          classifications++;
          return {
            ok: true,
            value: {
              result: {
                intentType: "general_qa",
                driverModel: "primary-model",
                taskType: "draft",
                primaryGoal: "General question",
                isActionable: false,
                chatResponseOnly: true,
                workspaceMutationRequested: false,
                targetFiles: [],
                expectedDeliverables: [],
              },
            },
          };
        },
        async chatWithTools() {
          return {
            ok: true,
            value: {
              content: "The boiling point of water is 100 degrees Celsius at 1 atm.",
              tool_calls: null,
            },
          };
        },
        health() {
          return Promise.resolve([]);
        },
      } as unknown as ModelGateway;

      const manager = new RunManager(mockGateway, (e) => events.push(e));
      const started = await manager.start({ userText: "What is the boiling point of water?" });

      await vi.waitFor(
        () => expect(events.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true),
        { timeout: 2000 },
      );

      // Chat uses the selected model directly.
      expect(classifications).toBe(0);

      // Verify routing event is configuration-driven
      const routingEvent = events.find((e) => e.type === "routing");
      expect(routingEvent).toBeDefined();
      expect(routingEvent?.modelId).toBe("primary-model");

      // Verify persisted contract
      const contract = getRunContract(started.runId);
      expect(contract).toBeDefined();
      expect(contract?.deliverables).toEqual([]);
      expect(contract?.workspace.operations).toEqual([]);
    });

    it("Scenario: Multi-model setup with explicit selection -> interprets and executes with selected model", async () => {
      tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-p1-explicit-"));
      process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
      process.env.WORKBENCH_AGENT_V2 = "true";
      initDb(path.join(tempDir, "workbench.sqlite"));

      let classifications = 0;
      let modelUsedInChat = "";
      const events: RunEvent[] = [];

      const mockGateway = {
        registry: new Map([["primary-model", { id: "primary-model", model: "first", enabled: true, capabilities:["text"] }], ["model-2", { id: "model-2", model: "second", enabled: true, capabilities:["text"] }]]),
        async execute() {
          classifications++;
          return { ok: true, value: { result: { intentType: "general_qa", taskType: "code", primaryGoal: "Explain quicksort", isActionable: false, chatResponseOnly: true, workspaceMutationRequested: false, expectedDeliverables: [] } } };
        },
        async chatWithTools(model: string) {
          modelUsedInChat = model;
          return {
            ok: true,
            value: {
              content: "Here is the code or text requested.",
              tool_calls: null,
            },
          };
        },
        health() {
          return Promise.resolve([]);
        },
      } as unknown as ModelGateway;

      const manager = new RunManager(mockGateway, (e) => events.push(e));
      // Explicitly select model-2
      const started = await manager.start({
        userText: "Explain how to write a quicksort algorithm in TypeScript",
        selectedModel: "model-2",
      });

      await vi.waitFor(
        () => expect(events.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true),
        { timeout: 2000 },
      );

      // Model selection must be authoritative throughout execution
      expect(classifications).toBe(0);
      expect(modelUsedInChat).toBe("model-2");

      const routingEvent = events.find((e) => e.type === "routing");
      expect(routingEvent?.modelId).toBe("model-2");
      expect(routingEvent?.taskType).toBe("draft");

      const contract = getRunContract(started.runId);
      expect(contract?.routing.driverModel).toBe("model-2");
    });

    it("Scenario: Explicitly selected model becomes unavailable -> fails with error event and terminal failed state", async () => {
      tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-p1-unavail-"));
      process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
      process.env.WORKBENCH_AGENT_V2 = "true";
      initDb(path.join(tempDir, "workbench.sqlite"));

      const events: RunEvent[] = [];
      const mockGateway = {
        async execute() { return { ok: true, value: {} }; },
        async chatWithTools() { return { ok: true, value: { content: "ok", tool_calls: null } }; },
        health() { return Promise.resolve([]); },
      } as unknown as ModelGateway;

      const manager = new RunManager(mockGateway, (e) => events.push(e));
      const started = await manager.start({
        userText: "Do something with invalid model",
        selectedModel: "missing-specialist-model",
      });

      await vi.waitFor(
        () => expect(events.some((e) => e.type === "run_state" && e.state === "failed")).toBe(true),
        { timeout: 2000 },
      );

      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.message).toContain("missing-specialist-model");
      expect(errorEvent?.message).toContain("unavailable or not configured");
    });

    it("Scenario: Agent mutation request -> narrow semantic safety exception preserves protectedPaths and approvals", async () => {
      tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-p1-mutate-"));
      process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
      process.env.WORKBENCH_AGENT_V2 = "true";
      initDb(path.join(tempDir, "workbench.sqlite"));

      let classifications = 0;
      const events: RunEvent[] = [];

      const mockGateway = {
        registry: new Map([["model-2", { id:"model-2",model:"selected",enabled:true,capabilities:["text"] }]]),
        async execute() {
          classifications++;
          return {
            ok: true,
            value: {
              result: {
                intentType: "code_modification",
                driverModel: "primary-model",
                taskType: "draft",
                primaryGoal: "Modify worker.ts safely",
                isActionable: true,
                chatResponseOnly: false,
                workspaceMutationRequested: true,
                targetFiles: ["worker.ts"],
                protectedPaths: [".env", "workbench.db"],
                expectedDeliverables: [],
              },
            },
          };
        },
        async chatWithTools() {
          return {
            ok: true,
            value: {
              content: "I will modify worker.ts",
              tool_calls: [
                {
                  id: "c1",
                  name: "write_file", arguments: { path: "worker.ts", content: "export const x = 1;" },
                },
              ],
            },
          };
        },
        health() { return Promise.resolve([]); },
      } as unknown as ModelGateway;

      let manager: RunManager;
      manager = new RunManager(mockGateway, (e) => {
        events.push(e);
        if (e.type === "confirmation_required") {
          // This test checks the pending approval before any write.
        }
      });

      const harness=new HarnessManager();
      mkdirSync(path.join(tempDir,"workspace"));harness.registerWorkspace(path.join(tempDir,"workspace"));manager.setHarness(harness);
      const started = await manager.start({
        mode:"agent",
        userText: "Modify worker.ts to export x",
        selectedModel: "model-2",
      });

      await vi.waitFor(
        () => expect(events.some((e) => e.type === "run_state" && e.state === "awaiting_confirmation")).toBe(true),
        { timeout: 2000 },
      );

      // Verify the semantic interpretation exception ran to extract mutation safety bounds
      expect(classifications).toBe(1);

      // Verify the driver model remained strictly pinned to user's selectedModel
      const contract = getRunContract(started.runId);
      expect(contract?.routing.driverModel).toBe("model-2");
      expect(contract?.constraints.protectedPaths).toContain(".env");
      expect(contract?.workspace.operations.some((op) => op.targetPath === "worker.ts")).toBe(true);
      manager.cancel(started.runId);
    });
  });
});
