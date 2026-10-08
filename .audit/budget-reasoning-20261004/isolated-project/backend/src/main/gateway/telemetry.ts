import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRunDirectories, runRoot } from "../run/filesystem.js";

/**
 * Inference telemetry (profiling-grade, content-free).
 *
 * One JSON line per provider call is appended to `runs/<runId>/logs/inference-telemetry.jsonl`.
 * Records never contain prompt or response text, so they are safe to retain in full and are
 * never truncated. Token counts are only ever *provider reported*; when the provider omits
 * usage the record says so (`usage.source === "unavailable"`) instead of substituting an
 * estimate. The one estimate (tool-schema size) is explicitly flagged `estimated: true`.
 */

export type InferencePurpose = "working_turn" | "delegated" | "classification";

export interface ProviderUsage {
  source: "provider" | "partial" | "unavailable";
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
}

export interface InferenceTelemetryRecord {
  requestId: string;
  runId: string;
  startedAt: string;
  purpose: InferencePurpose;
  modelId: string;
  providerModel: string;
  streamed: boolean;
  messageCount: number;
  requestBodyChars: number;
  toolSchema: { count: number; serializedChars: number; estimatedTokens: number; estimated: true };
  reasoningControl: ReasoningControlRequested;
  ttftMs: number | null;
  durationMs: number;
  status: number;
  finishReason: string | null;
  usage: ProviderUsage;
  outputChars: { content: number; reasoning: number; toolArguments: number };
  toolCallNames: string[];
  maxTokens?: number;
}

/** Reasoning-control experiment configuration. Production default is "default" (no parameters sent). */
export type ReasoningMode = "default" | "template_off";

export interface ReasoningControlRequested {
  mode: ReasoningMode;
  /** Exact request parameters injected by the control (empty for default). */
  params: Record<string, unknown>;
}

const MODES: ReasoningMode[] = ["default", "template_off"];

/**
 * Resolve the reasoning control for working-model turns. Controlled only by the
 * `WORKBENCH_REASONING_MODE` environment variable so benchmarks can compare configurations while
 * production defaults stay unchanged.
 */
export function resolveReasoningControl(env: NodeJS.ProcessEnv = process.env): ReasoningControlRequested {
  const raw = (env.WORKBENCH_REASONING_MODE ?? "default").trim().toLowerCase() as ReasoningMode;
  const mode: ReasoningMode = MODES.includes(raw) ? raw : "default";
  switch (mode) {
    case "template_off": return { mode, params: { chat_template_kwargs: { enable_thinking: false } } };
    default: return { mode: "default", params: {} };
  }
}

/** Normalise an OpenAI-compatible `usage` object without inventing values. */
export function parseProviderUsage(usage: unknown): ProviderUsage {
  if (!usage || typeof usage !== "object") return { source: "unavailable" };
  const u = usage as Record<string, any>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const promptTokens = num(u.prompt_tokens);
  const completionTokens = num(u.completion_tokens);
  const reasoningTokens = num(u.completion_tokens_details?.reasoning_tokens);
  if (promptTokens === undefined && completionTokens === undefined && reasoningTokens === undefined) return { source: "unavailable" };
  const source = promptTokens !== undefined && completionTokens !== undefined ? "provider" : "partial";
  return { source, promptTokens, completionTokens, reasoningTokens };
}

const runStarts = new Map<string, number>();

export function markRunStart(runId: string): void {
  if (!runStarts.has(runId)) runStarts.set(runId, Date.now());
}

function telemetryPath(runId: string): string {
  createRunDirectories(runId);
  const logsDir = path.join(runRoot(runId), "logs");
  mkdirSync(logsDir, { recursive: true });
  return path.join(logsDir, "inference-telemetry.jsonl");
}

export function recordInference(record: InferenceTelemetryRecord): void {
  try {
    markRunStart(record.runId);
    appendFileSync(telemetryPath(record.runId), `${JSON.stringify(record)}\n`);
  } catch (e) {
    console.warn("[telemetry] failed to persist inference record:", e instanceof Error ? e.message : String(e));
  }
}

export function readInferenceTelemetry(runId: string): InferenceTelemetryRecord[] {
  try {
    const file = telemetryPath(runId);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as InferenceTelemetryRecord);
  } catch {
    return [];
  }
}

export interface RunTelemetrySummary {
  runId: string;
  outcome: string;
  totalDurationMs: number | null;
  calls: { workingTurns: number; delegated: number; classification: number; total: number };
  inferenceDurationMs: number;
  tokens: { source: "provider" | "partial" | "unavailable"; prompt: number | null; completion: number | null; reasoning: number | null; reasoningShareOfCompletion: number | null };
  perCall: Array<Pick<InferenceTelemetryRecord, "purpose" | "durationMs" | "ttftMs" | "finishReason" | "usage" | "toolCallNames">>;
}

export function summarizeRunTelemetry(runId: string, outcome: string): RunTelemetrySummary {
  const records = readInferenceTelemetry(runId);
  const start = runStarts.get(runId);
  const withUsage = records.filter((r) => r.usage.source !== "unavailable");
  const total = (field: "promptTokens" | "completionTokens" | "reasoningTokens") =>
    records.length > 0 && records.every((r) => typeof r.usage[field] === "number")
      ? records.reduce((sum, r) => sum + r.usage[field]!, 0)
      : null;
  const prompt = total("promptTokens");
  const completion = total("completionTokens");
  const reasoning = total("reasoningTokens");
  return {
    runId,
    outcome,
    totalDurationMs: start === undefined ? null : Date.now() - start,
    calls: {
      workingTurns: records.filter((r) => r.purpose === "working_turn").length,
      delegated: records.filter((r) => r.purpose === "delegated").length,
      classification: records.filter((r) => r.purpose === "classification").length,
      total: records.length,
    },
    inferenceDurationMs: records.reduce((a, r) => a + r.durationMs, 0),
    tokens: {
      source: records.length === 0 || withUsage.length === 0 ? "unavailable" : withUsage.length === records.length && withUsage.every((r) => r.usage.source === "provider") ? "provider" : "partial",
      prompt, completion, reasoning,
      reasoningShareOfCompletion: completion !== null && reasoning !== null && completion > 0 ? reasoning / completion : null,
    },
    perCall: records.map((r) => ({ purpose: r.purpose, durationMs: r.durationMs, ttftMs: r.ttftMs, finishReason: r.finishReason, usage: r.usage, toolCallNames: r.toolCallNames })),
  };
}

/** Persist the aggregate once a run reaches a terminal state. */
export function finalizeRunTelemetry(runId: string, outcome: string): void {
  try {
    const summary = summarizeRunTelemetry(runId, outcome);
    writeFileSync(path.join(path.dirname(telemetryPath(runId)), "run-telemetry-summary.json"), JSON.stringify(summary, null, 2));
  } catch (e) {
    console.warn("[telemetry] failed to finalize run summary:", e instanceof Error ? e.message : String(e));
  }
  runStarts.delete(runId);
}
