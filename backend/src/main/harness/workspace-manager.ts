import path from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";

export interface WorkspaceInfo {
  root: string;         // Canonical absolute path
  registeredAt: string; // ISO-8601 timestamp
}

/**
 * One workspace at a time per session (HARNESS.md §1).
 * Validates and canonicalizes the directory path once (HARNESS.md §3).
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
    return this.active;
  }

  deregister(): void {
    this.active = null;
  }
}
