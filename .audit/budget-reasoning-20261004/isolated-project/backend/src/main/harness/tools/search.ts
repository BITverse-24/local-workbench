import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { resolveSafe } from "../path-guard.js";

export interface SearchMatch {
  file: string;
  lineNumber: number;
  matchingLine: string;
}

// PERF OPTIMIZATION: Cache resolved ripgrep binary path to avoid repeating
// synchronous child process spawns (`which rg`) and filesystem stats (`existsSync`)
// on every search call (~15-30ms saved per search invocation).
let cachedRgBin: string | null | undefined = undefined;

function getRgBin(): string | null {
  if (cachedRgBin !== undefined) {
    return cachedRgBin;
  }

  const rgCandidates = [
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
    "rg",
  ];
  for (const candidate of rgCandidates) {
    if (candidate === "rg") {
      try {
        execFileSync("which", ["rg"], { stdio: "ignore" });
        cachedRgBin = "rg";
        return cachedRgBin;
      } catch {}
    } else if (existsSync(candidate)) {
      cachedRgBin = candidate;
      return cachedRgBin;
    }
  }

  cachedRgBin = null;
  return cachedRgBin;
}

/**
 * Shell out to ripgrep (or grep -rn fallback) scoped to workspace root.
 * HARNESS.md §3, §5.
 */
export function search(
  workspaceRoot: string,
  query: string,
  relativePath: string = ".",
  maxResults: number = 50,
): SearchMatch[] {
  if (!query || typeof query !== "string") {
    return [];
  }

  const target = resolveSafe(workspaceRoot, relativePath);

  // Check if target is a file or directory
  let isDirectory = true;
  try {
    isDirectory = statSync(target).isDirectory();
  } catch {
    return [];
  }

  const rgBin = getRgBin();

  let stdout = "";
  try {
    if (rgBin) {
      const args = [
        "--no-heading",
        "--line-number",
        "--color",
        "never",
        "--max-count",
        String(maxResults),
        "--glob",
        "!.git",
        "--glob",
        "!node_modules",
        "--glob",
        "!venv",
        "--glob",
        "!__pycache__",
        "--glob",
        "!.harness_backups",
        "--glob",
        "!dist",
        "--glob",
        "!build",
        "-e",
        query,
        target,
      ];
      stdout = execFileSync(rgBin, args, {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
    } else {
      const args = [
        "-rn",
        "--exclude-dir=.git",
        "--exclude-dir=node_modules",
        "--exclude-dir=venv",
        "--exclude-dir=__pycache__",
        "--exclude-dir=.harness_backups",
        "-m",
        String(maxResults),
        "-e",
        query,
        target,
      ];
      stdout = execFileSync("grep", args, {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
    }
  } catch (err: any) {
    // ripgrep and grep exit code 1 means "no matches found" — not a failure
    if (err && err.status === 1) {
      return [];
    }
    // If grep exits with 2 or other errors
    return [];
  }

  const results: SearchMatch[] = [];
  const canonicalRoot = resolveSafe(workspaceRoot, ".");

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;

    // Pattern: <filePath>:<lineNumber>:<matchingContent>
    const colon1 = line.indexOf(":");
    if (colon1 === -1) continue;
    const colon2 = line.indexOf(":", colon1 + 1);
    if (colon2 === -1) continue;

    const rawFile = line.slice(0, colon1);
    const lineNumStr = line.slice(colon1 + 1, colon2);
    const matchingLine = line.slice(colon2 + 1);

    const lineNum = parseInt(lineNumStr, 10);
    if (isNaN(lineNum)) continue;

    const resolvedFile = path.resolve(rawFile);
    let relFile: string;
    if (resolvedFile.startsWith(canonicalRoot + path.sep)) {
      relFile = resolvedFile.slice(canonicalRoot.length + 1);
    } else if (resolvedFile === canonicalRoot) {
      relFile = path.basename(resolvedFile);
    } else {
      relFile = path.relative(canonicalRoot, resolvedFile);
    }

    results.push({
      file: relFile,
      lineNumber: lineNum,
      matchingLine: matchingLine.slice(0, 500),
    });

    if (results.length >= maxResults) break;
  }

  return results;
}
