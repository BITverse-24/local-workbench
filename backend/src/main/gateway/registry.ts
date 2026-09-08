import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ModelId, ModelRegistryEntry } from "../../shared/contracts.js";

const entry = z.object({ id: z.enum(["vision-qwen25vl", "draft-qwen3", "code-qwen25coder"]), taskTypes: z.array(z.enum(["vision", "draft", "code"])), runtime: z.enum(["mlx-lm", "llama-server", "openrouter"]), baseUrl: z.string().url(), model: z.string().min(1), capabilities: z.array(z.enum(["text", "image-input", "structured-output", "code-generation"])), requestTimeoutMs: z.number().int().positive().max(120000), healthPath: z.literal("/models"), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(), enabled: z.boolean(), maxOutputTokens: z.number().int().positive().max(128000).optional() }).strict();
const config = z.object({ $comment: z.string().optional(), models: z.array(entry).min(1), developmentEmbeddingService: z.unknown().optional() }).strict();
const here = path.dirname(fileURLToPath(import.meta.url));
function registryCandidates(): string[] {
  const list: string[] = [];
  // Explicit override (e.g. tests / packaging).
  const fromEnv = process.env.WORKBENCH_MODELS_PATH;
  if (fromEnv) list.push(path.resolve(fromEnv));
  // Source layout: backend/src/main/gateway -> backend/config/models.json
  list.push(path.resolve(here, "../../../config/models.json"));
  // Bundled layout: electron_app/dist-electron/main.js -> <repo>/backend/config/models.json
  list.push(path.resolve(here, "../../backend/config/models.json"));
  // APP_ROOT is set by electron_app/electron/main.ts to electron_app/
  const appRoot = process.env.APP_ROOT;
  if (appRoot) list.push(path.resolve(appRoot, "../backend/config/models.json"));
  // cwd variants: `npm run dev` may run from repo root or electron_app/
  list.push(path.resolve(process.cwd(), "backend/config/models.json"));
  list.push(path.resolve(process.cwd(), "../backend/config/models.json"));
  list.push(path.resolve(process.cwd(), "config/models.json"));
  // Legacy candidate (repo parent) — kept last for backwards compat.
  list.push(path.resolve(here, "../../../../config/models.json"));
  return [...new Set(list)];
}
const candidates = registryCandidates();
export function loadRegistry(filePath = candidates.find((p) => { try { readFileSync(p); return true; } catch { return false; } }) ?? (() => { throw new Error(`models.json not found (tried: ${candidates.join("; ")})`); })()): Map<ModelId, ModelRegistryEntry> {
  const parsed = config.parse(JSON.parse(readFileSync(filePath, "utf8")));
  return new Map(parsed.models.map((model) => [model.id, model as ModelRegistryEntry]));
}
export function resolveModel(registry: Map<ModelId, ModelRegistryEntry>, modelId: ModelId, taskType?: string): ModelRegistryEntry {
  const model = registry.get(modelId);
  if (!model || !model.enabled || (taskType && !model.taskTypes.includes(taskType as never))) throw new Error(`model unavailable: ${modelId}`);
  return model;
}
