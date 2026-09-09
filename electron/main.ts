import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { initBackend } from "../backend/src/main/index.js";
import { IPC_RUN } from "../backend/src/main/ipc/channels.js";

// Electron is the privileged desktop shell. It owns: app lifecycle,
// BrowserWindow, the development Vite child process, packaged frontend
// loading, preload IPC adapters, and safe shell operations. It must not own
// model routing, prompts, persistence queries, run transitions, tool policy,
// Python policy, or any other business rule (those live in /backend).

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FRONTEND_DEV_URL =
  process.env.WORKBENCH_FRONTEND_URL ||
  process.env.VITE_DEV_SERVER_URL ||
  "http://127.0.0.1:5173/";
const FRONTEND_READY_TIMEOUT_MS = 120000;

let win: BrowserWindow | null = null;
let viteChild: ChildProcess | null = null;

// Minimal .env loader for development only. Reads a single file
// (WORKBENCH_ENV_PATH or <repo>/.env), never overwrites set variables,
// never logs values. No .env file is ever packaged.
function loadDevEnv(): void {
  if (app.isPackaged) return;
  const file = process.env.WORKBENCH_ENV_PATH ?? path.join(REPO_ROOT, ".env");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(body);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined || process.env[match[1]] === "") {
      process.env[match[1]] = value;
    }
  }
}

async function waitForFrontend(url: string): Promise<void> {
  const deadline = Date.now() + FRONTEND_READY_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`frontend not ready at ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function startVite(): void {
  const bin = process.platform === "win32" ? "vite.cmd" : "vite";
  const viteBin = path.join(REPO_ROOT, "node_modules", ".bin", bin);
  if (!existsSync(viteBin)) {
    throw new Error(`vite binary not found at ${viteBin} (run npm install from the repo root)`);
  }
  viteChild = spawn(viteBin, ["--config", "frontend/vite.config.ts"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  viteChild.on("exit", (code, signal) => {
    viteChild = null;
    if (win && !win.isDestroyed()) {
      console.error(`[electron] vite exited (code=${code} signal=${signal})`);
    }
  });
}

function stopVite(): void {
  if (viteChild && !viteChild.killed) viteChild.kill();
  viteChild = null;
}

function frontendPublicDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "frontend", "dist");
  }
  return path.join(REPO_ROOT, "frontend", "public");
}

function createWindow(): void {
  win = new BrowserWindow({
    title: "Sovereign Workbench",
    icon: path.join(frontendPublicDir(), "electron-vite.svg"),
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

  if (app.isPackaged) {
    void win.loadFile(path.join(process.resourcesPath, "frontend", "dist", "index.html"));
  } else {
    void win.loadURL(FRONTEND_DEV_URL);
  }
}

app.on("window-all-closed", () => {
  stopVite();
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("before-quit", () => {
  stopVite();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(async () => {
  loadDevEnv();

  let manager: ReturnType<typeof initBackend> | null = null;
  try {
    manager = initBackend(ipcMain, (event) => {
      if (win && !win.isDestroyed()) win.webContents.send("workbench:runEvent", event);
    }, {
      dataDir: app.isPackaged
        ? path.join(app.getPath("userData"), "data")
        : path.join(REPO_ROOT, "data"),
      modelsPath: process.env.WORKBENCH_MODELS_PATH ??
        (app.isPackaged
          ? path.join(process.resourcesPath, "config", "models.json")
          : path.join(REPO_ROOT, "config", "models.json")),
      schemaPath: app.isPackaged
        ? path.join(process.resourcesPath, "backend", "schema.sql")
        : path.join(REPO_ROOT, "backend", "src", "main", "persistence", "schema.sql"),
    });

    // Model trace logs — expose full gateway traces to renderer for debugging.
    // Reads per-run logs written by the backend gateway (model-gateway.log JSONL
    // + model-<taskType>-<requestId>.json). Renderer gets structured-clone safe
    // JSON; never leaks absolute paths or keys.
    ipcMain.handle("workbench:getRunLogs", async (_event, input) => {
      const raw = input as { runId?: string; limit?: number };
      const runId = raw?.runId;
      if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("runId required");
      const limit = Math.min(Math.max(raw.limit ?? 100, 1), 500);
      const { runRoot } = await import("../backend/src/main/run/filesystem.js");
      const logsDir = path.join(runRoot(runId), "logs");
      if (!existsSync(logsDir)) return { runId, entries: [], files: [] as string[] };
      let files: string[] = [];
      try {
        files = readdirSync(logsDir).filter((f) => f.startsWith("model-") && f.endsWith(".json")).slice(0, 50);
      } catch {
        files = [];
      }
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
      const { runRoot } = await import("../backend/src/main/run/filesystem.js");
      const target = path.resolve(path.join(runRoot(raw.runId), "logs", raw.filename));
      const root = path.resolve(runRoot(raw.runId));
      if (!target.startsWith(root + path.sep)) throw new Error("path escapes run");
      if (!existsSync(target)) throw new Error("log file not found");
      const text = readFileSync(target, "utf8");
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
      const { absoluteDataPath } = await import("../backend/src/main/run/filesystem.js");
      const abs = absoluteDataPath(ref.relativePath);
      const result = await shell.openPath(abs);
      if (result) throw new Error(result);
      return { opened: true as const, filename: ref.filename };
    });
  } catch (err) {
    console.error("[backend] initBackend failed:", err);
  }

  if (!app.isPackaged) {
    try {
      startVite();
      await waitForFrontend(FRONTEND_DEV_URL);
    } catch (err) {
      console.error("[electron] frontend startup failed:", err);
      stopVite();
      app.quit();
      return;
    }
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
