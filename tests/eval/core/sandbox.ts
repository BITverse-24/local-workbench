import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { FileMap } from "./task-spec.js";

const IGNORED = new Set(["node_modules", ".git", "__pycache__", ".harness_backups", ".DS_Store", "bin", "obj", "build"]);

export function ignoredEntry(name: string): boolean {
  return IGNORED.has(name) || name.endsWith(".pyc") || name.endsWith(".class") || name.endsWith(".o");
}

export function materialize(root: string, files: FileMap | undefined): void {
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files ?? {})) {
    if (path.isAbsolute(rel) || rel.split("/").includes("..")) throw new Error(`Unsafe fixture path: ${rel}`);
    const target = path.join(root, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** Relative path → sha256 for every non-ignored file. */
export function manifest(root: string, base = root, out = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(root)) {
    if (ignoredEntry(entry)) continue;
    const full = path.join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) manifest(full, base, out);
    else out.set(path.relative(base, full).replace(/\\/g, "/"), createHash("sha256").update(readFileSync(full)).digest("hex"));
  }
  return out;
}

export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [file, hash] of after) if (before.get(file) !== hash) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

/** Glob subset: exact path, `dir/**`, `*.ext`, `**\/name`. */
export function matchesGlob(file: string, pattern: string): boolean {
  if (pattern === file) return true;
  if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -2));
  if (pattern.startsWith("**/")) return file === pattern.slice(3) || file.endsWith(`/${pattern.slice(3)}`);
  if (pattern.startsWith("*.")) return file.endsWith(pattern.slice(1));
  return false;
}

export interface CommandResult {
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
}

export function runCommand(command: string, cwd: string, timeoutMs = 60000, env?: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  const timedOut = result.error != null && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  return {
    ok: result.status === 0 && !timedOut,
    code: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-4000),
    timedOut,
  };
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Does a command exist on this host? */
export function hasTool(name: string): boolean {
  return spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).status === 0;
}
