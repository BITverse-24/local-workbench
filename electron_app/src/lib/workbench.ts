// Renderer-side client for the backend chat-persistence bridge (Phase DB slice).
// Uses `window.workbench` when the Electron preload is loaded; otherwise every call
// throws WorkbenchUnavailable, and callers (App.tsx) fall back to in-memory state so
// plain `vite` web dev keeps working without Electron.
//
// Contract types (ChatSummary, PersistedMessage, WorkbenchBridge) are global via
// electron/electron-env.d.ts — no import needed.

export class WorkbenchUnavailable extends Error {
  constructor() {
    super('workbench bridge unavailable (not running inside Electron)');
    this.name = 'WorkbenchUnavailable';
  }
}

export function isWorkbenchAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.workbench;
}

function bridge(): WorkbenchBridge {
  if (!isWorkbenchAvailable() || !window.workbench) throw new WorkbenchUnavailable();
  return window.workbench;
}

export async function createChat(title?: string): Promise<string> {
  const { chatId } = await bridge().createChat(title ? { title } : {});
  return chatId;
}

export async function getChatHistory(limit = 50): Promise<ChatSummary[]> {
  const { chats } = await bridge().getChatHistory({ limit });
  return chats;
}

export async function archiveChat(chatId: string): Promise<void> {
  await bridge().archiveChat(chatId);
}

export async function getMessages(chatId: string): Promise<PersistedMessage[]> {
  const { messages } = await bridge().getMessages(chatId);
  return messages;
}

export async function sendMessage(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<{ messageId: string; seq: number }> {
  return bridge().sendMessage(chatId, role, content);
}

export async function editPersistedMessage(messageId: string, content: string): Promise<void> {
  await bridge().editMessage(messageId, content);
}

export async function renameChat(chatId: string, title: string): Promise<void> {
  await bridge().renameChat(chatId, title);
}

export async function getSetting<T>(key: string): Promise<T | null> {
  const { value } = await bridge().getSetting(key);
  return (value ?? null) as T | null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await bridge().setSetting(key, value);
}
