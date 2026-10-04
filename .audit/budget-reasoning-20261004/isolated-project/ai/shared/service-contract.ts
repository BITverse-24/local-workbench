import type { ModelId, ModelUsage, ResponseFormat, TaskType } from "./types";

export interface ModelRequestBase {
  requestId: string;
  runId: string;
  taskType: TaskType;
  modelId: ModelId;
  systemPrompt: string;
  userPrompt: string;
  responseFormat: ResponseFormat;
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelResponseBase {
  requestId: string;
  runId: string;
  modelId: ModelId;
  completedAt: string;
  usage?: ModelUsage;
}

export interface ServiceIdentity {
  service: string;
  modelId: ModelId;
  taskTypes: TaskType[];
}

export interface ModelHealth {
  modelId: ModelId;
  reachable: boolean;
  checkedAt: string;
  latencyMs?: number;
  message?: string;
}
