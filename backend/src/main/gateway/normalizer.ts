import type { AIError, ModelRequest, ModelResponse } from "../../shared/contracts.js";
export function parseProviderContent(content: unknown): unknown {
  if (typeof content !== "string" || content.trim() === "") throw new Error("empty model response");
  let clean = content.trim();
  // Strip markdown fences and leading HTML/comment junk that small models emit.
  clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/g, "");
  clean = clean.replace(/^[\s\S]*?(?=\{)/, "").trim();
  // Remove trailing non-JSON tail (e.g. "</body> <sections>").
  const lastBrace = clean.lastIndexOf("}");
  if (lastBrace !== -1) clean = clean.slice(0, lastBrace + 1);
  // First try direct parse, then fallback to extracting the largest JSON object.
  try {
    return JSON.parse(clean);
  } catch (firstError) {
    const firstBrace = content.indexOf("{");
    const last = content.lastIndexOf("}");
    if (firstBrace !== -1 && last !== -1 && last > firstBrace) {
      const extracted = content.slice(firstBrace, last + 1);
      try {
        return JSON.parse(extracted);
      } catch {}
      // Try unwrapping escaped inner JSON (model double-stringifies).
      try {
        const unwrapped = JSON.parse(`"${extracted.replace(/"/g, '\\"')}"`);
        if (typeof unwrapped === "string") return JSON.parse(unwrapped);
      } catch {}
    }
    throw firstError;
  }
}
export function providerError(error: unknown, request: ModelRequest): AIError {
  const message = error instanceof Error ? error.message : "model request failed";
  const code = /timeout|aborted/i.test(message) ? "model_timeout" : /empty/i.test(message) ? "empty_model_response" : /unavailable|fetch|network|ECONN/i.test(message) ? "model_unavailable" : "model_rejected_request";
  return { kind: "ai-error", code, message: message.slice(0, 500), retryable: code === "model_timeout" || code === "model_unavailable", requestId: request.requestId, runId: request.runId, taskType: request.taskType, modelId: request.modelId };
}
export function normalizeResponse(value: unknown, request: ModelRequest): ModelResponse {
  // Some OpenAI-compatible providers return the JSON response as a JSON
  // string for simple chat turns, even when response_format=json_object was
  // requested. Preserve the content as a valid typed chat result; structured
  // code/vision responses remain strict objects below.
  if (typeof value === "string" && request.responseFormat === "chat-result") {
    const text = value.replace(/^>\s*\/\/\s*/, "").replace(/\s*\/\/\s*$/, "").trim();
    if (text) {
      return { requestId: request.requestId, runId: request.runId, modelId: request.modelId, taskType: request.taskType, completedAt: new Date().toISOString(), result: { text } } as ModelResponse;
    }
  }
  if (!value || typeof value !== "object") throw new Error("invalid model response");
  const raw = value as Record<string, unknown>;
  const result = raw.result ?? value;
  return { requestId: request.requestId, runId: request.runId, modelId: request.modelId, taskType: request.taskType, completedAt: new Date().toISOString(), result } as ModelResponse;
}
