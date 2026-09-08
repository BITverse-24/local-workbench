import type { AIError, ModelRequest, ModelResponse } from "../../shared/contracts.js";
export function parseProviderContent(content: unknown): unknown {
  if (typeof content !== "string" || content.trim() === "") throw new Error("empty model response");
  const clean = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(clean);
}
export function providerError(error: unknown, request: ModelRequest): AIError {
  const message = error instanceof Error ? error.message : "model request failed";
  const code = /timeout|aborted/i.test(message) ? "model_timeout" : /empty/i.test(message) ? "empty_model_response" : /unavailable|fetch|network|ECONN/i.test(message) ? "model_unavailable" : "model_rejected_request";
  return { kind: "ai-error", code, message: message.slice(0, 500), retryable: code === "model_timeout" || code === "model_unavailable", requestId: request.requestId, runId: request.runId, taskType: request.taskType, modelId: request.modelId };
}
export function normalizeResponse(value: unknown, request: ModelRequest): ModelResponse {
  if (!value || typeof value !== "object") throw new Error("invalid model response");
  const raw = value as Record<string, unknown>;
  const result = raw.result ?? value;
  return { requestId: request.requestId, runId: request.runId, modelId: request.modelId, taskType: request.taskType, completedAt: new Date().toISOString(), result } as ModelResponse;
}
