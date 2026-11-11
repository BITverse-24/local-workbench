import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkerClient } from "../../../harness/client.js";
import type { ModelRegistryEntry } from "../../../../backend/src/shared/contracts.js";
import { manifest, materialize } from "../sandbox.js";
import type { RunObservation, TaskInstance } from "../task-spec.js";

export interface DriverContext {
  registry: ModelRegistryEntry[];
  workerBundle: string;
  schemaPath: string;
  embedding: { baseUrl: string; model: string };
  /** Extra environment for the worker (feature flags, etc.). */
  env?: Record<string, string>;
  keepSandbox?: boolean;
}

export interface DriverResult {
  observation: RunObservation;
  stopReason: string;
  wallMs: number;
  modelCalls: number;
  callsByRole: Record<string, number>;
  recoveries: number;
  approvals: number;
  toolCalls: number;
  filesRead: number;
  sandboxRoot?: string;
  error?: string;
}

export function registryHash(registry: ModelRegistryEntry[]): string {
  return createHash("sha256").update(JSON.stringify(registry)).digest("hex").slice(0, 12);
}

const TERMINAL = new Set(["completed", "partial", "failed", "cancelled", "limit_exceeded"]);

/**
 * Runs one task through the real application backend (IPC handlers, RunManager, tools)
 * in a worker process, exactly as the desktop app would, and returns what the oracles need.
 */
export async function runTaskInWorker(task: TaskInstance, ctx: DriverContext): Promise<DriverResult> {
  const started = Date.now();
  const root = mkdtempSync(path.join(tmpdir(), `eval-${task.family}-`));
  const dirs = {
    workspace: path.join(root, "workspace"),
    attachments: path.join(root, "attachments"),
    kb: path.join(root, "kb"),
    data: path.join(root, "data"),
    config: path.join(root, "config"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  materialize(dirs.workspace, task.workspace);
  materialize(dirs.attachments, task.attachments);
  materialize(dirs.kb, task.knowledgeBase);
  writeFileSync(path.join(dirs.config, "models.json"), JSON.stringify({ models: ctx.registry }, null, 2));
  copyFile(ctx.schemaPath, path.join(dirs.config, "schema.sql"));
  const before = manifest(dirs.workspace);

  const kbDocs = Object.keys(task.knowledgeBase ?? {}).map((p) => ({ path: p, kind: "markdown" }));
  const bootFile = path.join(root, "boot.json");
  writeFileSync(
    bootFile,
    JSON.stringify({
      root,
      setup: { workspace: [], attachments: [], knowledgeBase: kbDocs, conversation: [] },
      campaignType: "behavioral",
      registry: ctx.registry,
      embedding: ctx.embedding,
      schemaPath: path.join(dirs.config, "schema.sql"),
    }),
  );

  // The eval CLI itself runs under Electron's Node runtime, so execPath is the Electron binary
  // that matches the native SQLite/canvas ABI the backend needs.
  const child = spawn(process.execPath, [ctx.workerBundle, bootFile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...ctx.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new WorkerClient(child);
  let state = "timeout";
  let error: string | undefined;
  let runId = "";
  let inspection: any;
  try {
    await client.ready(60000);
    const sent = await client.call<{ runId: string }>(
      "send",
      {
        mode: task.mode,
        chat: task.id,
        text: task.prompt,
        files: Object.keys(task.attachments ?? {}),
        groundingEnabled: kbDocs.length > 0,
      },
      120000,
    );
    runId = sent.runId;
    try {
      state = await client.settle(runId, "approve", task.limits.timeoutMs);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      state = "timeout";
      try {
        await client.call("invoke", { channel: "workbench:cancelRun", input: { runId } }, 15000);
      } catch {
        /* the run may already be terminal */
      }
    }
    inspection = await client.call<any>("inspect", {}, 30000);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const events = client.events.map((e) => e.event as any);
  const toolCalls = events
    .filter((e) => (e.type === "tool_call" || e.type === "harness_tool_call") && (!runId || !e.runId || e.runId === runId))
    .map((e) => ({ tool: String(e.tool ?? e.name ?? ""), args: e.args }));
  const readPaths = new Set<string>();
  for (const c of toolCalls) if (c.tool === "read_file" && c.args && typeof (c.args as any).path === "string") readPaths.add((c.args as any).path);
  const approvals = events.filter((e) => e.type === "confirmation_required").length;

  const messages: Array<{ role: string; content: string; run_id?: string }> = inspection?.messages ?? [];
  const assistantText = messages.filter((m) => m.role === "assistant" && (!runId || m.run_id === runId || !m.run_id)).map((m) => m.content).join("\n");
  const artifacts: RunObservation["artifacts"] = [];
  for (const row of (inspection?.artifacts ?? []) as Array<{ run_id?: string; filename: string; relative_path?: string }>) {
    if (runId && row.run_id && row.run_id !== runId) continue;
    const file = path.join(dirs.data, row.relative_path ?? "");
    if (row.relative_path && existsSync(file)) artifacts.push({ filename: row.filename, bytes: readFileSync(file) });
  }
  const ledger = inspection?.ledgers?.[runId];
  const callsByRole: Record<string, number> = ledger?.agentTask?.callsByRole ?? {};
  let modelCalls = ledger?.agentTask?.modelCalls ?? 0;
  if (!modelCalls && runId) modelCalls = countGatewayRequests(path.join(dirs.data, "runs", runId, "logs", "model-gateway.log"));

  const observation: RunObservation = {
    workspaceRoot: dirs.workspace,
    before,
    after: manifest(dirs.workspace),
    finalState: TERMINAL.has(state) ? state : state,
    assistantText,
    artifacts,
    toolCalls,
  };

  const result: DriverResult = {
    observation,
    stopReason: String(ledger?.agentProgress?.stopReason ?? state),
    wallMs: Date.now() - started,
    modelCalls,
    callsByRole,
    recoveries: Number(ledger?.tokenLimitRecoveryCount ?? 0) + Number(ledger?.agentTask?.protocolCorrections ?? 0),
    approvals,
    toolCalls: toolCalls.length,
    filesRead: readPaths.size,
    sandboxRoot: ctx.keepSandbox ? root : undefined,
    error,
  };
  await shutdown(client, child);
  // The oracles still need the workspace on disk, so removal is deferred to cleanupSandboxes().
  if (!ctx.keepSandbox) pendingCleanup.push(root);
  return result;
}

async function shutdown(client: WorkerClient, child: ReturnType<typeof spawn>): Promise<void> {
  try {
    await client.call("shutdown", {}, 15000);
  } catch {
    /* worker already stopped */
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (child.exitCode !== null) {
      clearTimeout(timer);
      resolve();
    }
  });
}

const pendingCleanup: string[] = [];
/** Remove sandboxes once oracles have evaluated them. */
export function cleanupSandboxes(): void {
  while (pendingCleanup.length) {
    const dir = pendingCleanup.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

function copyFile(from: string, to: string): void {
  writeFileSync(to, readFileSync(from));
}

function countGatewayRequests(logPath: string): number {
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.includes('"phase":"request"')).length;
}
