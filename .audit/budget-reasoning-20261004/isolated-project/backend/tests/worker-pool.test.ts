import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { buildRegistryFromRows } from "../src/main/gateway/registry.js";
import type { ModelConfigRow, ModelRegistryEntry } from "../src/shared/contracts.js";

describe("ModelGateway Worker Pool & Load Balancing", () => {
  const instanceA: ModelRegistryEntry = {
    id: "draft-qwen3",
    taskTypes: ["draft"],
    runtime: "ollama",
    baseUrl: "http://192.168.1.10:11434/v1",
    model: "qwen3:8b",
    capabilities: ["text", "structured-output"],
    requestTimeoutMs: 30000,
    healthPath: "/models",
    enabled: true,
  };

  const instanceB: ModelRegistryEntry = {
    id: "draft-qwen3",
    taskTypes: ["draft"],
    runtime: "ollama",
    baseUrl: "http://192.168.1.11:11434/v1",
    model: "qwen3:8b",
    capabilities: ["text", "structured-output"],
    requestTimeoutMs: 30000,
    healthPath: "/models",
    enabled: true,
  };

  it("registers multiple instances and load-balances via round-robin", () => {
    const gateway = new ModelGateway();
    gateway.registerModelInstances("draft-qwen3", [instanceA, instanceB]);

    const instances = gateway.getModelInstances("draft-qwen3");
    expect(instances).toHaveLength(2);

    // Call 1 -> Node A
    const selected1 = gateway.resolveNextEndpoint("draft-qwen3");
    expect(selected1?.baseUrl).toBe("http://192.168.1.10:11434/v1");

    // Call 2 -> Node B (round robin!)
    const selected2 = gateway.resolveNextEndpoint("draft-qwen3");
    expect(selected2?.baseUrl).toBe("http://192.168.1.11:11434/v1");

    // Call 3 -> Node A (wrap around)
    const selected3 = gateway.resolveNextEndpoint("draft-qwen3");
    expect(selected3?.baseUrl).toBe("http://192.168.1.10:11434/v1");
  });

  it("skips disabled worker instances in the pool", () => {
    const disabledB = { ...instanceB, enabled: false };
    const gateway = new ModelGateway();
    gateway.registerModelInstances("draft-qwen3", [instanceA, disabledB]);

    // Should always route to instanceA since B is disabled
    expect(gateway.resolveNextEndpoint("draft-qwen3")?.baseUrl).toBe("http://192.168.1.10:11434/v1");
    expect(gateway.resolveNextEndpoint("draft-qwen3")?.baseUrl).toBe("http://192.168.1.10:11434/v1");
  });

  it("populates worker pool from buildRegistryFromRows with multiple rows for a role", () => {
    const rows: ModelConfigRow[] = [
      { role: "vision", modelName: "qwen2.5vl:3b", host: "127.0.0.1", port: 11434, contextLength: 32768 },
      { role: "coding", modelName: "qwen2.5-coder:7b", host: "127.0.0.1", port: 11434, contextLength: 32768 },
      { role: "draft", modelName: "qwen3:8b", host: "127.0.0.1", port: 11434, contextLength: 32768 },
      { role: "draft", modelName: "qwen3:8b", host: "192.168.1.50", port: 11434, contextLength: 32768 },
    ];

    const entries = buildRegistryFromRows(rows);
    const gateway = new ModelGateway();
    gateway.updateRegistry(entries);

    const draftInstances = gateway.getModelInstances("draft-qwen3");
    expect(draftInstances).toHaveLength(2);
    expect(draftInstances[0].baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(draftInstances[1].baseUrl).toBe("http://192.168.1.50:11434/v1");

    // Round-robin resolution
    const first = gateway.resolveNextEndpoint("draft-qwen3");
    expect(first?.baseUrl).toBe("http://127.0.0.1:11434/v1");
    const second = gateway.resolveNextEndpoint("draft-qwen3");
    expect(second?.baseUrl).toBe("http://192.168.1.50:11434/v1");
  });
});

