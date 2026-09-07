/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}

// Backend chat-persistence bridge contract (Phase DB slice).
// Implemented in `electron/preload.ts`, served by backend/src/main/ipc/handlers.ts.
// Shape mirrors backend IPC_CHAT channels; run-protocol methods land in Phase 1.
interface ChatSummary {
  id: string
  title: string
  updated_at: string
}

interface PersistedMessage {
  id: string
  chat_id: string
  run_id: string | null
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  model_id: string | null
  created_at: string
  edited_at: string | null
  seq: number
}

interface WorkbenchBridge {
  createChat: (input?: { title?: string }) => Promise<{ chatId: string }>
  getChatHistory: (input?: { limit?: number }) => Promise<{ chats: ChatSummary[] }>
  archiveChat: (chatId: string) => Promise<void>
  getMessages: (chatId: string) => Promise<{ messages: PersistedMessage[] }>
  sendMessage: (chatId: string, role: 'user' | 'assistant', content: string) => Promise<{ messageId: string; seq: number }>
  editMessage: (messageId: string, content: string) => Promise<void>
  renameChat: (chatId: string, title: string) => Promise<void>
  getSetting: (key: string) => Promise<{ value: unknown }>
  setSetting: (key: string, value: unknown) => Promise<void>
}

// Used in Renderer process, expose in `preload.ts`
interface Window {
  ipcRenderer: import('electron').IpcRenderer
  /** Present only when running inside Electron with the preload bridge loaded. */
  workbench?: WorkbenchBridge
}
