import { app, BrowserWindow, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { initBackend } from "../../backend/src/main/index.js";
import { IPC_RUN } from "../../backend/src/main/ipc/channels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, "..");

// Use ['"'"'ENV_NAME'"'"'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, "public") : RENDERER_DIST;

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    title: "agent fr",
    icon: path.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    frame: false,
    width: 1200,
    height: 720,
    minWidth: 1200,
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("main-process-message", new Date().toLocaleString());
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(() => {
  let manager: ReturnType<typeof initBackend> | null = null;
  try {
    if (!process.env.WORKBENCH_DB_PATH) {
      process.env.WORKBENCH_DB_PATH = app.isPackaged
        ? path.join(app.getPath("userData"), "workbench.db")
        : path.join(process.env.APP_ROOT, "..", "backend", "data", "workbench.db");
    }
    manager = initBackend(ipcMain, (event) => {
      if (win && !win.isDestroyed()) win.webContents.send("workbench:runEvent", event);
    });
    // Artifact open — main-process shell integration with run-scope guard.
    // The renderer never receives absolute paths; main resolves via the backend
    // run-scope guard and opens with Electron shell.
    ipcMain.handle(IPC_RUN.OPEN_ARTIFACT, async (_event, input) => {
      const raw = input as { runId?: string; artifactId?: string };
      if (!raw?.runId || !raw?.artifactId) throw new Error("runId and artifactId required");
      if (!manager) throw new Error("backend not initialized");
      const ref = manager.artifact(raw.runId, raw.artifactId) as { relativePath: string; filename: string };
      const { absoluteDataPath } = await import("../../backend/src/main/run/filesystem.js");
      const abs = absoluteDataPath(ref.relativePath);
      const result = await shell.openPath(abs);
      if (result) throw new Error(result);
      return { opened: true as const, filename: ref.filename };
    });
  } catch (err) {
    console.error("[backend] initBackend failed:", err);
  }
  createWindow();
});

ipcMain.on("window-minimize", () => {
  win?.minimize();
});

ipcMain.on("window-maximize", () => {
  if (win?.isMaximized()) {
    win.unmaximize();
  } else {
    win?.maximize();
  }
});

ipcMain.on("window-close", () => {
  win?.close();
});
