import { readFileSync, statSync } from "node:fs";
import { resolveSafe } from "../path-guard.js";

const MAX_FILE_SIZE = 200 * 1024; // 200KB limit per HARNESS.md §5

/**
 * Read file content. Rejects files > ~200KB (HARNESS.md §5).
 * Calls resolveSafe as first operation (HARNESS.md §4).
 */
export function readFile(workspaceRoot: string, relativePath: string): string {
  const target = resolveSafe(workspaceRoot, relativePath);
  const stat = statSync(target);

  if (!stat.isFile()) {
    throw new Error(`not a file: ${relativePath}`);
  }

  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(
      `file too large (${(stat.size / 1024).toFixed(0)}KB > ${MAX_FILE_SIZE / 1024}KB limit) — use search instead`
    );
  }

  return readFileSync(target, "utf8");
}
