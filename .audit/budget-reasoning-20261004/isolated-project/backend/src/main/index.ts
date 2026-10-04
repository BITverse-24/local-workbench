// Backend main entry — launch wiring (backend/src/main/index.ts).
// Called once by the Electron main process after `app.whenReady()`:
//
//   import { initBackend } from "../../backend/src/main/index.js";
//   app.whenReady().then(() => {
//     initBackend(ipcMain, emit, { dataDir, modelsPath, schemaPath });
//   });
//
// This module never imports `electron` itself: `ipcMain` is passed in and only the
// structural `IpcRegistrar` surface is used, so this file is unit-testable and
// bundler-friendly.

// Polyfill Promise.try for Node.js < 22 environments (Electron 30 is Node 20.16)
if (typeof (Promise as any).try !== "function") {
  (Promise as any).try = function <T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T> {
    return new Promise((resolve) => resolve(fn(...args)));
  };
}

import { setDataDir } from "./run/filesystem.js";
import { configurePersistence, initDb } from "./persistence/db.js";
import { configureModels } from "./gateway/registry.js";
import {
  registerChatHandlers,
  registerRunHandlers,
  registerWorkspaceHandlers,
  registerOnboardingHandlers,
  restoreSavedModelConfig,
} from "./ipc/handlers.js";
import type { IpcRegistrar } from "./ipc/handlers.js";
import { RunManager } from "./run/manager.js";
import type { ModelGateway } from "./gateway/model-gateway.js";
import type { RunEvent } from "../shared/contracts.js";
import { HarnessManager, type WorkspaceEvent } from "./harness/harness-manager.js";
import { registerKnowledgeBaseHandlers } from "./ipc/handlers.js";
import { RAGService } from "./rag/rag-service.js";
import { RAGGroundingProvider } from "./grounding/rag-grounding-provider.js";

export { CHAT_CHANNELS, IPC_CHAT, type ChatChannel } from "./ipc/channels.js";
export {
  registerChatHandlers,
  registerRunHandlers,
  registerWorkspaceHandlers,
} from "./ipc/handlers.js";
export type { IpcRegistrar, MinimalIpcMain } from "./ipc/handlers.js";
export {
  IPC_WORKSPACE,
  WORKSPACE_CHANNELS,
  type WorkspaceChannel,
  IPC_KB,
  KB_CHANNELS,
  type KBChannel,
  IPC_ONBOARDING,
  ONBOARDING_CHANNELS,
  type OnboardingChannel,
} from "./ipc/channels.js";
export { HarnessManager, type WorkspaceEvent } from "./harness/harness-manager.js";
export { registerKnowledgeBaseHandlers } from "./ipc/handlers.js";
export { registerOnboardingHandlers, restoreSavedModelConfig } from "./ipc/handlers.js";
export { RAGService } from "./rag/rag-service.js";
export { RAGGroundingProvider } from "./grounding/rag-grounding-provider.js";

export interface BackendConfig {
  dataDir: string;
  modelsPath: string;
  schemaPath: string;
  embeddingConfig?: {
    baseUrl: string;
    model: string;
    apiKey?: string;
  };
}

export type BackendInstance = RunManager & {
  harness: HarnessManager;
  ragService: RAGService;
};

/** Open SQLite (idempotent migrate + seed) and register chat, run, and workspace IPC handlers. */
export function initBackend(
  ipcMain: IpcRegistrar,
  emit?: (event: RunEvent) => void,
  config?: BackendConfig,
  emitWorkspace?: (event: WorkspaceEvent) => void,
  gateway?: ModelGateway,
): BackendInstance {
  if (config) {
    setDataDir(config.dataDir);
    configureModels({ modelsPath: config.modelsPath });
    configurePersistence({ dataDir: config.dataDir, schemaPath: config.schemaPath });
  }
  initDb();
  registerChatHandlers(ipcMain);
  const manager = new RunManager(gateway, emit);
  registerRunHandlers(ipcMain, manager);
  const harness = new HarnessManager(emitWorkspace ?? (() => undefined), emit);
  registerWorkspaceHandlers(ipcMain, harness);
  manager.setHarness(harness);
  try {
    harness.restoreWorkspace();
  } catch (err) {
    console.warn("Failed to restore previous workspace on startup:", err);
  }

  const dataDir = config?.dataDir ?? "./data";
  const ragService = new RAGService(dataDir, config?.embeddingConfig);
  registerKnowledgeBaseHandlers(ipcMain, ragService);
  const grounding = new RAGGroundingProvider(ragService);
  manager.setGrounding(grounding);
  manager.setRAGService(ragService);
  void ragService.init().catch((err) => {
    console.warn("Failed to initialize RAG subsystem on startup:", err);
  });

  registerOnboardingHandlers(ipcMain, manager, ragService, dataDir);
  try {
    const restored = restoreSavedModelConfig(manager, ragService);
    if (restored) {
      console.log("[backend] restored user-configured model endpoints from persistence");
    }
  } catch (err) {
    console.warn("Failed to restore saved model config on startup:", err);
  }

  (manager as any).harness = harness;
  return manager as BackendInstance;
}


