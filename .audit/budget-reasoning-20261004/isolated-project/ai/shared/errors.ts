import type { ModelId, TaskType } from "./types";

export type AIErrorCode =
  | "model_unavailable"
  | "model_timeout"
  | "model_rejected_request"
  | "empty_model_response"
  | "invalid_model_response"
  | "unsupported_task"
  | "missing_required_content"
  | "unsafe_generated_code";

export interface AIError {
  kind: "ai-error";
  code: AIErrorCode;
  message: string;
  retryable: boolean;
  requestId?: string;
  runId?: string;
  taskType?: TaskType;
  modelId?: ModelId;
}

export interface ValidationFailure {
  kind: "validation-failure";
  code: "wrong-type" | "missing-field" | "invalid-value" | "extra-field";
  message: string;
  path: string;
  expected: string;
  received?: string;
  requestId?: string;
}

export type AIWorkflowError = AIError | ValidationFailure;

export type AIResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AIWorkflowError };
