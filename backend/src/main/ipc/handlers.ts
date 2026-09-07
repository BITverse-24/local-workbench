// Chat-persistence IPC handlers (backend/src/main/ipc/handlers.ts).
// Phase-DB connection slice: real `ipcMain.handle` registration for the 9 channels in
// `./channels.ts`. Pure handler functions (no `electron` import) + `registerChatHandlers`
// which takes a minimal structural ipcMain — the real Electron `ipcMain` satisfies it,
// and tests pass a fake. Run-protocol handlers (startRun/confirm/…) land in Phase 1.
//
// Errors (incl. Zod validation failures) propagate as invoke rejections; the renderer
// must try/catch. All returns are structured-clone / JSON-safe.

import { archiveChat, createChat, listChats, renameChat } from "../persistence/chats.js";
import { addMessage, editMessage, listMessages, type Message } from "../persistence/messages.js";
import { getSetting, setSetting } from "../persistence/settings-store.js";
import { IPC_CHAT } from "./channels.js";
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
} from "./validators.js";

/** Structural subset of Electron's ipcMain needed here (keeps backend testable w/o electron). */
export interface MinimalIpcMain {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>,
  ): void;
}

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

export function handleSendMessage(input: unknown): { messageId: string; seq: number } {
  const parsed = sendMessageSchema.parse(input);
  const { id, seq } = addMessage({
    chat_id: parsed.chatId,
    role: parsed.role,
    content: parsed.content,
  });
  return { messageId: id, seq };
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
export function registerChatHandlers(ipcMain: MinimalIpcMain): void {
  const table: Record<string, (input: unknown) => unknown> = {
    [IPC_CHAT.CREATE_CHAT]: handleCreateChat,
    [IPC_CHAT.GET_CHAT_HISTORY]: handleGetChatHistory,
    [IPC_CHAT.ARCHIVE_CHAT]: handleArchiveChat,
    [IPC_CHAT.RENAME_CHAT]: handleRenameChat,
    [IPC_CHAT.GET_MESSAGES]: handleGetMessages,
    [IPC_CHAT.SEND_MESSAGE]: handleSendMessage,
    [IPC_CHAT.EDIT_MESSAGE]: handleEditMessage,
    [IPC_CHAT.GET_SETTING]: handleGetSetting,
    [IPC_CHAT.SET_SETTING]: handleSetSetting,
  };
  for (const [channel, fn] of Object.entries(table)) {
    ipcMain.handle(channel, (_event, input) => fn(input));
  }
}
