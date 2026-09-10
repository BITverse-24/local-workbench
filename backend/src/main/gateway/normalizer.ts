import type { AIError, ModelRequest, ModelResponse } from "../../shared/contracts.js";

export function extractJsonFromText(text: string): unknown | undefined {
  if (typeof text !== "string" || !text.includes("{")) return undefined;
  const candidates: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      let depth = 0;
      for (let j = i; j < text.length; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") {
          depth--;
          if (depth === 0) {
            candidates.push(text.slice(i, j + 1));
            break;
          }
        }
      }
    }
  }

  let fallbackObj: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        if (keys.length > 0) {
          if (
            "text" in parsed ||
            "source" in parsed ||
            "findings" in parsed ||
            "summary" in parsed ||
            "answer" in parsed ||
            "message" in parsed ||
            "reply" in parsed ||
            "response" in parsed
          ) {
            return parsed;
          }
          if (!fallbackObj) fallbackObj = parsed as Record<string, unknown>;
        }
      }
    } catch {}
  }
  return fallbackObj;
}

export function parseProviderContent(content: unknown, reasoning?: unknown): unknown {
  let parsed: unknown = null;
  let parseError: unknown = null;

  if (typeof content === "string" && content.trim() !== "") {
    let clean = content.trim();
    // Strip markdown fences and leading HTML/comment junk that small models emit.
    clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/g, "");
    clean = clean.replace(/^[\s\S]*?(?=\{)/, "").trim();
    // Remove trailing non-JSON tail (e.g. "</body> <sections>").
    const lastBrace = clean.lastIndexOf("}");
    if (lastBrace !== -1) clean = clean.slice(0, lastBrace + 1);
    // First try direct parse, then fallback to extracting the largest JSON object.
    try {
      parsed = JSON.parse(clean);
    } catch (firstError) {
      parseError = firstError;
      const firstBrace = content.indexOf("{");
      const last = content.lastIndexOf("}");
      if (firstBrace !== -1 && last !== -1 && last > firstBrace) {
        const extracted = content.slice(firstBrace, last + 1);
        try {
          parsed = JSON.parse(extracted);
          parseError = null;
        } catch {}
        if (!parsed) {
          // Try unwrapping escaped inner JSON (model double-stringifies).
          try {
            const unwrapped = JSON.parse(`"${extracted.replace(/"/g, '\\"')}"`);
            if (typeof unwrapped === "string") {
              parsed = JSON.parse(unwrapped);
              parseError = null;
            }
          } catch {}
        }
      }
    }
  } else {
    parseError = new Error("empty model response");
  }

  // If parsed is empty object {} (e.g. model output '{\n\n}') or failed to parse,
  // inspect reasoning if provided (common with reasoning models like Qwen 3).
  const isEmptyObj =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed as Record<string, unknown>).length === 0;

  if ((!parsed || isEmptyObj) && typeof reasoning === "string") {
    const fromReasoning = extractJsonFromText(reasoning);
    if (fromReasoning) {
      return fromReasoning;
    }
  }

  if (parseError && !parsed) {
    throw parseError;
  }

  return parsed;
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
  let result = raw.result ?? value;

  // For chat-result, normalize alternative keys and scalar values to { text: string }
  if (request.responseFormat === "chat-result" && result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if (obj.text !== undefined && obj.text !== null) {
      result = { text: String(obj.text).trim() };
    } else {
      const altKeys = ["message", "response", "answer", "reply", "content", "output", "result", "summary", "displayed_text"];
      let found: string | undefined;
      for (const k of altKeys) {
        if (obj[k] !== undefined && obj[k] !== null) {
          found = typeof obj[k] === "object" ? JSON.stringify(obj[k]) : String(obj[k]).trim();
          break;
        }
      }
      if (!found) {
        const keys = Object.keys(obj);
        if (keys.length === 1 && obj[keys[0]] !== undefined && obj[keys[0]] !== null) {
          found = typeof obj[keys[0]] === "object" ? JSON.stringify(obj[keys[0]]) : String(obj[keys[0]]).trim();
        }
      }
      if (found) {
        result = { text: found };
      }
    }
  }

  return { requestId: request.requestId, runId: request.runId, modelId: request.modelId, taskType: request.taskType, completedAt: new Date().toISOString(), result } as ModelResponse;
}

