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
  GET_SNAPSHOT: "workbench:getRunSnapshot",
  START_RUN: "workbench:startRun",
  RESUME_RUN: "workbench:resumeRun",
  SELECT_SOURCE_PAGES: "workbench:selectSourcePages",
  CONFIRM: "workbench:confirmAction",
  CANCEL: "workbench:cancelRun",
  GET_ARTIFACT: "workbench:getArtifact",
  GET_VERIFICATION_REPORT: "workbench:getVerificationReport",
  GET_HISTORY: "workbench:getRunHistory",
  REGISTER_ATTACHMENT: "workbench:registerAttachment",
  GET_EXECUTION_CAPABILITIES: "workbench:getExecutionCapabilities",
  GET_HEALTH: "workbench:getHealth",
  RUN_EVENT: "workbench:runEvent",
  OPEN_ARTIFACT: "workbench:openArtifact",
  SAVE_ARTIFACT: "workbench:saveArtifact",
} as const;

export type ChatChannel = (typeof IPC_CHAT)[keyof typeof IPC_CHAT];

export const CHAT_CHANNELS: readonly string[] = Object.values(IPC_CHAT);
export const RUN_CHANNELS: readonly string[] = Object.values(IPC_RUN);

export const IPC_WORKSPACE = {
  REGISTER: "workspace:register",
  DEREGISTER: "workspace:deregister",
  GET_CURRENT: "workspace:getCurrent",
  LIST_DIR: "workspace:listDir",
  SUGGEST_PATHS: "workspace:suggestPaths",
  READ_FILE: "workspace:readFile",
  SEARCH: "workspace:search",
  WRITE_FILE: "workspace:writeFile",
  RUN_COMMAND: "workspace:runCommand",
  WORKSPACE_EVENT: "workspace:event",
} as const;

export type WorkspaceChannel = (typeof IPC_WORKSPACE)[keyof typeof IPC_WORKSPACE];

export const WORKSPACE_CHANNELS: readonly string[] = Object.values(IPC_WORKSPACE);

export const IPC_KB = {
  LIST_DOCS: "kb:listDocs",
  INGEST_DOC: "kb:ingestDoc",
  DELETE_DOC: "kb:deleteDoc",
  REINDEX: "kb:reindex",
  QUERY: "kb:query",
  STATS: "kb:stats",
} as const;

export type KBChannel = (typeof IPC_KB)[keyof typeof IPC_KB];

export const KB_CHANNELS: readonly string[] = Object.values(IPC_KB);

export const IPC_ONBOARDING = {
  GET_STATUS: "workbench:getOnboardingStatus",
  SAVE_CONFIG: "workbench:saveModelConfig",
  TEST_ENDPOINT: "workbench:testModelEndpoint",
  RESET: "workbench:resetOnboarding",
} as const;

export type OnboardingChannel = (typeof IPC_ONBOARDING)[keyof typeof IPC_ONBOARDING];

export const ONBOARDING_CHANNELS: readonly string[] = Object.values(IPC_ONBOARDING);
