import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ModelId, ModelRegistryEntry } from "../../shared/contracts.js";

const entry = z.object({ id: z.enum(["vision-qwen25vl", "draft-qwen3", "code-qwen25coder", "plan-qwen3-8b"]), taskTypes: z.array(z.enum(["vision", "draft", "code", "plan"])), runtime: z.enum(["mlx-lm", "llama-server", "openrouter", "ollama"]), baseUrl: z.string().url(), model: z.string().min(1), capabilities: z.array(z.enum(["text", "image-input", "structured-output", "code-generation"])), requestTimeoutMs: z.number().int().positive().max(120000), healthPath: z.literal("/models"), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(), enabled: z.boolean(), maxOutputTokens: z.number().int().positive().max(128000).optional() }).strict();
const config = z.object({ $comment: z.string().optional(), models: z.array(entry).min(1) }).strict();

let configuredModelsPath: string | null = null;

/** Called from `initBackend` with the Electron-provided config. */
export function configureModels(options: { modelsPath: string }): void {
  configuredModelsPath = options.modelsPath;
}

function defaultModelsPath(): string {
  if (configuredModelsPath) return configuredModelsPath;
  const fromEnv = process.env.WORKBENCH_MODELS_PATH;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "config", "models.json");
}

export function loadRegistry(filePath?: string): Map<ModelId, ModelRegistryEntry> {
  const resolved = filePath ?? defaultModelsPath();
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`models.json not found (tried: ${resolved})`);
  }
  const parsed = config.parse(JSON.parse(text));
  return new Map(parsed.models.map((model) => [model.id, model as ModelRegistryEntry]));
}
export function resolveModel(registry: Map<ModelId, ModelRegistryEntry>, modelId: ModelId, taskType?: string): ModelRegistryEntry {
  const model = registry.get(modelId);
  if (!model || !model.enabled || (taskType && !model.taskTypes.includes(taskType as never))) throw new Error(`model unavailable: ${modelId}`);
  return model;
}
