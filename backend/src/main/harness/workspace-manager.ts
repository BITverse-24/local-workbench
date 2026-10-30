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
  private lastRegistrationMs = 0;

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
    let savedRegistrationMs=0;
    try {savedRegistrationMs=Date.parse(getSetting<WorkspaceInfo>("active_workspace_identity")?.registeredAt ?? "") || 0;} catch {}
    this.lastRegistrationMs=Math.max(Date.now(),this.lastRegistrationMs+1,savedRegistrationMs+1);
    this.active = {
      root: canonical,
      registeredAt: new Date(this.lastRegistrationMs).toISOString(),
    };
    try {
      setSetting("active_workspace_root", canonical);
      setSetting("active_workspace_identity", this.active);
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
      setSetting("active_workspace_identity", null);
    } catch {}
  }

  restoreWorkspace(): WorkspaceInfo | null {
    if (this.active) return this.active;
    try {
      const saved = getSetting<string>("active_workspace_root");
      if (saved && typeof saved === "string" && existsSync(saved) && statSync(saved).isDirectory()) {
        const canonical=realpathSync(saved);
        const identity=getSetting<WorkspaceInfo>("active_workspace_identity");
        // Restart restores identity, never approvals. Explicit registration
        // creates a new identity even when the displayed path is unchanged.
        this.active = identity && identity.root === canonical && typeof identity.registeredAt === "string" && Number.isFinite(Date.parse(identity.registeredAt))
          ? {root:canonical,registeredAt:identity.registeredAt}
          : {root:canonical,registeredAt:new Date().toISOString()};
        this.lastRegistrationMs=Date.parse(this.active.registeredAt);
        return this.active;
      }
    } catch {}
    return null;
  }
}
