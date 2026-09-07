// Chat-persistence IPC channels (backend/src/main/ipc/channels.ts).
// `workbench:` prefix matches BACKEND_PLANS.md §8. These 9 chat-scoped channels are the
// Phase-DB connection slice; run-protocol channels (startRun/confirmAction/cancelRun/
// getArtifact/getRunHistory/registerAttachment/getHealth/runEvent) land in Phase 1 (TASKS.md 1.2)
// and must not collide with these names.

export const IPC_CHAT = {
  CREATE_CHAT: "workbench:createChat",
  GET_CHAT_HISTORY: "workbench:getChatHistory",
  ARCHIVE_CHAT: "workbench:archiveChat",
  RENAME_CHAT: "workbench:renameChat",
  GET_MESSAGES: "workbench:getMessages",
  SEND_MESSAGE: "workbench:sendMessage",
  EDIT_MESSAGE: "workbench:editMessage",
  GET_SETTING: "workbench:getSetting",
  SET_SETTING: "workbench:setSetting",
} as const;

export type ChatChannel = (typeof IPC_CHAT)[keyof typeof IPC_CHAT];

export const CHAT_CHANNELS: readonly string[] = Object.values(IPC_CHAT);
