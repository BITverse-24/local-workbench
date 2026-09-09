export type TaskType = "vision" | "draft" | "code";

export type ModelRuntime = "mlx-lm" | "llama-server" | "openrouter" | "ollama";

export type ModelId =
  | "vision-qwen25vl"
  | "draft-qwen3"
  | "code-qwen25coder";

export type ModelCapability =
  | "text"
  | "image-input"
  | "structured-output"
  | "code-generation";

export interface ModelRegistryEntry {
  id: ModelId;
  taskTypes: TaskType[];
  runtime: ModelRuntime;
  baseUrl: string;
  model: string;
  capabilities: ModelCapability[];
  requestTimeoutMs: number;
  healthPath: "/models";
  apiKeyEnv?: string;
  enabled: boolean;
  maxOutputTokens?: number;
}

export type ResponseFormat = "vision-result" | "draft-result" | "chat-result" | "code-result" | "code-summary";

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}
