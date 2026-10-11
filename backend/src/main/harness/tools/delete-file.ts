import {
  copyFileSync,
  cpSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { resolveSafe } from "../path-guard.js";
import { backupDestination } from "./backup.js";
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
  const backup = backupDestination(canonicalRoot, path.relative(canonicalRoot, target));
  const backupDest = backup.destination;

  if (stat.isDirectory()) {
    cpSync(target, backupDest, { recursive: true });
    backedUp = true;
    backupPath = backup.relativePath;
    rmSync(target, { recursive: true, force: true });
  } else {
    copyFileSync(target, backupDest);
    backedUp = true;
    backupPath = backup.relativePath;
    rmSync(target, { force: true });
  }

  clearListDirCache();

  return {
    deleted: relativePath,
    backedUp,
    backupPath,
  };
}
