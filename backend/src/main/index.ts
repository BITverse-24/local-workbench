// Backend main entry — launch wiring (backend/src/main/index.ts).
// Called once by the Electron main process after `app.whenReady()`:
//
//   import { initBackend } from "../../backend/src/main/index.js";
//   app.whenReady().then(() => { initBackend(ipcMain); createWindow(); });
//
// (Exact main.ts / preload / renderer edits are proposed in
// `electron_app/PROPOSALS.md` — that directory is owned by the frontend lane.)
// This module never imports `electron` itself: `ipcMain` is passed in and only the
// structural `MinimalIpcMain` surface is used, so this file is unit-testable and
// bundler-friendly. Full run-protocol wiring lands in Phase 1.

import { initDb } from "./persistence/db.js";
import { registerChatHandlers, type MinimalIpcMain } from "./ipc/handlers.js";

export { CHAT_CHANNELS, IPC_CHAT, type ChatChannel } from "./ipc/channels.js";
export { registerChatHandlers, type MinimalIpcMain } from "./ipc/handlers.js";

/** Open SQLite (idempotent migrate + seed) and register chat IPC handlers. */
export function initBackend(ipcMain: MinimalIpcMain): void {
  initDb();
  registerChatHandlers(ipcMain);
}
