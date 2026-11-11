import { parse } from "@babel/parser";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSafe } from "../../harness/path-guard.js";
import { getPythonExecutable } from "../../tools/python-runtime.js";
import { checkPolyglotSyntax, isPolyglotPath } from "./adapters/polyglot.js";

export interface Diagnostic {
  path: string;
  line: number;
  col?: number;
  severity: "error" | "warning";
  code?: string;
  message: string;
  source: string;
}

const normMsg = (m: string) => m.replace(/\s+/g, " ").replace(/:\d+(?::\d+)?/g, "").trim().toLowerCase();

/**
 * Delta filter: keep only diagnostics not already in `before` (matched by file, code, and
 * normalized message so line shifts from edits do not look like new errors).
 */
export function diffDiagnostics(before: Diagnostic[], after: Diagnostic[]): Diagnostic[] {
  const seen = new Set(before.map((d) => `${d.path}|${d.code ?? ""}|${normMsg(d.message)}`));
  return after.filter((d) => !seen.has(`${d.path}|${d.code ?? ""}|${normMsg(d.message)}`));
}

export function formatDiagnostics(items: Diagnostic[], maxItems = 12, maxChars = 1500): string {
  const sorted = [...items].sort((a, b) => (a.severity === b.severity ? a.path.localeCompare(b.path) || a.line - b.line : a.severity === "error" ? -1 : 1));
  const lines = sorted.slice(0, maxItems).map((d) => `${d.path}:${d.line}${d.col ? `:${d.col}` : ""} [${d.source}${d.code ? ` ${d.code}` : ""}] ${d.severity}: ${d.message}`);
  if (sorted.length > maxItems) lines.push(`... and ${sorted.length - maxItems} more diagnostic(s)`);
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

export function diagnosticsEnabled(): boolean {
  return process.env.WORKBENCH_DIAGNOSTICS !== "off" && process.env.WORKBENCH_DIAGNOSTICS !== "false" && process.env.WORKBENCH_DIAGNOSTICS !== "0";
}

/* ───────────── Parse-tier checks (in-memory, safe before approval) ───────────── */

function checkJsTsSyntax(filePath: string, bytes: Buffer): Diagnostic[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [{ path: filePath, line: 1, severity: "error", message: "Invalid UTF-8 source", source: "syntax" }];
  }
  const isTs = /\.[cm]?tsx?$/i.test(filePath);
  try {
    const tree = parse(text, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: false,
      plugins: ["jsx", ...(isTs ? (["typescript", "decorators-legacy"] as const) : [])],
    });
    return (tree.errors ?? []).slice(0, 8).map((err: any) => ({
      path: filePath,
      line: Number(err?.loc?.line ?? 1),
      col: err?.loc?.column != null ? Number(err.loc.column) + 1 : undefined,
      severity: "error" as const,
      code: err?.reasonCode ? String(err.reasonCode) : undefined,
      message: String(err?.message ?? "Syntax error").replace(/\s*\(\d+:\d+\)\s*$/, ""),
      source: "babel",
    }));
  } catch (err: any) {
    return [{
      path: filePath,
      line: Number(err?.loc?.line ?? 1),
      col: err?.loc?.column != null ? Number(err.loc.column) + 1 : undefined,
      severity: "error" as const,
      code: err?.reasonCode ? String(err.reasonCode) : undefined,
      message: String(err?.message ?? "Syntax error").replace(/\s*\(\d+:\d+\)\s*$/, ""),
      source: "babel",
    }];
  }
}

const PY_SYNTAX_SCRIPT = `
import ast, json, sys
src = sys.stdin.buffer.read().decode("utf-8", errors="strict")
try:
    tree = ast.parse(src, filename=sys.argv[1])
    compile(tree, sys.argv[1], "exec")
    print("[]")
except SyntaxError as e:
    print(json.dumps([{"line": e.lineno or 1, "col": e.offset or 1, "message": e.msg or "syntax error"}]))
`;

function checkPythonSyntax(filePath: string, bytes: Buffer): Diagnostic[] {
  let python: string;
  try {
    python = getPythonExecutable();
  } catch {
    return [];
  }
  const res = spawnSync(python, ["-I", "-c", PY_SYNTAX_SCRIPT, filePath], { input: bytes, timeout: 4000, encoding: "utf8" });
  if (res.status !== 0 || !res.stdout?.trim()) return [];
  try {
    const parsed = JSON.parse(res.stdout) as Array<{ line: number; col?: number; message: string }>;
    return parsed.map((e) => ({ path: filePath, line: e.line, col: e.col, severity: "error", message: e.message, source: "python-ast" }));
  } catch {
    return [];
  }
}

function checkJsonSyntax(filePath: string, bytes: Buffer): Diagnostic[] {
  try {
    JSON.parse(bytes.toString("utf8"));
    return [];
  } catch (err) {
    return [{ path: filePath, line: 1, severity: "error", message: err instanceof Error ? err.message : String(err), source: "json" }];
  }
}

type ExtraSyntaxHook = (filePath: string, bytes: Buffer) => Diagnostic[];
const extraSyntaxHooks: ExtraSyntaxHook[] = [];
/** Allows Phase C (tree-sitter adapters) to plug syntax checking into the same gate without circular imports. */
export function registerSyntaxCheck(hook: ExtraSyntaxHook): void {
  extraSyntaxHooks.push(hook);
}

export function checkBufferSyntax(filePath: string, bytes: Buffer): Diagnostic[] {
  if (/\.[cm]?[jt]sx?$/i.test(filePath)) return checkJsTsSyntax(filePath, bytes);
  if (/\.py$/i.test(filePath)) return checkPythonSyntax(filePath, bytes);
  if (/\.json$/i.test(filePath)) return checkJsonSyntax(filePath, bytes);
  if (isPolyglotPath(filePath)) return checkPolyglotSyntax(filePath, bytes);
  for (const hook of extraSyntaxHooks) {
    const out = hook(filePath, bytes);
    if (out.length) return out;
  }
  return [];
}

/**
 * Reject a proposal that introduces a new syntax error into a file that previously parsed cleanly.
 * If the file ALREADY had syntax errors before the edit (for example in a broken-syntax repair task),
 * the edit is still rejected when the proposed output fails to parse, because an agent edit should
 * leave the file syntactically valid.
 */
export function validateProposalSyntax(filePath: string, before: Buffer | undefined, after: Buffer | undefined): void {
  if (!diagnosticsEnabled() || !after) return;
  const afterErrors = checkBufferSyntax(filePath, after);
  if (!afterErrors.length) return;
  const beforeErrors = before ? checkBufferSyntax(filePath, before) : [];
  const introduced = diffDiagnostics(beforeErrors, afterErrors);
  const report = introduced.length ? introduced : afterErrors;
  throw new Error(`Proposed change to ${filePath} has syntax error(s) — fix before applying:\n${formatDiagnostics(report, 6, 800)}`);
}

/* ───────────── Post-apply project diagnostics (safe, no user build scripts) ───────────── */

function nearestDirWith(root: string, relFile: string, marker: string): string | undefined {
  let dir = path.posix.dirname(relFile.replace(/\\/g, "/"));
  while (true) {
    const candidate = dir === "." ? marker : `${dir}/${marker}`;
    if (existsSync(resolveSafe(root, candidate))) return dir;
    if (dir === "." || !dir.includes("/")) {
      if (dir !== "." && existsSync(resolveSafe(root, marker))) return ".";
      return undefined;
    }
    dir = path.posix.dirname(dir);
  }
}

function runTscIfAvailable(root: string, changedFiles: string[]): Diagnostic[] {
  const tsFiles = changedFiles.filter((f) => /\.[cm]?tsx?$/i.test(f));
  if (!tsFiles.length) return [];
  const configDir = nearestDirWith(root, tsFiles[0], "tsconfig.json");
  if (!configDir) return [];
  const tscJs = [path.join(root, configDir, "node_modules/typescript/bin/tsc"), path.join(root, "node_modules/typescript/bin/tsc")].find((p) => existsSync(p));
  if (!tscJs) return [];
  const hasNodeModules = existsSync(path.join(root, configDir, "node_modules"));
  const cwd = resolveSafe(root, configDir);
  const res = spawnSync(process.execPath, [tscJs, "--noEmit", "--pretty", "false"], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const out: Diagnostic[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/);
    if (!m) continue;
    // When dependencies are not installed in the workspace, missing-module errors are unactionable noise.
    if (!hasNodeModules && (m[5] === "TS2307" || m[5] === "TS2580" || m[5] === "TS2591")) continue;
    const rel = path.posix.normalize(configDir === "." ? m[1] : `${configDir}/${m[1]}`);
    out.push({ path: rel, line: Number(m[2]), col: Number(m[3]), severity: m[4] as "error" | "warning", code: m[5], message: m[6].trim(), source: "tsc" });
  }
  return out;
}

function runClangSyntax(root: string, changedFiles: string[]): Diagnostic[] {
  const cFiles = changedFiles.filter((f) => /\.(?:c|cc|cpp|cxx)$/i.test(f));
  if (!cFiles.length) return [];
  if (spawnSync("/bin/sh", ["-c", "command -v clang"], { encoding: "utf8" }).status !== 0) return [];
  const out: Diagnostic[] = [];
  for (const rel of cFiles.slice(0, 4)) {
    const full = resolveSafe(root, rel);
    const isCpp = /\.(?:cc|cpp|cxx)$/i.test(rel);
    const args = ["-fsyntax-only", "-fno-color-diagnostics", ...(isCpp ? ["-x", "c++", "-std=c++17"] : ["-x", "c"]), full];
    const res = spawnSync("clang", args, { cwd: root, encoding: "utf8", timeout: 8000 });
    for (const line of (res.stderr ?? "").split("\n")) {
      const m = line.match(/^.+?:(\d+):(\d+):\s+(fatal error|error|warning):\s+(.+)$/);
      if (!m) continue;
      out.push({ path: rel, line: Number(m[1]), col: Number(m[2]), severity: m[3] === "warning" ? "warning" : "error", message: m[4].trim(), source: "clang" });
    }
  }
  return out;
}

let javaWorking: boolean | undefined;
function hasWorkingJavac(): boolean {
  if (javaWorking !== undefined) return javaWorking;
  const res = spawnSync("javac", ["-version"], { encoding: "utf8", timeout: 4000 });
  javaWorking = res.status === 0 && !/Unable to locate a Java Runtime/i.test(`${res.stdout}${res.stderr}`);
  return javaWorking;
}

function runJavacSyntax(root: string, changedFiles: string[]): Diagnostic[] {
  const jFiles = changedFiles.filter((f) => /\.java$/i.test(f));
  if (!jFiles.length || !hasWorkingJavac()) return [];
  const scratch = mkdtempSync(path.join(tmpdir(), "wb-javac-"));
  try {
    const files = jFiles.slice(0, 6).map((r) => resolveSafe(root, r));
    // -proc:none disables annotation processors so project code cannot execute during checking.
    const res = spawnSync("javac", ["-proc:none", "-Xlint:none", "-d", scratch, ...files], { cwd: root, encoding: "utf8", timeout: 10000 });
    const out: Diagnostic[] = [];
    for (const line of (res.stderr ?? "").split("\n")) {
      const m = line.match(/^(.+?\.java):(\d+):\s+(error|warning):\s+(.+)$/);
      if (!m) continue;
      const rel = path.relative(root, m[1]).replace(/\\/g, "/");
      out.push({ path: rel, line: Number(m[2]), severity: m[3] as "error" | "warning", message: m[4].trim(), source: "javac" });
    }
    return out;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function checkWorkspaceFiles(root: string, files: string[]): Diagnostic[] {
  if (!diagnosticsEnabled()) return [];
  const out: Diagnostic[] = [];
  for (const rel of files) {
    try {
      const full = resolveSafe(root, rel);
      if (existsSync(full)) out.push(...checkBufferSyntax(rel, readFileSync(full)));
    } catch {
      /* ignore unreadable paths */
    }
  }
  out.push(...runTscIfAvailable(root, files));
  out.push(...runClangSyntax(root, files));
  out.push(...runJavacSyntax(root, files));
  return out;
}

export { writeFileSync };
