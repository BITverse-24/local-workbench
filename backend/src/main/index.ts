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

import { setDataDir } from "./run/filesystem.js";
import { configurePersistence, initDb } from "./persistence/db.js";
import { configureModels } from "./gateway/registry.js";
import {
  registerChatHandlers,
  registerRunHandlers,
  registerWorkspaceHandlers,
} from "./ipc/handlers.js";
import type { IpcRegistrar } from "./ipc/handlers.js";
import { RunManager } from "./run/manager.js";
import type { RunEvent } from "../shared/contracts.js";
import { HarnessManager } from "./harness/harness-manager.js";
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
} from "./ipc/channels.js";
export { HarnessManager } from "./harness/harness-manager.js";
export { registerKnowledgeBaseHandlers } from "./ipc/handlers.js";
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
): BackendInstance {
  if (config) {
    setDataDir(config.dataDir);
    configureModels({ modelsPath: config.modelsPath });
    configurePersistence({ dataDir: config.dataDir, schemaPath: config.schemaPath });
  }
  initDb();
  registerChatHandlers(ipcMain);
  const manager = new RunManager(undefined, emit);
  registerRunHandlers(ipcMain, manager);
  const harness = new HarnessManager(undefined, emit);
  registerWorkspaceHandlers(ipcMain, harness);
  manager.setHarness(harness);
  try {
    harness.restoreWorkspace();
  } catch (err) {
    console.warn("Failed to restore previous workspace on startup:", err);
  }

  const dataDir = config?.dataDir ?? "./data";
  const embeddingConfig = config?.embeddingConfig ?? {
    baseUrl: "http://localhost:1234/v1",
    model: "nomic-embed-text:v1.5",
  };
  const ragService = new RAGService(dataDir, embeddingConfig);
  registerKnowledgeBaseHandlers(ipcMain, ragService);
  const grounding = new RAGGroundingProvider(ragService);
  manager.setGrounding(grounding);
  manager.setRAGService(ragService);
  void ragService.init().catch((err) => {
    console.warn("Failed to initialize RAG subsystem on startup:", err);
  });

  (manager as any).harness = harness;
  return manager as BackendInstance;
}

