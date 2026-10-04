import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IPC_ONBOARDING,
  ONBOARDING_CHANNELS,
} from "../src/main/ipc/channels.js";
import { initBackend } from "../src/main/index.js";
import { closeDb, initDb } from "../src/main/persistence/db.js";
import { sanitizeHost, buildRegistryFromRows, configureModels } from "../src/main/gateway/registry.js";
import {
  handleGetOnboardingStatus,
  handleResetOnboarding,
  handleSaveModelConfig,
  handleTestModelEndpoint,
} from "../src/main/ipc/onboarding-handlers.js";

import { RunManager } from "../src/main/run/manager.js";
import { RAGService } from "../src/main/rag/rag-service.js";
import type { MinimalIpcMain } from "../src/main/ipc/handlers.js";
import type { ModelConfigRow } from "../src/shared/contracts.js";

class FakeIpcMain implements MinimalIpcMain {
  handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  async invoke(channel: string, input?: unknown): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn({}, input);
  }
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "workbench-onboarding-test-"));
  initDb(path.join(dir, "workbench.db"));
  copyFileSync(
    path.resolve(process.cwd(), "config", "models.json"),
    path.join(dir, "models.json"),
  );
});


afterEach(() => {
  configureModels({ modelsPath: null });
  closeDb();
  if (dir) rmSync(dir, { recursive: true, force: true });
});


describe("Onboarding Architecture & IPC Handlers", () => {
  it("registers all onboarding channels via initBackend", () => {
    const fake = new FakeIpcMain();
    initBackend(fake, undefined, {
      dataDir: dir,
      modelsPath: path.join(dir, "models.json"),
      schemaPath: path.resolve(process.cwd(), "backend", "src", "main", "persistence", "schema.sql"),
    });

    for (const channel of ONBOARDING_CHANNELS) {
      expect(fake.handlers.has(channel), `Channel ${channel} should be registered`).toBe(true);
    }
  });

  describe("sanitizeHost", () => {
    it("strips http:// and https:// prefixes", () => {
      expect(sanitizeHost("http://127.0.0.1")).toBe("127.0.0.1");
      expect(sanitizeHost("https://192.168.1.50")).toBe("192.168.1.50");
    });

    it("strips trailing slashes and paths", () => {
      expect(sanitizeHost("127.0.0.1/v1/")).toBe("127.0.0.1");
      expect(sanitizeHost("localhost/api/chat")).toBe("localhost");
    });

    it("extracts host part if host:port was entered into host field", () => {
      expect(sanitizeHost("127.0.0.1:11434")).toBe("127.0.0.1");
      expect(sanitizeHost("http://192.168.1.10:8000/")).toBe("192.168.1.10");
    });

    it("defaults to 127.0.0.1 if empty", () => {
      expect(sanitizeHost("")).toBe("127.0.0.1");
      expect(sanitizeHost("   ")).toBe("127.0.0.1");
    });
  });

  describe("buildRegistryFromRows", () => {
    const rows: ModelConfigRow[] = [
      {
        role: "vision",
        modelName: "qwen2.5-vl:7b",
        host: "192.168.1.42",
        port: 11434,
        contextLength: 32768,
      },
      {
        role: "coding",
        modelName: "qwen2.5-coder:32b",
        host: "192.168.1.42",
        port: 11434,
        contextLength: 32768,
      },
      {
        role: "draft",
        modelName: "qwen3:8b",
        host: "127.0.0.1",
        port: 8000,
        contextLength: 16384,
      },
      {
        role: "embedding",
        modelName: "nomic-embed-text:v1.5",
        host: "127.0.0.1",
        port: 11434,
        contextLength: 2048,
      },
    ];

    it("converts rows into valid ModelRegistryEntry array", () => {
      const entries = buildRegistryFromRows(rows);
      expect(entries.length).toBeGreaterThanOrEqual(3);

      const vision = entries.find((e) => e.id === "vision-qwen25vl");
      expect(vision).toBeDefined();
      expect(vision?.baseUrl).toBe("http://192.168.1.42:11434/v1");
      expect(vision?.model).toBe("qwen2.5-vl:7b");

      const coding = entries.find((e) => e.id === "code-qwen25coder");
      expect(coding).toBeDefined();
      expect(coding?.baseUrl).toBe("http://192.168.1.42:11434/v1");
      expect(coding?.model).toBe("qwen2.5-coder:32b");

      const draft = entries.find((e) => e.id === "draft-qwen3");
      expect(draft).toBeDefined();
      expect(draft?.baseUrl).toBe("http://127.0.0.1:8000/v1");
      expect(draft?.model).toBe("qwen3:8b");

      // Verify no legacy plan model is synthesized
      const plan = entries.find((e: any) => e.id === "plan-qwen3-8b");
      expect(plan).toBeUndefined();
    });
  });

  describe("Onboarding Persistence & Lifecycle", () => {
    it("starts with onboarding incomplete", () => {
      const status = handleGetOnboardingStatus();
      expect(status.completed).toBe(false);
      expect(status.configuredModels).toBeUndefined();
    });

    it("saves model config, updates gateway, and marks onboarding complete", () => {
      const manager = new RunManager();
      const ragService = new RAGService(dir);

      const rows: ModelConfigRow[] = [
        {
          role: "vision",
          modelName: "custom-vision-model",
          host: "10.0.0.5",
          port: 9000,
          contextLength: 8192,
        },
        {
          role: "coding",
          modelName: "custom-coder-model",
          host: "10.0.0.6",
          port: 9001,
          contextLength: 16384,
        },
        {
          role: "draft",
          modelName: "custom-draft-model",
          host: "10.0.0.7",
          port: 9002,
          contextLength: 32768,
        },
        {
          role: "embedding",
          modelName: "custom-embedding-model",
          host: "10.0.0.8",
          port: 9003,
          contextLength: 1024,
        },
      ];

      const saveRes = handleSaveModelConfig({ models: rows }, manager, ragService, dir);
      expect(saveRes.ok).toBe(true);

      // Verify status in persistence
      const status = handleGetOnboardingStatus();
      expect(status.completed).toBe(true);
      expect(status.configuredModels).toHaveLength(4);

      // Verify ModelGateway in memory has updated endpoints live
      const gateway = manager.getGateway();
      const visionEntry = gateway.registry.get("vision-qwen25vl");
      expect(visionEntry).toBeDefined();
      expect(visionEntry?.baseUrl).toBe("http://10.0.0.5:9000/v1");
      expect(visionEntry?.model).toBe("custom-vision-model");

      const codeEntry = gateway.registry.get("code-qwen25coder");
      expect(codeEntry).toBeDefined();
      expect(codeEntry?.baseUrl).toBe("http://10.0.0.6:9001/v1");
      expect(codeEntry?.model).toBe("custom-coder-model");

      // Verify RAGService received the new embedding config
      const embConfig = ragService.getEmbeddingConfig();
      expect(embConfig.baseUrl).toBe("http://10.0.0.8:9003/v1");
      expect(embConfig.model).toBe("custom-embedding-model");
    });

    it("resets onboarding while retaining cached models for dev testing", () => {
      const manager = new RunManager();
      const ragService = new RAGService(dir);

      const rows: ModelConfigRow[] = [
        {
          role: "draft",
          modelName: "dev-test-draft",
          host: "127.0.0.1",
          port: 11434,
          contextLength: 32768,
        },
      ];

      handleSaveModelConfig({ models: rows }, manager, ragService, dir);
      expect(handleGetOnboardingStatus().completed).toBe(true);

      // Now reset onboarding (e.g. dev clicked Reset Onboarding button)
      const resetRes = handleResetOnboarding();
      expect(resetRes.ok).toBe(true);

      // Status should be incomplete, but previously configured models are still cached!
      const statusAfterReset = handleGetOnboardingStatus();
      expect(statusAfterReset.completed).toBe(false);
      expect(statusAfterReset.configuredModels).toBeDefined();
      expect(statusAfterReset.configuredModels?.[0].modelName).toBe("dev-test-draft");
    });

    it("gracefully reports error when testing an unreachable endpoint", async () => {
      const result = await handleTestModelEndpoint({
        host: "127.0.0.1",
        port: 59999, // Unlikely to be listening
        modelName: "test-model",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("serves requests strictly from in-memory DB endpoints without external egress", async () => {
      const rows: ModelConfigRow[] = [
        {
          role: "draft",
          modelName: "local-qwen3",
          host: "127.0.0.1",
          port: 11434,
          contextLength: 4096,
        },
      ];

      let requestedUrl = "";
      let authHeader: string | undefined = undefined;

      const mockTransport = {
        async request(url: string, init: any) {
          requestedUrl = url;
          authHeader = init.headers?.authorization;
          return {
            status: 200,
            text: async () =>
              JSON.stringify({
                choices: [{ message: { content: "{\"text\": \"Response from local DB endpoint\"}" } }],
              }),
          };
        },
      };

      const manager = new RunManager();
      const ragService = new RAGService(dir);
      handleSaveModelConfig({ models: rows }, manager, ragService, dir);

      // Create a gateway with the mock transport and the in-memory dbRegistry
      const gateway = manager.getGateway();
      (gateway as any).transport = mockTransport;

      const res = await gateway.execute({
        requestId: "test-req-1",
        runId: "00000000-0000-4000-8000-000000000001",
        taskType: "draft",
        modelId: "draft-qwen3",
        responseFormat: "chat-result",
        systemPrompt: "You are a helpful assistant.",
        userPrompt: "Hello local model",
        timeoutMs: 5000,
      });

      expect(res.ok).toBe(true);
      expect(requestedUrl).toBe("http://127.0.0.1:11434/v1/chat/completions");
      expect(authHeader).toBeUndefined();
    });
  });
});

