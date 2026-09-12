# Proposals for Electron Main & Preload

## Proposal 1: Add native workspace folder picker dialog (COMPLETED)

- **Target:** `electron/main.ts`
- **Status:** **RESOLVED / IMPLEMENTED**.
- **Implementation:** Added `ipcMain.handle("workspace:pickFolder", ...)` invoking Electron native `dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })`.

## Proposal 2: Expose Workspace API on Preload Context Bridge (COMPLETED)

- **Target:** `electron/preload.ts`
- **Status:** **RESOLVED / IMPLEMENTED**.
- **Implementation:** Added typed workspace harness methods (`pickWorkspaceFolder`, `registerWorkspace`, `deregisterWorkspace`, `getCurrentWorkspace`, `listWorkspaceDir`, `readWorkspaceFile`, `searchWorkspace`, `writeWorkspaceFile`, `runWorkspaceCommand`, `onWorkspaceEvent`) to `window.workbench` in `preload.ts` and `bridge.d.ts`.
