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
import { sanitizeHost, buildRegistryFromRows, configureModels, loadRegistry } from "../src/main/gateway/registry.js";
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
import { getModelRoutes } from "../../frontend/src/lib/models.js";
import { isAllowedLocalModelEndpoint, isAllowedLocalModelHost } from "../src/shared/local-network.js";

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
    path.resolve(process.cwd(), "config", "models.v0.example.json"),
    path.join(dir, "models.json"),
  );
  // These tests exercise a configured fallback profile. Use an explicit test
  // registry instead of relying on the developer's mutable model settings.
  configureModels({ modelsPath: path.join(dir, "models.json") });
});


afterEach(() => {
  configureModels({ modelsPath: null });
  closeDb();
  if (dir) rmSync(dir, { recursive: true, force: true });
});


describe("Onboarding Architecture & IPC Handlers", () => {
  describe("local endpoint network policy", () => {
    it("allows localhost and private IPv4 and IPv6 ranges only", () => {
      for (const host of ["localhost", "127.0.0.1", "10.20.30.40", "172.16.2.3", "172.31.2.3", "192.168.1.9", "::1", "fd12::1", "fe80::2"]) {
        expect(isAllowedLocalModelHost(host), host).toBe(true);
      }
      for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "192.169.1.1", "169.254.1.1", "0127.0.0.1", "localhost.example.com"]) {
        expect(isAllowedLocalModelHost(host), host).toBe(false);
      }
    });

    it("rejects public model endpoints from saved registries", () => {
      expect(isAllowedLocalModelEndpoint("http://127.0.0.1:1234/v1")).toBe(true);
      expect(isAllowedLocalModelEndpoint("http://192.168.1.10:1234/v1")).toBe(true);
      expect(isAllowedLocalModelEndpoint("https://example.com/v1")).toBe(false);
      expect(isAllowedLocalModelEndpoint("http://8.8.8.8/v1")).toBe(false);
      expect(isAllowedLocalModelEndpoint("http://user:pass@127.0.0.1/v1")).toBe(false);
    });
  });

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
      expect(entries.filter(entry=>!entry.fallbackOnly)).toHaveLength(3);
      const primary = entries[0];
      expect(primary.id).toBe("primary-model");
      expect(primary.capabilities).toEqual(expect.arrayContaining(["text", "code-generation"]));
      expect(entries.find(entry=>entry.id==="vision-fallback")?.fallbackOnly).toBe(true);
      expect(primary.capabilities).not.toContain("image-input");
      expect(entries.find(entry => entry.model === "qwen2.5-vl:7b")?.capabilities).toContain("image-input");
      expect(primary.baseUrl).toBe("http://127.0.0.1:8000/v1");
      expect(primary.model).toBe("qwen3:8b");
      expect(primary.concurrencyLimit).toBe(2);

      // Verify no legacy plan model is synthesized
      const plan = entries.find((e: any) => e.id === "plan-qwen3-8b");
      expect(plan).toBeUndefined();
    });

    it("preserves custom concurrencyLimit from onboarding rows and defaults CLI profiles to 2", () => {
      const customRows: ModelConfigRow[] = [
        {
          role: "draft",
          modelName: "qwen3:8b",
          host: "127.0.0.1",
          port: 8000,
          contextLength: 16384,
          concurrencyLimit: 4,
        },
      ];
      const [entry] = buildRegistryFromRows(customRows);
      expect(entry.concurrencyLimit).toBe(4);

      const loaded = loadRegistry();
      for (const profile of loaded.values()) {
        expect(profile.concurrencyLimit).toBe(2);
      }
    });

    it("deduplicates the same endpoint configured for Vision, Coding, and Draft", () => {
      const sameEndpoint: ModelConfigRow[] = ["vision", "coding", "draft"].map((role) => ({
        role: role as ModelConfigRow["role"],
        modelName: "shared-local-model",
        host: "127.0.0.1",
        port: 11434,
        contextLength: 8192,
      }));

      const entries = buildRegistryFromRows(sameEndpoint).filter((entry) => !entry.fallbackOnly);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe("primary-model");
      expect(entries[0].model).toBe("shared-local-model");
    });

    it("lists distinct role models in the selector with Draft as the default", () => {
      const models = getModelRoutes(rows);
      expect(models.map((model) => model.name)).toEqual([
        "qwen3:8b",
        "qwen2.5-vl:7b",
        "qwen2.5-coder:32b",
      ]);
      expect(models[0].id).toBe("primary-model");
    });

    it("shows one selector choice when all three roles share one endpoint", () => {
      expect(getModelRoutes(["vision", "coding", "draft"].map((role) => ({
        role: role as ModelConfigRow["role"],
        modelName: "shared-local-model",
        host: "127.0.0.1",
        port: 11434,
        contextLength: 8192,
      })))).toHaveLength(1);
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

      // The three role endpoints stay available. Draft is the default route.
      const gateway = manager.getGateway();
      expect([...gateway.registry.values()].filter(entry=>!entry.fallbackOnly)).toHaveLength(3);
      expect(gateway.registry.get("vision-fallback")?.fallbackOnly).toBe(true);
      const primary = gateway.registry.get("primary-model");
      expect(primary).toBeDefined();
      expect(primary?.baseUrl).toBe("http://10.0.0.7:9002/v1");
      expect(primary?.model).toBe("custom-draft-model");

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

    it("verifies model availability and readiness with a local test server", async () => {
      const http = await import("node:http");
      let completionsCalled = false;
      let shouldFailProbe = false;

      const server = http.createServer((req, res) => {
        if (req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "test-ready-model" }] }));
          return;
        }
        if (req.url === "/v1/chat/completions") {
          completionsCalled = true;
          if (shouldFailProbe) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Model is not loaded into memory" } }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address() as { port: number };
      const port = addr.port;

      try {
        // 1. Model not found on server
        const notFoundRes = await handleTestModelEndpoint({
          host: "127.0.0.1",
          port,
          modelName: "non-existent-model",
        });
        expect(notFoundRes.ok).toBe(false);
        expect(notFoundRes.modelFound).toBe(false);
        expect(notFoundRes.error).toContain("is not available on this server");

        // 2. Model found and ready to serve
        completionsCalled = false;
        shouldFailProbe = false;
        const readyRes = await handleTestModelEndpoint({
          host: "127.0.0.1",
          port,
          modelName: "test-ready-model",
        });
        expect(completionsCalled).toBe(true);
        expect(readyRes.ok).toBe(true);
        expect(readyRes.modelFound).toBe(true);
        expect(readyRes.modelReady).toBe(true);

        // 3. Model found on server, but probe indicates not ready / not loaded
        shouldFailProbe = true;
        const notReadyRes = await handleTestModelEndpoint({
          host: "127.0.0.1",
          port,
          modelName: "test-ready-model",
        });
        expect(notReadyRes.ok).toBe(false);
        expect(notReadyRes.modelReady).toBe(false);
        expect(notReadyRes.error).toContain("Model is not loaded into memory");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("rejects public hosts before endpoint testing or saving", async () => {
      await expect(handleTestModelEndpoint({ host: "example.com", port: 11434 })).rejects.toThrow(/private IP address/);
      const manager = new RunManager();
      const ragService = new RAGService(dir);
      expect(() => handleSaveModelConfig({ models: [{
        role: "draft", modelName: "test-model", host: "8.8.8.8", port: 11434, contextLength: 8192,
      }] }, manager, ragService, dir)).toThrow(/private IP address|outside the allowed local network/);
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
