import path from "node:path";
import { z } from "zod";
import type { ModelConfigRow, ModelEndpointTestResult, OnboardingStatus } from "../../shared/contracts.js";
import { getSetting, setSetting } from "../persistence/settings-store.js";
import { IPC_ONBOARDING } from "./channels.js";
import type { IpcRegistrar } from "./handlers.js";
import { RunManager } from "../run/manager.js";
import { RAGService } from "../rag/rag-service.js";
import { buildRegistryFromRows, sanitizeHost, writeRegistryToFile } from "../gateway/registry.js";
import { isAllowedLocalModelHost } from "../../shared/local-network.js";


const modelConfigRowSchema = z.object({
  role: z.enum(["primary", "vision", "coding", "draft", "embedding"]),
  modelName: z.string().trim().min(1, "Model name cannot be empty"),
  host: z.string().trim().min(1, "Host / IP cannot be empty").refine((host) => isAllowedLocalModelHost(sanitizeHost(host)), "Use localhost or a private IP address"),
  port: z.number().int().min(1, "Port must be at least 1").max(65535, "Port must be <= 65535"),
  contextLength: z.number().int().min(512, "Context length must be at least 512"),
  concurrencyLimit: z.number().int().min(1, "Concurrency must be at least 1").max(32, "Concurrency must be <= 32").optional(),
});

const saveModelConfigSchema = z.object({
  models: z.array(modelConfigRowSchema).min(1, "At least one model configuration is required"),
});

const testEndpointSchema = z.object({
  host: z.string().trim().min(1, "Host is required").refine((host) => isAllowedLocalModelHost(sanitizeHost(host)), "Use localhost or a private IP address"),
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
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const urlHost = host.includes(":") ? `[${host}]` : host;

    // Check model availability using endpoints that list loaded models or downloaded models.
    // Never make models generate tokens or call completions endpoints.
    let listRes: Response | null = null;
    let loadedModels: string[] = [];
    let availableModels: string[] = [];

    // 1. Check endpoints that report actively loaded models (e.g. Ollama /api/ps, LM Studio /api/v0/models)
    try {
      const psRes = await fetch(`http://${urlHost}:${port}/api/ps`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (psRes.ok) {
        const psData = (await psRes.json()) as any;
        if (Array.isArray(psData?.models)) {
          loadedModels = psData.models.map((m: any) => m.name || m.model || m.id).filter(Boolean);
        }
      }
    } catch {}

    try {
      const v0Res = await fetch(`http://${urlHost}:${port}/api/v0/models`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (v0Res.ok) {
        const v0Data = (await v0Res.json()) as any;
        if (Array.isArray(v0Data?.data)) {
          const loaded = v0Data.data.filter((m: any) => m.state === "loaded").map((m: any) => m.id).filter(Boolean);
          if (loaded.length > 0) loadedModels = [...new Set([...loadedModels, ...loaded])];
          const all = v0Data.data.map((m: any) => m.id).filter(Boolean);
          if (all.length > 0) availableModels = [...new Set([...availableModels, ...all])];
        }
      }
    } catch {}

    // 2. Fetch available / downloaded models (/v1/models, /models, /api/tags)
    const candidateUrls = [
      `http://${urlHost}:${port}/v1/models`,
      `http://${urlHost}:${port}/models`,
      `http://${urlHost}:${port}/api/tags`,
    ];

    for (const url of candidateUrls) {
      try {
        const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (res.ok) {
          listRes = res;
          const data = (await res.json()) as any;
          let parsedNames: string[] = [];
          if (Array.isArray(data?.data)) {
            parsedNames = data.data.map((m: any) => m.id || m.name).filter(Boolean);
          } else if (Array.isArray(data?.models)) {
            parsedNames = data.models.map((m: any) => m.name || m.id || m.model).filter(Boolean);
          }
          if (parsedNames.length > 0) {
            availableModels = [...new Set([...availableModels, ...parsedNames])];
          }
          break;
        } else if (res.status !== 404 && res.status !== 405 && !listRes) {
          listRes = res;
        }
      } catch {}
    }

    if (!listRes && availableModels.length === 0 && loadedModels.length === 0) {
      return {
        ok: false,
        error: `Cannot connect to inference server at ${host}:${port}`,
      };
    }

    if (listRes && !listRes.ok && listRes.status !== 404 && listRes.status !== 405 && availableModels.length === 0 && loadedModels.length === 0) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: `Server responded with HTTP ${listRes.status}: ${listRes.statusText}`,
      };
    }

    const allModels = [...new Set([...loadedModels, ...availableModels])];

    // If a modelName is specified, verify model presence without token generation
    if (parsed.modelName) {
      const target = parsed.modelName.toLowerCase().trim();
      const matchModel = (m: string) => {
        const lower = m.toLowerCase().trim();
        if (lower === target) return true;
        if (`${lower}:latest` === target || lower === `${target}:latest`) return true;
        if (lower.startsWith(`${target}:`) || target.startsWith(`${lower}:`)) return true;
        const baseM = lower.split("/").pop() || "";
        const baseTarget = target.split("/").pop() || "";
        if (baseM === baseTarget) return true;
        if (`${baseM}:latest` === baseTarget || baseM === `${baseTarget}:latest`) return true;
        return false;
      };

      const isLoaded = loadedModels.some(matchModel);
      const isAvailable = allModels.length === 0 || allModels.some(matchModel);

      if (allModels.length > 0 && !isAvailable) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          modelFound: false,
          modelReady: false,
          availableModels: allModels,
          error: `Model "${parsed.modelName}" is not available on this server. Installed models: ${allModels.slice(0, 6).join(", ")}${allModels.length > 6 ? "..." : ""}`,
        };
      }

      return {
        ok: true,
        latencyMs: Date.now() - started,
        modelFound: true,
        modelReady: isLoaded || isAvailable,
        availableModels: allModels,
      };
    }

    return {
      ok: true,
      latencyMs: Date.now() - started,
      modelFound: true,
      modelReady: true,
      availableModels: allModels,
    };
  } catch (err: any) {
    const isTimeout = err.name === "AbortError";
    const msg = isTimeout
      ? `Connection timed out after 8000ms at ${host}:${port}`
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
