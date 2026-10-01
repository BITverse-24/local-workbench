import path from "node:path";
import { z } from "zod";
import type { ModelConfigRow, ModelEndpointTestResult, OnboardingStatus } from "../../shared/contracts.js";
import { getSetting, setSetting } from "../persistence/settings-store.js";
import { IPC_ONBOARDING } from "./channels.js";
import type { IpcRegistrar } from "./handlers.js";
import { RunManager } from "../run/manager.js";
import { RAGService } from "../rag/rag-service.js";
import { buildRegistryFromRows, sanitizeHost, writeRegistryToFile } from "../gateway/registry.js";


const modelConfigRowSchema = z.object({
  role: z.enum(["vision", "coding", "draft", "embedding"]),
  modelName: z.string().trim().min(1, "Model name cannot be empty"),
  host: z.string().trim().min(1, "Host / IP cannot be empty"),
  port: z.number().int().min(1, "Port must be at least 1").max(65535, "Port must be <= 65535"),
  contextLength: z.number().int().min(512, "Context length must be at least 512"),
});

const saveModelConfigSchema = z.object({
  models: z.array(modelConfigRowSchema).min(1, "At least one model configuration is required"),
});

const testEndpointSchema = z.object({
  host: z.string().trim().min(1, "Host is required"),
  port: z.number().int().min(1).max(65535),
  modelName: z.string().trim().optional(),
  role: z.string().optional(),
});

export function handleGetOnboardingStatus(): OnboardingStatus {
  const completed = !!getSetting<boolean>("onboarding_completed");
  const configuredModels = getSetting<ModelConfigRow[]>("configured_models") || undefined;
  return { completed, configuredModels };
}

export function handleResetOnboarding(): { ok: boolean } {
  setSetting("onboarding_completed", false);
  return { ok: true };
}

export async function handleTestModelEndpoint(input: unknown): Promise<ModelEndpointTestResult> {
  const parsed = testEndpointSchema.parse(input);
  const host = sanitizeHost(parsed.host);
  const port = parsed.port;
  const started = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    // Attempt standard OpenAI endpoint first (/v1/models)
    let url = `http://${host}:${port}/v1/models`;
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    } catch {
      // Fallback to /models (e.g. some ollama or local setups)
      url = `http://${host}:${port}/models`;
      res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    }

    const latencyMs = Date.now() - started;
    if (!res.ok && res.status !== 404) {
      return {
        ok: false,
        latencyMs,
        error: `Server responded with HTTP ${res.status}: ${res.statusText}`,
      };
    }

    let availableModels: string[] = [];
    try {
      const data = (await res.json()) as any;
      if (Array.isArray(data?.data)) {
        availableModels = data.data.map((m: any) => m.id || m.name).filter(Boolean);
      } else if (Array.isArray(data?.models)) {
        availableModels = data.models.map((m: any) => m.name || m.id).filter(Boolean);
      }
    } catch {
      // Response wasn't JSON or model enumeration isn't supported, but server is live
    }

    let modelFound = true;
    if (parsed.modelName && availableModels.length > 0) {
      const target = parsed.modelName.toLowerCase().trim();
      modelFound = availableModels.some((m) => {
        const lower = m.toLowerCase();
        return lower === target || lower.startsWith(`${target}:`) || target.startsWith(`${lower}:`);
      });
    }

    return {
      ok: true,
      latencyMs,
      modelFound,
      availableModels,
    };
  } catch (err: any) {
    const isTimeout = err.name === "AbortError";
    const msg = isTimeout
      ? `Connection timed out after 4000ms at ${host}:${port}`
      : `Cannot connect to ${host}:${port} (${err.code || err.message})`;
    return {
      ok: false,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function handleSaveModelConfig(
  input: unknown,
  runManager: RunManager,
  ragService: RAGService,
  dataDir: string,
): { ok: boolean } {
  const { models } = saveModelConfigSchema.parse(input);

  // 1. Persist raw configuration in SQLite settings table
  setSetting("onboarding_completed", true);
  setSetting("configured_models", models);

  // 2. Build model registry entries and dynamically update ModelGateway in memory
  const entries = buildRegistryFromRows(models);
  runManager.getGateway().updateRegistry(entries);

  // 3. Check for embedding role and update RAGService
  const embeddingRow = models.find((m) => m.role === "embedding");
  if (embeddingRow) {
    const host = sanitizeHost(embeddingRow.host);
    const port = embeddingRow.port || 11434;
    const embConfig = {
      baseUrl: `http://${host}:${port}/v1`,
      model: embeddingRow.modelName,
    };
    ragService.updateEmbeddingConfig(embConfig);
    setSetting("embedding_config", embConfig);
  }

  // 4. Save synced backup models.json
  try {
    const backupPath = path.join(dataDir, "models.json");
    writeRegistryToFile(entries, backupPath);
  } catch (e) {
    console.warn("[onboarding] failed to write backup models.json:", e);
  }

  return { ok: true };
}

/** Restore previously configured models and settings into memory on startup. */
export function restoreSavedModelConfig(
  runManager: RunManager,
  ragService: RAGService,
): boolean {
  const models = getSetting<ModelConfigRow[]>("configured_models");
  if (!models || !Array.isArray(models) || models.length === 0) return false;

  try {
    const entries = buildRegistryFromRows(models);
    runManager.getGateway().updateDbRegistry(entries);

    const embeddingRow = models.find((m) => m.role === "embedding");
    if (embeddingRow) {
      const host = sanitizeHost(embeddingRow.host);
      const port = embeddingRow.port || 11434;
      ragService.updateEmbeddingConfig({
        baseUrl: `http://${host}:${port}/v1`,
        model: embeddingRow.modelName,
      });
    }
    return true;
  } catch (e) {
    console.warn("[onboarding] failed to restore saved model configuration:", e);
    return false;
  }
}

export function registerOnboardingHandlers(
  ipcMain: IpcRegistrar,
  runManager: RunManager,
  ragService: RAGService,
  dataDir: string = "./data",
): void {
  ipcMain.handle(IPC_ONBOARDING.GET_STATUS, () => {
    return handleGetOnboardingStatus();
  });

  ipcMain.handle(IPC_ONBOARDING.SAVE_CONFIG, (_event, input) => {
    return handleSaveModelConfig(input, runManager, ragService, dataDir);
  });

  ipcMain.handle(IPC_ONBOARDING.TEST_ENDPOINT, (_event, input) => {
    return handleTestModelEndpoint(input);
  });

  ipcMain.handle(IPC_ONBOARDING.RESET, () => {
    return handleResetOnboarding();
  });
}

