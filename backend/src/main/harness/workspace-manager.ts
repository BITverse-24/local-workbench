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
    return this.active;
  }

  isRegistered(): boolean {
    return this.active !== null;
  }

  requireActive(): WorkspaceInfo {
    if (!this.active) {
      throw new Error("no workspace is registered — select a directory first");
    }
    // Registration binds the physical root. A later symlink must not redirect
    // existing authority to another directory with the same displayed path.
    try {
      if (realpathSync(this.active.root) !== this.active.root || !statSync(this.active.root).isDirectory()) {
        throw new Error("workspace root changed");
      }
    } catch {
      throw new Error("workspace binding changed — register the directory again");
    }
    return this.active;
  }

  deregister(): void {
    this.active = null;
    try {
      setSetting("active_workspace_root", null);
    } catch {}
  }

  restoreWorkspace(): WorkspaceInfo | null {
    if (this.active) return this.active;
    try {
      const saved = getSetting<string>("active_workspace_root");
      if (saved && typeof saved === "string" && existsSync(saved) && statSync(saved).isDirectory()) {
        this.active = {
          root: realpathSync(saved),
          registeredAt: new Date().toISOString(),
        };
        return this.active;
      }
    } catch {}
    return null;
  }
}
