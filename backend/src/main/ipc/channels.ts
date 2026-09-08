// Chat-persistence IPC channels (backend/src/main/ipc/channels.ts).
// `workbench:` prefix matches BACKEND_PLANS.md §8. Chat persistence and run-protocol
// channels share this namespace; RUN_EVENT is push-only and is not registered with
// ipcMain.handle.

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

export const IPC_RUN = {
  START_RUN: "workbench:startRun",
  CONFIRM: "workbench:confirmAction",
  CANCEL: "workbench:cancelRun",
  GET_ARTIFACT: "workbench:getArtifact",
  GET_HISTORY: "workbench:getRunHistory",
  REGISTER_ATTACHMENT: "workbench:registerAttachment",
  GET_HEALTH: "workbench:getHealth",
  RUN_EVENT: "workbench:runEvent",
} as const;

export type ChatChannel = (typeof IPC_CHAT)[keyof typeof IPC_CHAT];

export const CHAT_CHANNELS: readonly string[] = Object.values(IPC_CHAT);
export const RUN_CHANNELS: readonly string[] = Object.values(IPC_RUN);
