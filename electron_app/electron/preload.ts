import { ipcRenderer, contextBridge } from 'electron'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },

  // You can expose other APTs you need here.
  // ...
})

// --------- Window Controls ---------
contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
})

// --------- Backend chat-persistence bridge (Phase DB slice) ---------
// Channel strings mirror backend/src/main/ipc/channels.ts (IPC_CHAT) exactly.
// Chat persistence only: create/history/archive/messages/edit/settings.
// Run-protocol methods (startRun/confirm/…) arrive with Phase 1 — do not add them here.
// NOTE: the wildcard `ipcRenderer` expose above stays until Phase 1 removes it.
contextBridge.exposeInMainWorld('workbench', {
  createChat: (input?: { title?: string }) =>
    ipcRenderer.invoke('workbench:createChat', input ?? {}),
  getChatHistory: (input?: { limit?: number }) =>
    ipcRenderer.invoke('workbench:getChatHistory', input ?? {}),
  archiveChat: (chatId: string) =>
    ipcRenderer.invoke('workbench:archiveChat', { chatId }),
  getMessages: (chatId: string) =>
    ipcRenderer.invoke('workbench:getMessages', { chatId }),
  sendMessage: (chatId: string, role: 'user' | 'assistant', content: string) =>
    ipcRenderer.invoke('workbench:sendMessage', { chatId, role, content }),
  editMessage: (messageId: string, content: string) =>
    ipcRenderer.invoke('workbench:editMessage', { messageId, content }),
  renameChat: (chatId: string, title: string) =>
    ipcRenderer.invoke('workbench:renameChat', { chatId, title }),
  getSetting: (key: string) =>
    ipcRenderer.invoke('workbench:getSetting', { key }),
  setSetting: (key: string, value: unknown) =>
    ipcRenderer.invoke('workbench:setSetting', { key, value }),
})
