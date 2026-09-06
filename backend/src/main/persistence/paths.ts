// Phase DB.2 — Run-relative path guard (backend/src/main/persistence/paths.ts).
// Rule (BACKEND_HANDOFF.md:211, TASKS.md DB.3): SQLite stores only run-relative paths.
// Absolute paths and `..` traversal are rejected at the app layer before any insert.
// Full attachment/token DAO lands in Phase 2 (run/filesystem.ts); this is the shared rule.

import path from "node:path";

const ABS_WIN = /^[a-zA-Z]:[\\/]|^\\\\/;
const ABS_POSIX = /^\//;

export function assertSafeRelativePath(relativePath: string): void {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("relative_path must be a non-empty string");
  }
  if (ABS_WIN.test(relativePath) || ABS_POSIX.test(relativePath) || path.isAbsolute(relativePath)) {
    throw new Error(`absolute path rejected: ${relativePath}`);
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`path traversal rejected: ${relativePath}`);
  }
  if (relativePath.includes("\0")) {
    throw new Error("null byte rejected in relative_path");
  }
}
