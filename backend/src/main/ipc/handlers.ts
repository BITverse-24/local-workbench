import { selectSourcePages } from "../run/source-page-selection.js";
// Chat-persistence IPC handlers (backend/src/main/ipc/handlers.ts).
// Pure handler functions (no `electron` import) plus structural IPC registration keep
// the backend testable with a fake ipcMain. Run events are emitted through the callback
// supplied to RunManager and forwarded by the Electron main process.
//
// Errors (incl. Zod validation failures) propagate as invoke rejections; the renderer
// must try/catch. All returns are structured-clone / JSON-safe.

import { archiveChat, createChat, listChats, renameChat, initializeChatTitle, getChat, chatMetadata } from "../persistence/chats.js";
import type { ChatTitleEvent } from "../../shared/contracts.js";
import { getDb } from "../persistence/db.js";
import { suggestWorkspacePaths } from "../harness/workspace-references.js";
import { workspaceSuggestSchema } from "./validators.js";
import { addMessage, editMessage, listMessages, type Message } from "../persistence/messages.js";
import { getSetting, setSetting } from "../persistence/settings-store.js";
import { IPC_CHAT, IPC_RUN, IPC_WORKSPACE } from "./channels.js";
import {
  archiveChatSchema,
  createChatSchema,
  editMessageSchema,
  getChatHistorySchema,
  getMessagesSchema,
  getSettingSchema,
  renameChatSchema,
  sendMessageSchema,
  setSettingSchema,
  startRunSchema,
  confirmActionSchema,
  selectSourcePagesSchema,
  cancelRunSchema,
  resumeRunSchema,
  getRunSnapshotSchema,
  getArtifactSchema,
  getVerificationReportSchema,
  getRunHistorySchema,
  registerAttachmentSchema,
  registerWorkspaceSchema,
  harnessListDirSchema,
  harnessReadFileSchema,
  harnessSearchSchema,
  harnessWriteFileSchema,
  harnessRunCommandSchema,
} from "./validators.js";
import { getExecutionCapabilities } from "../tools/execution-capabilities.js";
import { RunManager } from "../run/manager.js";
import { HarnessManager } from "../harness/harness-manager.js";

/** Structural subset of Electron's ipcMain needed here (keeps backend testable w/o electron). */
export interface IpcRegistrar {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>,
  ): void;
  on?(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

/** Kept as an alias so existing tests compiling against `MinimalIpcMain` keep working. */
export type MinimalIpcMain = IpcRegistrar;

export interface ChatSummary {
  id: string;
  title: string;
  updated_at: string;
}

export function handleCreateChat(input: unknown): { chatId: string } {
  const parsed = createChatSchema.parse(input ?? {});
  return { chatId: createChat(parsed.title) };
}

export function handleGetChatHistory(input: unknown): { chats: ChatSummary[] } {
  const parsed = getChatHistorySchema.parse(input ?? {});
  return { chats: listChats(parsed.limit ?? 50) };
}

export function handleArchiveChat(input: unknown): void {
  const parsed = archiveChatSchema.parse(input);
  archiveChat(parsed.chatId);
}

export function handleRenameChat(input: unknown): void {
  const parsed = renameChatSchema.parse(input);
  renameChat(parsed.chatId, parsed.title);
}

export function handleGetMessages(input: unknown): { messages: Message[] } {
  const parsed = getMessagesSchema.parse(input);
  return { messages: listMessages(parsed.chatId) };
}

export function handleSendMessage(input: unknown): { messageId: string; seq: number; chatTitle?: ChatTitleEvent } {
  const parsed = sendMessageSchema.parse(input);
  const { id, seq } = addMessage({
    chat_id: parsed.chatId,
    role: parsed.role,
    content: parsed.content || " ",
    attachment_ids: parsed.attachmentIds,
  });
  const first = parsed.role === "user" && !(getDb().prepare("SELECT id FROM messages WHERE chat_id=? AND role='user' AND id<>? LIMIT 1").get(parsed.chatId, id));
  const names = (parsed.attachmentIds ?? []).flatMap(attachmentId => {
    const row = getDb().prepare("SELECT filename FROM attachments WHERE attachment_id=? AND chat_id=?").get(attachmentId, parsed.chatId) as { filename: string } | undefined;
    return row ? [row.filename] : [];
  });
  const chatTitle = first ? initializeChatTitle(parsed.chatId, parsed.content, names) : undefined;
  return { messageId: id, seq, ...(chatTitle ? { chatTitle } : {}) };
}

export function handleEditMessage(input: unknown): void {
  const parsed = editMessageSchema.parse(input);
  editMessage(parsed.messageId, parsed.content);
}

export function handleGetSetting(input: unknown): { value: unknown } {
  const parsed = getSettingSchema.parse(input);
  return { value: getSetting(parsed.key) ?? null };
}

export function handleSetSetting(input: unknown): void {
  const parsed = setSettingSchema.parse(input);
  setSetting(parsed.key, parsed.value);
}

/** Register all chat-persistence handlers. Safe to call once at app launch. */
export function registerChatHandlers(ipcMain: MinimalIpcMain, emitChat: (event: ChatTitleEvent) => void = () => undefined): void {
  const table: Record<string, (input: unknown) => unknown> = {
    [IPC_CHAT.CREATE_CHAT]: handleCreateChat,
    [IPC_CHAT.GET_CHAT_HISTORY]: handleGetChatHistory,
    [IPC_CHAT.ARCHIVE_CHAT]: handleArchiveChat,
    [IPC_CHAT.RENAME_CHAT]: input => {
      const parsed = renameChatSchema.parse(input);
      handleRenameChat(parsed);
      const chat = getChat(parsed.chatId)!;
      emitChat({ type: "chat_title_changed", chatId: chat.id, title: chat.title, revision: Number(chatMetadata(chat).titleRevision) });
    },
    [IPC_CHAT.GET_MESSAGES]: handleGetMessages,
    [IPC_CHAT.SEND_MESSAGE]: input => { const result = handleSendMessage(input); if (result.chatTitle) emitChat(result.chatTitle); return result; },
    [IPC_CHAT.EDIT_MESSAGE]: handleEditMessage,
    [IPC_CHAT.GET_SETTING]: handleGetSetting,
    [IPC_CHAT.SET_SETTING]: handleSetSetting,
  };
  for (const [channel, fn] of Object.entries(table)) {
    ipcMain.handle(channel, (_event, input) => fn(input));
  }
}

export function registerRunHandlers(ipcMain: MinimalIpcMain, manager: RunManager): void {
  ipcMain.handle(IPC_RUN.GET_SNAPSHOT, (_event, input) => manager.getRunSnapshot(getRunSnapshotSchema.parse(input)));
  ipcMain.handle(IPC_RUN.START_RUN, (_event, input) => manager.start(startRunSchema.parse(input)));
  ipcMain.handle(IPC_RUN.RESUME_RUN, (_event, input) => { const parsed = resumeRunSchema.parse(input); return manager.resume(parsed.runId, parsed.largerGenerationAllowance); });
  ipcMain.handle(IPC_RUN.SELECT_SOURCE_PAGES, (_event, input) => selectSourcePages(selectSourcePagesSchema.parse(input)));
  ipcMain.handle(IPC_RUN.CONFIRM, (_event, input) => manager.confirm(confirmActionSchema.parse(input)));
  ipcMain.handle(IPC_RUN.CANCEL, (_event, input) => manager.cancel(cancelRunSchema.parse(input).runId));
  ipcMain.handle(IPC_RUN.GET_ARTIFACT, (_event, input) => { const parsed = getArtifactSchema.parse(input); return manager.artifact(parsed.runId, parsed.artifactId); });
  ipcMain.handle(IPC_RUN.GET_VERIFICATION_REPORT, (_event, input) => manager.getVerificationReport(getVerificationReportSchema.parse(input).runId));
  ipcMain.handle(IPC_RUN.GET_HISTORY, (_event, input) => manager.history(getRunHistorySchema.parse(input ?? {}).limit));
  ipcMain.handle(IPC_RUN.REGISTER_ATTACHMENT, (_event, input) => manager.registerAttachment(registerAttachmentSchema.parse(input)));
  ipcMain.handle(IPC_RUN.GET_EXECUTION_CAPABILITIES, () => getExecutionCapabilities());
  ipcMain.handle(IPC_RUN.GET_HEALTH, () => manager.health());
  // openArtifact is Electron-main-only; registered in electron_app/electron/main.ts via manager.artifact + shell.
  // Kept here as a no-op so FakeIpcMain tests pass; real handler is installed by initBackend when running under Electron.
}

export function registerWorkspaceHandlers(ipcMain: MinimalIpcMain, harness: HarnessManager): void {
  let suggestions: AbortController | undefined;
  ipcMain.handle(IPC_WORKSPACE.SUGGEST_PATHS, async (_event, input) => {
    const parsed = workspaceSuggestSchema.parse(input);
    suggestions?.abort(); const controller = new AbortController(); suggestions = controller;
    const sameWorkspace = () => {
      const ws = harness.requireActiveWorkspace();
      if (ws.root !== parsed.root || ws.registeredAt !== parsed.registeredAt) throw new Error("Workspace changed. Select the source again.");
    };
    sameWorkspace();
    const result = await suggestWorkspacePaths(parsed.root, parsed.query, controller.signal);
    sameWorkspace(); return result;
  });
  ipcMain.handle(IPC_WORKSPACE.REGISTER, (_event, input) => {
    const parsed = registerWorkspaceSchema.parse(input);
    return harness.registerWorkspace(parsed.dirPath);
  });
  ipcMain.handle(IPC_WORKSPACE.DEREGISTER, () => {
    harness.deregisterWorkspace();
    return { ok: true };
  });
  ipcMain.handle(IPC_WORKSPACE.GET_CURRENT, () => {
    return harness.currentWorkspace();
  });
  ipcMain.handle(IPC_WORKSPACE.LIST_DIR, (_event, input) => {
    const parsed = harnessListDirSchema.parse(input ?? {});
    return harness.executeTool({ tool: "list_dir", args: parsed });
  });
  ipcMain.handle(IPC_WORKSPACE.READ_FILE, (_event, input) => {
    const parsed = harnessReadFileSchema.parse(input);
    return harness.executeTool({ tool: "read_file", args: parsed });
  });
  ipcMain.handle(IPC_WORKSPACE.SEARCH, (_event, input) => {
    const parsed = harnessSearchSchema.parse(input);
    return harness.executeTool({ tool: "search", args: parsed });
  });
  ipcMain.handle(IPC_WORKSPACE.WRITE_FILE, (_event, input) => {
    const parsed = harnessWriteFileSchema.parse(input);
    return harness.executeTool({ tool: "write_file", args: parsed });
  });
  ipcMain.handle(IPC_WORKSPACE.RUN_COMMAND, (_event, input) => {
    const parsed = harnessRunCommandSchema.parse(input);
    return harness.executeTool({ tool: "run_command", args: parsed });
  });
}

export { registerKnowledgeBaseHandlers } from "./kb-handlers.js";
export { registerOnboardingHandlers, restoreSavedModelConfig } from "./onboarding-handlers.js";
