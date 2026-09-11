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
 */
export function listDir(
  workspaceRoot: string,
  relativePath: string = ".",
  maxDepth: number = 4,
): DirEntry[] {
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

    // Sort alphabetically for deterministic output
    items.sort();

    for (const name of items) {
      if (IGNORE_LIST.has(name)) continue;

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
        walk(fullPath, currentDepth + 1);
      } else if (stat.isFile()) {
        entries.push({ name: rel, type: "file", size: stat.size });
      }
    }
  }

  walk(target, 1);
  return entries;
}
