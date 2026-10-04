import { randomUUID } from "node:crypto";
import path from "node:path";
import { PermissionError } from "./path-guard.js";

export type MutationOperation =
  | "write_file"
  | "delete_file"
  | "run_command"
  | "execute_python"
  | "*";

export interface MutationScopeConstraint {
  id: string;
  runId?: string;
  operation: MutationOperation;
  targetPath?: string;
  command?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface MutationRequest {
  runId?: string;
  operation: MutationOperation;
  targetPath?: string;
  command?: string;
}

export type MutationAuthorizer = (
  request: MutationRequest,
  summary: string,
) => Promise<boolean>;

export function normalizePath(p?: string): string {
  if (!p || typeof p !== "string") return "";
  let norm = path.normalize(p).replace(/^[./\\]+/, "");
  norm = norm.replace(/\\/g, "/");
  return norm;
}

export function normalizeCommand(c?: string): string {
  if (!c || typeof c !== "string") return "";
  return c.trim().replace(/\s+/g, " ");
}

export function isPathMatch(grantedPath: string, requestedPath: string): boolean {
  if (grantedPath === "*" || grantedPath === "**") return true;
  const gNorm = normalizePath(grantedPath);
  const rNorm = normalizePath(requestedPath);
  if (gNorm === rNorm) return true;
  if (gNorm.endsWith("/*")) {
    const dir = gNorm.slice(0, -2);
    return rNorm.startsWith(dir + "/") && !rNorm.slice(dir.length + 1).includes("/");
  }
  if (gNorm.endsWith("/**")) {
    const dir = gNorm.slice(0, -3);
    return rNorm.startsWith(dir + "/");
  }
  // Allow stem / prefix variation for the same target file (e.g. fixed-foo.py vs foo.py)
  const gBase = path.basename(gNorm).replace(/^(?:repaired-|fixed-|updated-|new-)/, "");
  const rBase = path.basename(rNorm).replace(/^(?:repaired-|fixed-|updated-|new-)/, "");
  if (gBase === rBase && path.dirname(gNorm) === path.dirname(rNorm)) {
    return true;
  }
  return false;
}

export function isCommandMatch(grantedCommand: string, requestedCommand: string): boolean {
  if (grantedCommand === "*") return true;
  const gNorm = normalizeCommand(grantedCommand);
  const rNorm = normalizeCommand(requestedCommand);
  if (gNorm === rNorm) return true;
  if (gNorm.endsWith("*")) {
    const prefix = gNorm.slice(0, -1).trim();
    return rNorm.startsWith(prefix);
  }
  // Coarse-grained runner matching for Python scripts/runners:
  // If user granted a python3 invocation, allow subsequent python3 test/assertion commands.
  const isPython = (c: string) => /^(?:python3?|-m\s+pytest|pytest)\b/.test(c);
  if (isPython(gNorm) && isPython(rNorm)) {
    return true;
  }
  if (
    rNorm.startsWith(gNorm + " ") ||
    rNorm.startsWith(gNorm + "\n") ||
    rNorm.startsWith(gNorm + "\r") ||
    rNorm.startsWith(gNorm + "\t")
  ) {
    return true;
  }
  return false;
}

export function extractPathArg(args: Record<string, unknown>): string {
  if (!args) return "";
  const candidateKeys = [
    "path", "filePath", "filepath", "file_path", "filename", "fileName",
    "file", "target", "destination", "dest", "targetPath", "target_path",
  ];
  for (const k of candidateKeys) {
    if (typeof args[k] === "string" && (args[k] as string).trim()) {
      return (args[k] as string).trim();
    }
  }

  for (const wrapper of ["parameters", "arguments", "input", "params"]) {
    const val = args[wrapper];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = extractPathArg(val as Record<string, unknown>);
      if (nested) return nested;
    } else if (typeof val === "string" && val.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed === "object") {
          const nested = extractPathArg(parsed);
          if (nested) return nested;
        }
      } catch {}
    }
  }

  const rawStr = typeof args.raw === "string" ? args.raw : "";
  if (rawStr) {
    const m = rawStr.match(/["']?(?:path|filePath|file_path|filename|fileName|file|target)["']?\s*:\s*["']([^"'\r\n]+)["']/i);
    if (m && m[1]) return m[1].trim();
  }

  return "";
}

export function extractCommandArg(args: Record<string, unknown>): string {
  if (!args) return "";
  const candidateKeys = ["command", "cmd", "shell_command", "script", "exec"];
  for (const k of candidateKeys) {
    if (typeof args[k] === "string" && (args[k] as string).trim()) {
      return (args[k] as string).trim();
    }
  }
  for (const wrapper of ["parameters", "arguments", "input", "params"]) {
    const val = args[wrapper];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = extractCommandArg(val as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  const rawStr = typeof args.raw === "string" ? args.raw : "";
  if (rawStr) {
    const m = rawStr.match(/["']?(?:command|cmd|shell_command|script|exec)["']?\s*:\s*["']([^"'\r\n]+)["']/i);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

/**
 * Async lock manager to serialize concurrent mutations on the same target
 * (e.g. concurrent writes/deletes on the same file, or concurrent command execution).
 */
export class AsyncLockManager {
  private locks = new Map<string, Promise<void>>();

  async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const currentLock = this.locks.get(key) || Promise.resolve();
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, currentLock.then(() => nextLock, () => nextLock));

    try {
      await currentLock;
      return await fn();
    } finally {
      release!();
      if (this.locks.get(key) === nextLock) {
        this.locks.delete(key);
      }
    }
  }
}

export interface PolicyGuardOptions {
  strict?: boolean;
}

/**
 * Central Mutation Authorization and Concurrency Policy Guard.
 *
 * Implements P0-06:
 * - Operation-level authorization.
 * - Scoped binding (operation, target file, command, expiration).
 * - Central authorization checking for both AgentLoop and HarnessManager.
 * - Async lock serialization for concurrent mutations.
 */
export class MutationPolicyGuard {
  private scopes: MutationScopeConstraint[] = [];
  private lockManager = new AsyncLockManager();
  private strictRuns = new Set<string>();
  private globalStrict: boolean = false;
  private authorizer?: MutationAuthorizer;
  private protectedPathsByRun = new Map<string, Set<string>>();
  private targetRestrictionsByRun = new Map<string, { restricted: boolean; allowedTargets: Set<string> }>();

  constructor(options?: PolicyGuardOptions) {
    this.globalStrict = options?.strict ?? false;
  }

  setProtectedPaths(runId: string, paths: string[]): void {
    const set = new Set<string>();
    for (const p of paths) {
      const norm = normalizePath(p);
      if (norm) {
        set.add(norm.toLowerCase());
        set.add(path.basename(norm).toLowerCase());
      }
    }
    this.protectedPathsByRun.set(runId, set);
  }

  setMutationTargetRestriction(runId: string, restricted: boolean, allowedTargets: string[]): void {
    const set = new Set<string>();
    for (const t of allowedTargets) {
      const norm = normalizePath(t);
      if (norm) {
        set.add(norm.toLowerCase());
        set.add(path.basename(norm).toLowerCase());
      }
    }
    this.targetRestrictionsByRun.set(runId, { restricted, allowedTargets: set });
  }

  isPathProtected(runId: string | undefined, targetPath?: string): boolean {
    if (!runId || !targetPath) return false;
    const protectedSet = this.protectedPathsByRun.get(runId);
    if (!protectedSet) return false;
    const norm = normalizePath(targetPath).toLowerCase();
    const base = path.basename(norm).toLowerCase();
    return protectedSet.has(norm) || protectedSet.has(base);
  }

  isPathTargetRestricted(runId: string | undefined, targetPath?: string): boolean {
    if (!runId || !targetPath) return false;
    const restriction = this.targetRestrictionsByRun.get(runId);
    if (!restriction || !restriction.restricted) return false;
    const norm = normalizePath(targetPath).toLowerCase();
    const base = path.basename(norm).toLowerCase();
    return !restriction.allowedTargets.has(norm) && !restriction.allowedTargets.has(base);
  }

  setEnforceExplicit(runId?: string, enforce: boolean = true): void {
    if (runId) {
      if (enforce) this.strictRuns.add(runId);
      else this.strictRuns.delete(runId);
    } else {
      this.globalStrict = enforce;
    }
  }

  isEnforcingExplicit(runId?: string): boolean {
    if (this.globalStrict) return true;
    if (runId && this.strictRuns.has(runId)) return true;
    if (runId && this.scopes.some((s) => s.runId === runId)) return true;
    return false;
  }

  setAuthorizer(authorizer?: MutationAuthorizer): void {
    this.authorizer = authorizer;
  }

  grantScope(
    constraint: Omit<MutationScopeConstraint, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    },
  ): MutationScopeConstraint {
    const fullConstraint: MutationScopeConstraint = {
      id: constraint.id || randomUUID(),
      createdAt: constraint.createdAt || new Date().toISOString(),
      runId: constraint.runId,
      operation: constraint.operation,
      targetPath: constraint.targetPath ? normalizePath(constraint.targetPath) : undefined,
      command: constraint.command ? normalizeCommand(constraint.command) : undefined,
      expiresAt: constraint.expiresAt,
    };
    this.scopes.push(fullConstraint);
    if (fullConstraint.runId) {
      this.strictRuns.add(fullConstraint.runId);
    }
    return fullConstraint;
  }

  revokeRunScopes(runId: string): void {
    this.scopes = this.scopes.filter((s) => s.runId !== runId);
    this.strictRuns.delete(runId);
    this.protectedPathsByRun.delete(runId);
    this.targetRestrictionsByRun.delete(runId);
  }

  clear(): void {
    this.scopes = [];
    this.strictRuns.clear();
    this.protectedPathsByRun.clear();
    this.targetRestrictionsByRun.clear();
  }

  getActiveScopes(runId?: string): MutationScopeConstraint[] {
    const now = Date.now();
    return this.scopes.filter((s) => {
      if (s.expiresAt && Date.parse(s.expiresAt) <= now) return false;
      if (runId && s.runId && s.runId !== runId) return false;
      return true;
    });
  }

  isAuthorized(
    runId: string | undefined,
    operation: MutationOperation,
    args?: Record<string, unknown>,
  ): boolean {
    const targetPath = args
      ? extractPathArg(args) || (typeof args.path === "string" ? args.path : undefined)
      : undefined;

    // 1. Always check if path is explicitly protected/prohibited by user constraint
    if (runId && targetPath && this.isPathProtected(runId, targetPath)) {
      return false;
    }

    // 2. Always check if mutations are restricted to declared targets only
    if (runId && targetPath && (operation === "write_file" || operation === "delete_file")) {
      if (this.isPathTargetRestricted(runId, targetPath)) {
        return false;
      }
    }

    if (!this.isEnforcingExplicit(runId)) {
      return true;
    }

    const now = Date.now();
    const command = args
      ? extractCommandArg(args) || (typeof args.command === "string" ? args.command : undefined)
      : undefined;

    const active = this.scopes.filter((s) => {
      if (s.expiresAt && Date.parse(s.expiresAt) <= now) return false;
      if (runId && s.runId && s.runId !== runId) return false;
      return true;
    });

    for (const scope of active) {
      // Check operation match
      if (scope.operation !== "*" && scope.operation !== operation) {
        continue;
      }

      // Check target path if specified
      if (scope.targetPath && scope.targetPath !== "*") {
        if (!targetPath) continue;
        if (!isPathMatch(scope.targetPath, targetPath)) continue;
      }

      // Check command if specified
      if (scope.command && scope.command !== "*") {
        if (!command) continue;
        if (!isCommandMatch(scope.command, command)) continue;
      }

      return true;
    }

    return false;
  }

  async authorize(
    request: MutationRequest,
    summary?: string,
  ): Promise<boolean> {
    if (request.runId && request.targetPath && this.isPathProtected(request.runId, request.targetPath)) {
      return false;
    }
    if (request.runId && request.targetPath && this.isPathTargetRestricted(request.runId, request.targetPath)) {
      return false;
    }

    const isAuth = this.isAuthorized(request.runId, request.operation, {
      path: request.targetPath,
      command: request.command,
    });
    if (isAuth) return true;

    if (this.authorizer) {
      const promptText =
        summary ||
        `Authorize ${request.operation} on ${request.targetPath || request.command || "workspace"}`;
      const approved = await this.authorizer(request, promptText);
      if (approved) {
        this.grantScope({
          runId: request.runId,
          operation: request.operation,
          targetPath: request.targetPath,
          command: request.command,
        });
        return true;
      }
      return false;
    }

    return false;
  }

  async withMutationLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    return this.lockManager.withLock(key, fn);
  }
}
