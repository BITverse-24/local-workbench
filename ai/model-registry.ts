import type { ModelRegistryEntry } from "./contracts";

/**
 * Development-only model routing configuration.
 *
 * Stable ids are application-facing. Provider model names may change when
 * Supreet switches the gateway from OpenRouter to the final LAN services.
 * This file contains no credentials.
 */
export const developmentModelRegistry: readonly ModelRegistryEntry[] = [
  {
    id: "vision-qwen25vl",
    taskTypes: ["vision"],
    runtime: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen2.5-vl-3b-instruct",
    capabilities: ["text", "image-input", "structured-output"],
    requestTimeoutMs: 60_000,
    healthPath: "/models",
    apiKeyEnv: "OPENROUTER_API_KEY",
    enabled: true,
  },
  {
    id: "draft-qwen3",
    taskTypes: ["draft"],
    runtime: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3-4b",
    capabilities: ["text", "structured-output"],
    requestTimeoutMs: 45_000,
    healthPath: "/models",
    apiKeyEnv: "OPENROUTER_API_KEY",
    enabled: true,
  },
  {
    id: "code-qwen25coder",
    taskTypes: ["code"],
    runtime: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen2.5-coder-7b-instruct",
    capabilities: ["text", "code-generation"],
    requestTimeoutMs: 60_000,
    healthPath: "/models",
    apiKeyEnv: "OPENROUTER_API_KEY",
    enabled: true,
  },
];

/**
 * Separate from task routing: this service creates vectors for the local
 * Chroma index and must remain LAN-local in the final deployment.
 */
export const developmentEmbeddingService = {
  service: "embeddings" as const,
  model: "BAAI/bge-small-en-v1.5",
  dimensions: 384,
  distanceMetric: "cosine" as const,
  baseUrl: "http://<local-embedding-host>/v1",
  requestTimeoutMs: 10_000,
  enabled: true,
};
