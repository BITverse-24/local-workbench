import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { resolveSafe } from "../path-guard.js";
import { clearListDirCache } from "./list-dir.js";

export interface DeleteResult {
  deleted: string;
  backedUp: boolean;
  backupPath?: string;
}

/**
 * Delete a file or directory with copy-on-write backup.
 * Before deleting, copies to .harness_backups/<timestamp>/<relative_path>.
 */
export function deleteFile(
  workspaceRoot: string,
  relativePath: string,
): DeleteResult {
  const target = resolveSafe(workspaceRoot, relativePath);
  const canonicalRoot = resolveSafe(workspaceRoot, ".");

  if (target === canonicalRoot) {
    throw new Error("Cannot delete workspace root directory");
  }

  if (!existsSync(target)) {
    throw new Error(`File or directory does not exist: ${relativePath}`);
  }

  let backedUp = false;
  let backupPath: string | undefined;

  const stat = statSync(target);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const relFromRoot = path.relative(canonicalRoot, target);

  const backupDir = path.join(canonicalRoot, ".harness_backups", timestamp);
  const backupDest = path.join(backupDir, relFromRoot);

  mkdirSync(path.dirname(backupDest), { recursive: true });

  if (stat.isDirectory()) {
    cpSync(target, backupDest, { recursive: true });
    backedUp = true;
    backupPath = path.join(".harness_backups", timestamp, relFromRoot);
    rmSync(target, { recursive: true, force: true });
  } else {
    copyFileSync(target, backupDest);
    backedUp = true;
    backupPath = path.join(".harness_backups", timestamp, relFromRoot);
    rmSync(target, { force: true });
  }

  clearListDirCache();

  return {
    deleted: relativePath,
    backedUp,
    backupPath,
  };
}
