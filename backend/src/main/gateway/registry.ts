import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ModelId, ModelRegistryEntry } from "../../shared/contracts.js";

const entry = z.object({ id: z.enum(["vision-qwen25vl", "draft-qwen3", "code-qwen25coder"]), taskTypes: z.array(z.enum(["vision", "draft", "code"])), runtime: z.enum(["mlx-lm", "llama-server", "openrouter"]), baseUrl: z.string().url(), model: z.string().min(1), capabilities: z.array(z.enum(["text", "image-input", "structured-output", "code-generation"])), requestTimeoutMs: z.number().int().positive().max(120000), healthPath: z.literal("/models"), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(), enabled: z.boolean() }).strict();
const config = z.object({ $comment: z.string().optional(), models: z.array(entry).min(1), developmentEmbeddingService: z.unknown().optional() }).strict();
const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [path.resolve(here, "../../../config/models.json"), path.resolve(here, "../../../../config/models.json"), path.resolve(process.cwd(), "backend/config/models.json")];
export function loadRegistry(filePath = candidates.find((p) => { try { readFileSync(p); return true; } catch { return false; } }) ?? candidates[0]): Map<ModelId, ModelRegistryEntry> {
  const parsed = config.parse(JSON.parse(readFileSync(filePath, "utf8")));
  return new Map(parsed.models.map((model) => [model.id, model as ModelRegistryEntry]));
}
export function resolveModel(registry: Map<ModelId, ModelRegistryEntry>, modelId: ModelId, taskType?: string): ModelRegistryEntry {
  const model = registry.get(modelId);
  if (!model || !model.enabled || (taskType && !model.taskTypes.includes(taskType as never))) throw new Error(`model unavailable: ${modelId}`);
  return model;
}
