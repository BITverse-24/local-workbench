# Proposals for Electron Main & Preload

## Proposal 1: Add native workspace folder picker dialog

- **Target:** `electron/main.ts`
- **Issue:** Users need a native desktop folder picker to select a local workspace directory without manually typing filesystem paths.
- **Evidence:** The harness backend provides `workspace:register`, but there is currently no IPC handler invoking Electron's native `dialog.showOpenDialog({ properties: ["openDirectory"] })`.
- **Suggested change:**
  Add the following IPC handler in `electron/main.ts` inside `app.whenReady()`:
  ```typescript
  ipcMain.handle("workspace:pickFolder", async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      title: "Select Project Workspace",
      buttonLabel: "Select Folder",
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });
  ```
- **Reason:** Electron main process holds privileged access to native OS file dialogs; the renderer cannot directly spawn file system picker dialogs under context isolation.
- **Impact:** Adds one non-breaking IPC handler for folder selection.

## Proposal 2: Expose Workspace API on Preload Context Bridge

- **Target:** `electron/preload.ts`
- **Issue:** The React renderer cannot invoke `workspace:*` IPC channels or receive `workspace:event` push events because they are not yet exposed on `window.workbench`.
- **Evidence:** `electron/preload.ts` defines `workbench` exposing only chat and run channels.
- **Suggested change:**
  Add workspace methods to the `workbench` object in `electron/preload.ts`:
  ```typescript
  // Workspace harness APIs
  pickWorkspaceFolder: () => ipcRenderer.invoke("workspace:pickFolder"),
  registerWorkspace: (dirPath: string) => ipcRenderer.invoke("workspace:register", { dirPath }),
  deregisterWorkspace: () => ipcRenderer.invoke("workspace:deregister"),
  getCurrentWorkspace: () => ipcRenderer.invoke("workspace:getCurrent"),
  listWorkspaceDir: (path?: string) => ipcRenderer.invoke("workspace:listDir", { path }),
  readWorkspaceFile: (path: string) => ipcRenderer.invoke("workspace:readFile", { path }),
  searchWorkspace: (query: string, path?: string) => ipcRenderer.invoke("workspace:search", { query, path }),
  writeWorkspaceFile: (path: string, content: string) => ipcRenderer.invoke("workspace:writeFile", { path, content }),
  runWorkspaceCommand: (command: string) => ipcRenderer.invoke("workspace:runCommand", { command }),
  onWorkspaceEvent: (listener: (event: any) => void) => {
    const handler = (_event: any, data: any) => listener(data);
    ipcRenderer.on("workspace:event", handler);
    return () => {
      ipcRenderer.removeListener("workspace:event", handler);
    };
  },
  ```
- **Reason:** Context isolation in Electron blocks arbitrary IPC from the renderer, requiring explicit method exposure through `contextBridge`.
- **Impact:** Exposes typed harness methods to the renderer without bypassing security boundaries or leaking absolute paths.
