import path from "node:path";
import { realpathSync } from "node:fs";

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

/**
 * Resolve a requested path against the workspace root, canonicalize it
 * (resolve `..` and symlinks), and reject anything outside the root.
 *
 * This is HARNESS.md §4 — the one non-negotiable guardrail.
 * Must be called as the first line of every harness tool handler.
 */
export function resolveSafe(workspaceRoot: string, requestedPath: string): string {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new PermissionError("path must be a non-empty string");
  }

  // Reject null bytes
  if (requestedPath.includes("\0")) {
    throw new PermissionError("null byte in path");
  }

  // Reject backup recovery trail access (HARNESS.md / P0-06 §D)
  const segments = requestedPath.split(/[/\\]+/);
  if (segments.some((s) => s === ".harness_backups" || s === ".backups")) {
    throw new PermissionError(`access to backup recovery trail forbidden: ${requestedPath}`);
  }

  // Reject absolute paths immediately
  if (path.isAbsolute(requestedPath)) {
    throw new PermissionError(`absolute path rejected: ${requestedPath}`);
  }

  // Ensure workspace root exists and is canonicalized
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(workspaceRoot);
  } catch {
    throw new PermissionError(`workspace root does not exist: ${workspaceRoot}`);
  }

  const joined = path.join(canonicalRoot, requestedPath);

  // Resolve symlinks and '..' segments
  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(joined);
  } catch {
    // Target file or directory might not exist yet (e.g. for write_file or creating nested files).
    // Walk up the directory chain to find the nearest existing ancestor and verify containment.
    let current = joined;
    const missingSegments: string[] = [];

    while (true) {
      const parent = path.dirname(current);
      missingSegments.unshift(path.basename(current));

      try {
        const canonicalAncestor = realpathSync(parent);
        // Verify the ancestor is contained in workspace root
        if (
          canonicalAncestor !== canonicalRoot &&
          !canonicalAncestor.startsWith(canonicalRoot + path.sep)
        ) {
          throw new PermissionError(`path escapes workspace root: ${requestedPath}`);
        }
        canonicalTarget = path.join(canonicalAncestor, ...missingSegments);
        break;
      } catch (err) {
        if (err instanceof PermissionError) throw err;
        // Parent does not exist yet, continue walking up
        if (parent === current || parent === "." || parent === path.sep) {
          throw new PermissionError(`path escapes workspace root or invalid ancestor: ${requestedPath}`);
        }
        current = parent;
      }
    }
  }

  // Final containment verification
  if (
    canonicalTarget !== canonicalRoot &&
    !canonicalTarget.startsWith(canonicalRoot + path.sep)
  ) {
    throw new PermissionError(`path escapes workspace root: ${requestedPath}`);
  }

  // Ensure canonical target does not resolve into backup directories (e.g. via symlinks)
  const backupDir = path.join(canonicalRoot, ".harness_backups");
  const altBackupDir = path.join(canonicalRoot, ".backups");
  if (
    canonicalTarget === backupDir ||
    canonicalTarget.startsWith(backupDir + path.sep) ||
    canonicalTarget === altBackupDir ||
    canonicalTarget.startsWith(altBackupDir + path.sep)
  ) {
    throw new PermissionError(`access to backup recovery trail forbidden: ${requestedPath}`);
  }

  return canonicalTarget;
}
