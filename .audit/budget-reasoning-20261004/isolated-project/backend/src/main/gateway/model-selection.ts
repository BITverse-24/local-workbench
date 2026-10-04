import type {
  ModelConfigRow,
  ModelId,
  ModelRegistryEntry,
} from "../../shared/contracts.js";
import type { ModelGateway } from "./model-gateway.js";
import { getSetting } from "../persistence/settings-store.js";
import { buildRegistryFromRows, defaultLocalRegistry } from "./registry.js";

export interface ResolveModelSelectionOptions {
  explicitSelection?: string;
  gateway?: ModelGateway;
  configuredModels?: ModelConfigRow[];
}

export interface ModelSelectionSuccess {
  ok: true;
  modelId: ModelId;
  modelEntry: ModelRegistryEntry;
  isSingleModel: boolean;
  reason: string;
}

export interface ModelSelectionFailure {
  ok: false;
  code: "model_unavailable";
  error: string;
}

export type ModelSelectionResult = ModelSelectionSuccess | ModelSelectionFailure;

/**
 * Returns all configured inference endpoints (excluding embedding-only models).
 */
export function getUsableConfiguredModels(
  gateway?: ModelGateway,
  dbModels?: ModelConfigRow[],
): ModelRegistryEntry[] {
  let rows = dbModels;
  if (!rows) {
    try {
      rows = getSetting<ModelConfigRow[]>("configured_models");
    } catch {
      // In isolated test environments where DB is uninitialized
    }
  }

  if (rows !== undefined && Array.isArray(rows)) {
    const llmRows = rows.filter((r) => r.role !== "embedding" && r.modelName?.trim());
    if (llmRows.length > 0) {
      if (gateway && gateway.registry && gateway.registry.size > 0) {
        const enabled = Array.from(gateway.registry.values()).filter((e) => e.enabled);
        if (enabled.length > 0) return enabled;
      }
      return buildRegistryFromRows(llmRows);
    }
    return [];
  }

  if (gateway && gateway.registry && gateway.registry.size > 0) {
    const enabled = Array.from(gateway.registry.values()).filter((e) => e.enabled);
    if (enabled.length > 0) return enabled;
  }

  return Array.from(defaultLocalRegistry().values());
}

/**
 * Counts the actual configured and usable inference endpoints,
 * deduplicating entries that point to the exact same model endpoint.
 */
export function countUsableModels(
  gateway?: ModelGateway,
  dbModels?: ModelConfigRow[],
): number {
  let rows = dbModels;
  if (!rows) {
    try {
      rows = getSetting<ModelConfigRow[]>("configured_models");
    } catch {}
  }

  if (rows !== undefined && Array.isArray(rows)) {
    const llmRows = rows.filter((r) => r.role !== "embedding" && r.modelName?.trim());
    const endpoints = new Set<string>();
    for (const r of llmRows) {
      endpoints.add(`${r.host}:${r.port}/${r.modelName}`);
    }
    return endpoints.size;
  }

  const entries = getUsableConfiguredModels(gateway, dbModels);
  const endpoints = new Set<string>();
  for (const e of entries) {
    endpoints.add(`${e.baseUrl}/${e.model}`);
  }
  return endpoints.size;
}

function findMatchingModel(
  selection: string,
  models: ModelRegistryEntry[],
): ModelRegistryEntry | undefined {
  const norm = selection.toLowerCase().trim();
  // 1. Exact ID match (e.g. "code-qwen25coder", "draft-qwen3", "vision-qwen25vl")
  const byId = models.find((m) => m.id.toLowerCase() === norm);
  if (byId) return byId;

  // 2. Exact model name match (e.g. "qwen2.5-coder:7b")
  const byModel = models.find((m) => m.model.toLowerCase() === norm);
  if (byModel) return byModel;

  // 3. Role aliases
  if (norm === "coding" || norm === "code") {
    return models.find((m) => m.id === "code-qwen25coder" || m.taskTypes.includes("code"));
  }
  if (norm === "draft" || norm === "drafting" || norm === "chat") {
    return models.find((m) => m.id === "draft-qwen3" || m.taskTypes.includes("draft"));
  }
  if (norm === "vision" || norm === "image") {
    return models.find((m) => m.id === "vision-qwen25vl" || m.taskTypes.includes("vision"));
  }

  // 4. Substring / partial match
  return models.find(
    (m) =>
      m.id.toLowerCase().includes(norm) ||
      m.model.toLowerCase().includes(norm) ||
      norm.includes(m.id.toLowerCase()) ||
      norm.includes(m.model.toLowerCase()),
  );
}

function findPrimaryModel(models: ModelRegistryEntry[]): ModelRegistryEntry {
  const draft = models.find((m) => m.id === "draft-qwen3" || m.taskTypes.includes("draft"));
  if (draft && draft.enabled !== false) return draft;
  return models[0];
}

/**
 * Resolves the execution model according to the Sovereign Workbench Phase 1 specification:
 * - Single-LLM configuration: automatically uses the single configured model for all tasks.
 * - Multi-LLM configuration: uses explicit user selection if provided, or configured primary model.
 * - Removed / unavailable model: returns error without silent substitution.
 */
export function resolveModelSelection(
  options: ResolveModelSelectionOptions,
): ModelSelectionResult {
  const usableModels = getUsableConfiguredModels(options.gateway, options.configuredModels);
  const modelCount = countUsableModels(options.gateway, options.configuredModels);

  if (usableModels.length === 0) {
    return {
      ok: false,
      code: "model_unavailable",
      error: "No usable LLM models are configured or available in active model registry.",
    };
  }

  // 1. Single-LLM configuration
  if (modelCount <= 1) {
    const single = usableModels[0];
    return {
      ok: true,
      modelId: single.id,
      modelEntry: single,
      isSingleModel: true,
      reason: "single configured model",
    };
  }

  // 2. Multi-LLM configuration with explicit user selection
  const explicit = options.explicitSelection?.trim();
  if (explicit) {
    const match = findMatchingModel(explicit, usableModels);
    if (match && match.enabled !== false) {
      return {
        ok: true,
        modelId: match.id,
        modelEntry: match,
        isSingleModel: false,
        reason: "explicit user selection",
      };
    }
    return {
      ok: false,
      code: "model_unavailable",
      error: `Selected model "${explicit}" is unavailable or not configured in active model registry.`,
    };
  }

  // 3. Multi-LLM configuration without explicit selection -> default to primary model
  const primary = findPrimaryModel(usableModels);
  return {
    ok: true,
    modelId: primary.id,
    modelEntry: primary,
    isSingleModel: false,
    reason: "configured primary model",
  };
}
