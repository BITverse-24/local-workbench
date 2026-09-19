import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveSafe } from "../path-guard.js";

/** Directories and files to skip during listing (HARNESS.md §3). */
const IGNORE_LIST = new Set([
  ".git",
  "node_modules",
  "venv",
  "__pycache__",
  ".venv",
  ".next",
  ".nuxt",
  "dist",
  "build",
  ".DS_Store",
  "vendor",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "coverage",
  ".nyc_output",
  ".harness_backups",
]);

export interface DirEntry {
  name: string;
  type: "file" | "directory";
  size: number; // bytes, 0 for directories
}

/**
 * Recursive directory walk with ignore list applied.
 * Returns flat array of {name, type, size} (HARNESS.md §5).
 * maxDepth defaults to 4.
 *
 * PERF OPTIMIZATION: Early depth guard check, direct string filtering, and efficient directory walk loop.
 * Bypasses stats and path resolution for ignored files and out-of-bounds recursive depths.
 */
export function listDir(
  workspaceRoot: string,
  relativePath: string = ".",
  maxDepth: number = 4,
): DirEntry[] {
  if (maxDepth < 1) return [];

  const target = resolveSafe(workspaceRoot, relativePath);
  const entries: DirEntry[] = [];

  function walk(dir: string, currentDepth: number): void {
    if (currentDepth > maxDepth) return;

    let items: string[];
    try {
      items = readdirSync(dir);
    } catch {
      return; // Permission denied or unreadable directory — skip gracefully
    }

    // Filter out ignored items before sorting to reduce string comparison work
    const filtered: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!IGNORE_LIST.has(item)) {
        filtered.push(item);
      }
    }

    // Sort alphabetically for deterministic output
    filtered.sort();

    for (let i = 0; i < filtered.length; i++) {
      const name = filtered[i];
      const fullPath = path.join(dir, name);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue; // Broken symlink or unreadable file — skip
      }

      const rel = path.relative(workspaceRoot, fullPath);

      if (stat.isDirectory()) {
        entries.push({ name: rel, type: "directory", size: 0 });
        if (currentDepth < maxDepth) {
          walk(fullPath, currentDepth + 1);
        }
      } else if (stat.isFile()) {
        entries.push({ name: rel, type: "file", size: stat.size });
      }
    }
  }

  walk(target, 1);
  return entries;
}
