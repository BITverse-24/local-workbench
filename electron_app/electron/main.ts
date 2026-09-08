import { app, BrowserWindow, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    // Model trace logs — expose full gateway traces to renderer for debugging.
    // Reads per-run logs written by backend/src/main/gateway/model-gateway.ts
    // (model-gateway.log JSONL + model-<taskType>-<requestId>.json). Renderer
    // gets structured-clone safe JSON; never leaks absolute paths or keys.
    ipcMain.handle("workbench:getRunLogs", async (_event, input) => {
      const raw = input as { runId?: string; limit?: number };
      const runId = raw?.runId;
      if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("runId required");
      const limit = Math.min(Math.max(raw.limit ?? 100, 1), 500);
      const { runRoot } = await import("../../backend/src/main/run/filesystem.js");
      // Verify run exists via runRoot guard (throws on bad id) and data dir
      const logsDir = path.join(runRoot(runId), "logs");
      if (!existsSync(logsDir)) return { runId, entries: [], files: [] as string[] };
      // List per-request json files
      let files: string[] = [];
      try {
        files = readdirSync(logsDir).filter((f) => f.startsWith("model-") && f.endsWith(".json")).slice(0, 50);
      } catch {
        files = [];
      }
      // Read JSONL audit trail
      const auditPath = path.join(logsDir, "model-gateway.log");
      let entries: unknown[] = [];
      try {
        if (existsSync(auditPath)) {
          const text = readFileSync(auditPath, "utf8");
          const lines = text.split("\n").filter(Boolean);
          const slice = lines.slice(-limit);
          entries = slice.map((line, idx) => {
            try { return JSON.parse(line); } catch { return { raw: line.slice(0, 4000), parseError: true, idx }; }
          });
        }
      } catch {
        entries = [];
      }
      // Also try to surface the most recent per-request full trace inline (largest payload)
      let recentFull: unknown = null;
      if (files.length) {
        const sorted = [...files].sort().reverse();
        const mostRecent = sorted[0];
        try {
          const fullText = readFileSync(path.join(logsDir, mostRecent), "utf8");
          recentFull = JSON.parse(fullText);
        } catch {
          recentFull = null;
        }
      }
      return { runId, entries, files, recentFull };
    });
    ipcMain.handle("workbench:getRunLogFile", async (_event, input) => {
      const raw = input as { runId?: string; filename?: string };
      if (!raw?.runId || !raw?.filename) throw new Error("runId and filename required");
      if (!/^[0-9a-f-]{36}$/i.test(raw.runId)) throw new Error("invalid runId");
      if (raw.filename.includes("/") || raw.filename.includes("\\") || raw.filename.includes("..")) throw new Error("invalid filename");
      if (!raw.filename.startsWith("model-") || !raw.filename.endsWith(".json")) throw new Error("invalid log filename");
      const { runRoot } = await import("../../backend/src/main/run/filesystem.js");
      const target = path.resolve(path.join(runRoot(raw.runId), "logs", raw.filename));
      const root = path.resolve(runRoot(raw.runId));
      if (!target.startsWith(root + path.sep)) throw new Error("path escapes run");
      if (!existsSync(target)) throw new Error("log file not found");
      const text = readFileSync(target, "utf8");
      // Cap at 1MB JSON for IPC
      const capped = text.length > 1024 * 1024 ? text.slice(0, 1024 * 1024) : text;
      return { runId: raw.runId, filename: raw.filename, content: JSON.parse(capped) };
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
