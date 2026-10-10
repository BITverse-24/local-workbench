import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { buildRegistryFromRows } from "../src/main/gateway/registry.js";
import type { ModelConfigRow, ModelRegistryEntry } from "../src/shared/contracts.js";

describe("ModelGateway Worker Pool & Load Balancing", () => {
  const instanceA: ModelRegistryEntry = {
    id: "primary-model",
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
    id: "primary-model",
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
    gateway.registerModelInstances("primary-model", [instanceA, instanceB]);

    const instances = gateway.getModelInstances("primary-model");
    expect(instances).toHaveLength(2);

    // Call 1 -> Node A
    const selected1 = gateway.resolveNextEndpoint("primary-model");
    expect(selected1?.baseUrl).toBe("http://192.168.1.10:11434/v1");

    // Call 2 -> Node B (round robin!)
    const selected2 = gateway.resolveNextEndpoint("primary-model");
    expect(selected2?.baseUrl).toBe("http://192.168.1.11:11434/v1");

    // Call 3 -> Node A (wrap around)
    const selected3 = gateway.resolveNextEndpoint("primary-model");
    expect(selected3?.baseUrl).toBe("http://192.168.1.10:11434/v1");
  });

  it("skips disabled worker instances in the pool", () => {
    const disabledB = { ...instanceB, enabled: false };
    const gateway = new ModelGateway();
    gateway.registerModelInstances("primary-model", [instanceA, disabledB]);

    // Should always route to instanceA since B is disabled
    expect(gateway.resolveNextEndpoint("primary-model")?.baseUrl).toBe("http://192.168.1.10:11434/v1");
    expect(gateway.resolveNextEndpoint("primary-model")?.baseUrl).toBe("http://192.168.1.10:11434/v1");
  });

  it("keeps configured endpoints individually selectable", () => {
    const rows: ModelConfigRow[] = [
      { role: "vision", modelName: "qwen2.5vl:3b", host: "127.0.0.1", port: 11434, contextLength: 32768 },
      { role: "primary", modelName: "qwen3:8b", host: "127.0.0.1", port: 11434, contextLength: 32768 },
      { role: "primary", modelName: "qwen3:8b", host: "192.168.1.50", port: 11434, contextLength: 32768 },
    ];

    const entries = buildRegistryFromRows(rows);
    const gateway = new ModelGateway();
    gateway.updateRegistry(entries);

    const draftInstances = gateway.getModelInstances("primary-model");
    expect(draftInstances).toHaveLength(1);
    expect(draftInstances[0].baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(gateway.getModelInstances('model-2')).toHaveLength(1);
    expect(gateway.getModelInstances('model-2')[0].baseUrl).toBe("http://192.168.1.50:11434/v1");

    // Round-robin resolution
    const first = gateway.resolveNextEndpoint("primary-model");
    expect(first?.baseUrl).toBe("http://127.0.0.1:11434/v1");
    const second = gateway.resolveNextEndpoint("model-2");
    expect(second?.baseUrl).toBe("http://192.168.1.50:11434/v1");
  });
});
