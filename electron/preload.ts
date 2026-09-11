import { contextBridge, ipcRenderer } from "electron";

// Window Controls
contextBridge.exposeInMainWorld("electronAPI", {
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
});

// Typed workbench bridge — no wildcard ipcRenderer exposure.
// All run/protocol methods go through structured-clone IPC; attachments
// are transferred as base64 strings, never as absolute paths.
contextBridge.exposeInMainWorld("workbench", {
  // chat persistence
  createChat: (input?: { title?: string }) =>
    ipcRenderer.invoke("workbench:createChat", input ?? {}),
  getChatHistory: (input?: { limit?: number }) =>
    ipcRenderer.invoke("workbench:getChatHistory", input ?? {}),
  archiveChat: (chatId: string) =>
    ipcRenderer.invoke("workbench:archiveChat", { chatId }),
  getMessages: (chatId: string) =>
    ipcRenderer.invoke("workbench:getMessages", { chatId }),
  sendMessage: (chatId: string, role: "user" | "assistant", content: string) =>
    ipcRenderer.invoke("workbench:sendMessage", { chatId, role, content }),
  editMessage: (messageId: string, content: string) =>
    ipcRenderer.invoke("workbench:editMessage", { messageId, content }),
  renameChat: (chatId: string, title: string) =>
    ipcRenderer.invoke("workbench:renameChat", { chatId, title }),
  getSetting: (key: string) =>
    ipcRenderer.invoke("workbench:getSetting", { key }),
  setSetting: (key: string, value: unknown) =>
    ipcRenderer.invoke("workbench:setSetting", { key, value }),

  // run protocol
  startRun: (input: { userText: string; attachmentToken?: string; runId?: string; chatId?: string; temperature?: number }) =>
    ipcRenderer.invoke("workbench:startRun", input),
  registerAttachment: (input: {
    chatId?: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    base64OrBuffer: string;
  }) => ipcRenderer.invoke("workbench:registerAttachment", input),
  confirmAction: (input: { runId: string; actionId: string; approved: boolean }) =>
    ipcRenderer.invoke("workbench:confirmAction", input),
  cancelRun: (input: { runId: string }) =>
    ipcRenderer.invoke("workbench:cancelRun", input),
  getRunHistory: (input?: { limit?: number }) =>
    ipcRenderer.invoke("workbench:getRunHistory", input ?? {}),
  getArtifact: (input: { runId: string; artifactId: string }) =>
    ipcRenderer.invoke("workbench:getArtifact", input),
  openArtifact: (input: { runId: string; artifactId: string }) =>
    ipcRenderer.invoke("workbench:openArtifact", input),
  saveArtifact: (input: { runId: string; artifactId: string }) =>
    ipcRenderer.invoke("workbench:saveArtifact", input),
  getHealth: () =>
    ipcRenderer.invoke("workbench:getHealth"),
  getRunLogs: (input: { runId: string; limit?: number }) =>
    ipcRenderer.invoke("workbench:getRunLogs", input),
  getRunLogFile: (input: { runId: string; filename: string }) =>
    ipcRenderer.invoke("workbench:getRunLogFile", input),

  // workspace harness protocol
  pickWorkspaceFolder: () =>
    ipcRenderer.invoke("workspace:pickFolder"),
  registerWorkspace: (dirPath: string) =>
    ipcRenderer.invoke("workspace:register", { dirPath }),
  deregisterWorkspace: () =>
    ipcRenderer.invoke("workspace:deregister"),
  getCurrentWorkspace: () =>
    ipcRenderer.invoke("workspace:getCurrent"),
  listWorkspaceDir: (path?: string) =>
    ipcRenderer.invoke("workspace:listDir", { path }),
  readWorkspaceFile: (path: string) =>
    ipcRenderer.invoke("workspace:readFile", { path }),
  searchWorkspace: (query: string, path?: string) =>
    ipcRenderer.invoke("workspace:search", { query, path }),
  writeWorkspaceFile: (path: string, content: string) =>
    ipcRenderer.invoke("workspace:writeFile", { path, content }),
  runWorkspaceCommand: (command: string) =>
    ipcRenderer.invoke("workspace:runCommand", { command }),

  // push events — returns unsubscribe
  onRunEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, data: unknown) => listener(data);
    ipcRenderer.on("workbench:runEvent", wrapped);
    return () => ipcRenderer.removeListener("workbench:runEvent", wrapped);
  },
  onWorkspaceEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, data: unknown) => listener(data);
    ipcRenderer.on("workspace:event", wrapped);
    return () => ipcRenderer.removeListener("workspace:event", wrapped);
  },
});
