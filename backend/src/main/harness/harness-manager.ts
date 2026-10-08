import path from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceManager } from "./workspace-manager.js";
import { resolveSafe, PermissionError } from "./path-guard.js";
import { MutationPolicyGuard } from "./policy-guard.js";
import { listDir, type DirEntry } from "./tools/list-dir.js";
import { readFile } from "./tools/read-file.js";
import { search, type SearchMatch } from "./tools/search.js";
import { writeFile, type WriteResult } from "./tools/write-file.js";
import { deleteFile, type DeleteResult } from "./tools/delete-file.js";
import { runCommand, type CommandResult } from "./tools/run-command.js";
import { getDb } from "../persistence/db.js";
import { writeRunFile } from "../run/filesystem.js";
import { logArtifactReady, logHarnessToolCall, logHarnessToolResult } from "../logger.js";
import type {
  HarnessToolCall,
  HarnessToolResult,
  HarnessToolName,
  WorkspaceEvent,
  WorkspaceInfo,
  RunEvent,
  ArtifactRef,
  ArtifactKind,
} from "../../shared/contracts.js";
export type { WorkspaceEvent };

function inferKind(filename: string): ArtifactKind {
  const ext = path.extname(filename).toLowerCase().replace(/^\./, "");
  if (["xlsx", "xls"].includes(ext)) return "xlsx";
  if (["csv"].includes(ext)) return "csv";
  if (["txt"].includes(ext)) return "txt";
  if (["json"].includes(ext)) return "json";
  if (["md", "markdown"].includes(ext)) return "md";
  if (["docx", "doc"].includes(ext)) return "docx";
  if (["pdf"].includes(ext)) return "pdf";
  return "txt";
}

/**
 * Harness orchestrator — dispatches tool calls to the five harness tools.
 *
 * Integrates with the existing RunEvent pipeline:
 * - Tool calls and results are emitted as WorkspaceEvents
 * - When runId is supplied, tool execution also emits RunEvent-compatible
 *   events (tool_call / tool_result) so they stream into the live transcript.
 * - Supports creating workspace artifact references for chat-level display.
 */
export class HarnessManager {
  private readonly workspace = new WorkspaceManager();
  private readonly createdArtifactsByRun = new Map<string, ArtifactRef>();
  public readonly policyGuard: MutationPolicyGuard;

  constructor(
    private readonly emitWorkspace: (event: WorkspaceEvent) => void = () => undefined,
    private readonly emitRun: ((event: RunEvent) => void) | undefined = undefined,
    policyGuard?: MutationPolicyGuard,
  ) {
    this.policyGuard = policyGuard ?? new MutationPolicyGuard();
  }

  registerWorkspace(dirPath: string): WorkspaceInfo {
    const info = this.workspace.register(dirPath);
    const tree = listDir(info.root);
    this.emitWorkspace({ type: "workspace_registered", workspace: info });
    this.emitWorkspace({ type: "workspace_tree", entries: tree });
    return info;
  }

  deregisterWorkspace(): void {
    this.workspace.deregister();
    this.emitWorkspace({ type: "workspace_deregistered" });
  }

  currentWorkspace(): WorkspaceInfo | null {
    return this.workspace.current();
  }

  restoreWorkspace(): WorkspaceInfo | null {
    const info = this.workspace.restoreWorkspace();
    if (info) {
      const tree = listDir(info.root);
      this.emitWorkspace({ type: "workspace_registered", workspace: info });
      this.emitWorkspace({ type: "workspace_tree", entries: tree });
    }
    return info;
  }

  isWorkspaceActive(): boolean {
    return this.currentWorkspace() !== null;
  }

  getActiveWorkspace(): WorkspaceInfo | null {
    return this.currentWorkspace();
  }

  requireActiveWorkspace(): WorkspaceInfo {
    return this.workspace.requireActive();
  }

  notifyWorkspaceTreeUpdated(): void {
    if (!this.isWorkspaceActive()) return;
    try {
      this.emitWorkspace({ type: "workspace_tree", entries: this.getDirectoryTree() });
    } catch {}
  }

  /**
   * Execute a single harness tool call.
   * Every tool validates path containment via resolveSafe().
   *
   * When runId is provided, emits tool_call/tool_result into the
   * RunEvent stream so the call appears in the chat transcript.
   */
  async executeTool(
    call: HarnessToolCall,
    runId?: string,
  ): Promise<HarnessToolResult> {
    const ws = this.workspace.requireActive();

    // 1. Emit tool_call event (appears in transcript if runId provided)
    const toolName = call.tool as HarnessToolName;
    const callSummary = this.summarizeCall(call);

    logHarnessToolCall({
      tool: toolName,
      args: call.args as Record<string, unknown>,
      runId,
      workspaceRoot: ws.root,
    });

    this.emitWorkspace({
      type: "harness_tool_call",
      runId: runId ?? "",
      tool: toolName,
      summary: callSummary,
    });

    if (runId && this.emitRun) {
      this.emitRun({
        type: "tool_call",
        runId,
        tool: toolName as any,
        summary: callSummary,
      });
    }

    // 2. Dispatch to the specific tool handler
    let result: HarnessToolResult;

    switch (call.tool) {
      case "list_dir": {
        const entries = listDir(ws.root, call.args.path ?? ".");
        result = { tool: "list_dir", result: entries };
        break;
      }

      case "read_file": {
        const content = readFile(ws.root, call.args.path);
        result = { tool: "read_file", result: content };
        break;
      }

      case "search": {
        const matches = search(ws.root, call.args.query, call.args.path ?? ".");
        result = { tool: "search", result: matches };
        break;
      }

      case "write_file": {
        const targetPath = call.args.path;
        if (this.policyGuard.isEnforcingExplicit(runId)) {
          const isAuth = this.policyGuard.isAuthorized(runId, "write_file", { path: targetPath });
          if (!isAuth) {
            throw new PermissionError(`Operation not authorized: write_file ${targetPath}`);
          }
        }
        const lockKey = `file:${targetPath}`;
        const writeRes = await this.policyGuard.withMutationLock(lockKey, () =>
          writeFile(ws.root, call.args.path, call.args.content),
        );
        result = { tool: "write_file", result: writeRes };
        break;
      }

      case "delete_file": {
        const targetPath = call.args.path;
        if (this.policyGuard.isEnforcingExplicit(runId)) {
          const isAuth = this.policyGuard.isAuthorized(runId, "delete_file", { path: targetPath });
          if (!isAuth) {
            throw new PermissionError(`Operation not authorized: delete_file ${targetPath}`);
          }
        }
        const lockKey = `file:${targetPath}`;
        const delRes = await this.policyGuard.withMutationLock(lockKey, () =>
          deleteFile(ws.root, call.args.path),
        );
        result = { tool: "delete_file", result: delRes };
        break;
      }

      case "run_command": {
        const command = call.args.command;
        if (this.policyGuard.isEnforcingExplicit(runId)) {
          const isAuth = this.policyGuard.isAuthorized(runId, "run_command", { command });
          if (!isAuth) {
            throw new PermissionError(`Operation not authorized: run_command ${command}`);
          }
        }
        const cmdRes = await this.policyGuard.withMutationLock("workspace:run_command", () =>
          runCommand(ws.root, call.args.command),
        );
        result = { tool: "run_command", result: cmdRes };
        break;
      }
    }

    // 3. Emit tool_result event (appears in transcript if runId provided)
    const resultSummary = this.summarizeResult(result);

    logHarnessToolResult(
      { tool: toolName, args: call.args as Record<string, unknown> },
      result,
    );

    this.emitWorkspace({
      type: "harness_tool_result",
      runId: runId ?? "",
      tool: toolName,
      summary: resultSummary,
    });

    if (toolName === "write_file" || toolName === "run_command" || toolName === "delete_file") {
      try {
        this.emitWorkspace({ type: "workspace_tree", entries: this.getDirectoryTree() });
      } catch {}
    }

    if (call.tool === "delete_file" && runId) {
      const filename = path.basename(call.args.path);
      this.createdArtifactsByRun.delete(`${runId}:${filename}`);
    }

    if (runId && this.emitRun) {
      this.emitRun({
        type: "tool_result",
        runId,
        tool: toolName as any,
        summary: resultSummary,
      });
    }

    return result;
  }

  /**
   * Get the initial directory tree for context injection.
   * This is the "lazy context" from HARNESS.md §2 — names, types, sizes only.
   */
  getDirectoryTree(relativePath: string = "."): DirEntry[] {
    const ws = this.workspace.requireActive();
    return listDir(ws.root, relativePath);
  }

  /**
   * Create an ArtifactRef for a file inside the active workspace.
   * Useful when a workspace file needs to be displayed in the artifact pane.
   */
  createWorkspaceArtifact(runId: string, relativePath: string): ArtifactRef {
    const ws = this.workspace.requireActive();
    const target = resolveSafe(ws.root, relativePath);
    const filename = path.basename(target);
    const dedupeKey = `${runId}:${filename}`;
    const cached = this.createdArtifactsByRun.get(dedupeKey);
    if (cached) {
      return cached;
    }

    let size = 0;
    let content: Buffer | string = "";
    try {
      content = readFileSync(target);
      size = content.length;
    } catch {
      try {
        size = statSync(target).size;
      } catch {}
    }

    const kind = inferKind(filename);

    let storedRel = path.relative(ws.root, target);

    // If runId is a valid UUID, mirror snapshot into run output directory
    const isValidRunId = /^[0-9a-f-]{36}$/i.test(runId);
    if (isValidRunId) {
      try {
        storedRel = writeRunFile(runId, "output", filename, content, true);
      } catch {
        // Fallback to workspace-relative path if run directories not initialized
      }
    }

    const artifact: ArtifactRef = {
      artifactId: randomUUID(),
      runId,
      kind,
      filename,
      relativePath: storedRel,
      sizeBytes: size,
      sha256: createHash("sha256").update(content).digest("hex"),
      createdAt: new Date().toISOString(),
    };

    // Persist to SQLite artifacts table
    try {
      getDb()
        .prepare(
          "INSERT INTO artifacts(artifact_id, run_id, kind, filename, relative_path, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          artifact.artifactId,
          artifact.runId,
          artifact.kind,
          artifact.filename,
          artifact.relativePath,
          artifact.sizeBytes,
          artifact.sha256,
          artifact.createdAt,
        );
      logArtifactReady(artifact);
    } catch {
      // Database might not be initialized in isolated unit tests
    }

    if (this.emitRun) {
      this.emitRun({
        type: "artifact_ready",
        runId,
        artifact,
      });
    }

    this.createdArtifactsByRun.set(dedupeKey, artifact);
    return artifact;
  }

  /**
   * Safely copy an external file (e.g. from run output) into the active workspace.
   * Path containment is enforced via resolveSafe().
   */
  copyArtifactToWorkspace(
    sourceAbsPath: string,
    destinationRelPath: string,
    runId: string,
  ): ArtifactRef {
    const ws = this.workspace.requireActive();
    const target = resolveSafe(ws.root, destinationRelPath);
    const parentDir = path.dirname(target);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    copyFileSync(sourceAbsPath, target);
    const artifact = this.createWorkspaceArtifact(runId, destinationRelPath);
    try {
      this.emitWorkspace({ type: "workspace_tree", entries: this.getDirectoryTree() });
    } catch {}
    return artifact;
  }

  // ── Private helpers ──────────────────────────────────────────

  private summarizeCall(call: HarnessToolCall): string {
    switch (call.tool) {
      case "list_dir":
        return `listing directory: ${call.args.path ?? "."}`;
      case "read_file":
        return `reading file: ${call.args.path}`;
      case "search":
        return `searching for: "${call.args.query}" in ${call.args.path ?? "."}`;
      case "write_file":
        return `writing file: ${call.args.path}`;
      case "delete_file":
        return `deleting file: ${call.args.path}`;
      case "run_command":
        return `running command: ${call.args.command.slice(0, 80)}`;
    }
  }

  private summarizeResult(result: HarnessToolResult): string {
    switch (result.tool) {
      case "list_dir":
        return `${result.result.length} entries listed`;
      case "read_file":
        return `${result.result.split(/\r?\n/).length} lines read`;
      case "search":
        return `${result.result.length} matches found`;
      case "write_file":
        return result.result.diff ?? "file written";
      case "delete_file":
        return `deleted ${result.result.deleted}${result.result.backedUp ? " (backed up)" : ""}`;
      case "run_command":
        return `exit code ${result.result.exitCode}${result.result.timedOut ? " (timed out)" : ""}`;
    }
  }
}
