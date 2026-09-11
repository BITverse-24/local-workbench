import path from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { getSetting, setSetting } from "../persistence/settings-store.js";

export interface WorkspaceInfo {
  root: string;         // Canonical absolute path
  registeredAt: string; // ISO-8601 timestamp
}

/**
 * One workspace at a time per session (HARNESS.md §1).
 * Validates and canonicalizes the directory path once (HARNESS.md §3).
 * Persists active workspace path in SQLite settings so it survives app reloads.
 */
export class WorkspaceManager {
  private active: WorkspaceInfo | null = null;

  constructor() {
    this.hydrateFromSettings();
  }

  private hydrateFromSettings(): void {
    try {
      const saved = getSetting<string>("active_workspace_root");
      if (saved && typeof saved === "string" && existsSync(saved) && statSync(saved).isDirectory()) {
        this.active = {
          root: realpathSync(saved),
          registeredAt: new Date().toISOString(),
        };
      }
    } catch {
      // Database may not be initialized yet in early startup or isolated unit tests
    }
  }

  register(dirPath: string): WorkspaceInfo {
    if (!dirPath || typeof dirPath !== "string") {
      throw new Error("directory path must be a non-empty string");
    }

    const resolved = path.resolve(dirPath);
    if (!existsSync(resolved)) {
      throw new Error(`directory does not exist: ${dirPath}`);
    }

    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`not a directory: ${dirPath}`);
    }

    const canonical = realpathSync(resolved);
    this.active = {
      root: canonical,
      registeredAt: new Date().toISOString(),
    };
    try {
      setSetting("active_workspace_root", canonical);
    } catch {}
    return this.active;
  }

  current(): WorkspaceInfo | null {
    if (!this.active) {
      this.hydrateFromSettings();
    }
    return this.active;
  }

  isRegistered(): boolean {
    return this.current() !== null;
  }

  requireActive(): WorkspaceInfo {
    const current = this.current();
    if (!current) {
      throw new Error("no workspace is registered — select a directory first");
    }
    return current;
  }

  deregister(): void {
    this.active = null;
    try {
      setSetting("active_workspace_root", null);
    } catch {}
  }
}
