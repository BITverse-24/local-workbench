import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveSafe } from "../path-guard.js";
import { backupDestination } from "./backup.js";
import { clearListDirCache } from "./list-dir.js";

export interface WriteResult {
  written: string;
  backedUp: boolean;
  backupPath?: string;
  diff?: string;
}

/**
 * Write file with copy-on-write backup (HARNESS.md §5, §3).
 * Before overwriting, copies to .harness_backups/<timestamp>/<relative_path>.
 * Returns a diff summary.
 */
export function writeFile(
  workspaceRoot: string,
  relativePath: string,
  content: string | Buffer,
): WriteResult {
  const target = resolveSafe(workspaceRoot, relativePath);
  let backedUp = false;
  let backupPath: string | undefined;
  let previousContent: string | undefined;

  // Backup existing file before overwrite (HARNESS.md §5)
  if (existsSync(target)) {
    if (typeof content === "string") previousContent = readFileSync(target, "utf8");
    const canonicalRoot = resolveSafe(workspaceRoot, ".");
    const backup = backupDestination(canonicalRoot, path.relative(canonicalRoot, target));
    copyFileSync(target, backup.destination);
    backedUp = true;
    backupPath = backup.relativePath;
  }

  // Ensure parent directory exists before writing
  const parentDir = path.dirname(target);
  mkdirSync(parentDir, { recursive: true });

  // Atomic write via temporary file to prevent partial file corruption
  const tmpTarget = `${target}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmpTarget, content, "utf8");
    renameSync(tmpTarget, target);
  } catch (error) {
    if (existsSync(tmpTarget)) {
      try {
        rmSync(tmpTarget, { force: true });
      } catch {}
    }
    throw error;
  }

  // Invalidate listDir cache so subsequent directory queries reflect the written file immediately
  clearListDirCache();

  // Generate a clear diff summary
  let diff: string;
  const newLines = typeof content === "string" ? content.split(/\r?\n/).length : 0;
  if (Buffer.isBuffer(content)) {
    diff = `${backedUp ? "replaced" : "new file"}: ${content.length} bytes`;
  } else if (previousContent !== undefined) {
    const oldLines = previousContent.split(/\r?\n/).length;
    const delta = newLines - oldLines;
    const sign = delta >= 0 ? "+" : "";
    diff = `${oldLines} lines → ${newLines} lines (${sign}${delta})`;
  } else {
    diff = `new file: ${newLines} lines`;
  }

  return {
    written: relativePath,
    backedUp,
    backupPath,
    diff,
  };
}
