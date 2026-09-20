export type TaskType = "vision" | "draft" | "code" | "plan";
export type ModelRuntime = "mlx-lm" | "llama-server" | "openrouter" | "ollama";
export type ModelId = "vision-qwen25vl" | "draft-qwen3" | "code-qwen25coder" | "plan-qwen3-8b";
export type ModelCapability = "text" | "image-input" | "structured-output" | "code-generation";
export interface ModelRegistryEntry { id: ModelId; taskTypes: TaskType[]; runtime: ModelRuntime; baseUrl: string; model: string; capabilities: ModelCapability[]; requestTimeoutMs: number; healthPath: "/models"; apiKeyEnv?: string; enabled: boolean; maxOutputTokens?: number; }
export interface AttachmentReference { attachmentId: string; filename: string; mediaType: string; sizeBytes: number; relativePath: string; selectedPages?: number[]; }
export interface InputFileReference { attachmentId: string; filename: string; mediaType: string; columns?: string[]; rowCount?: number; }
export type OutputMode = "chat" | "artifact" | "chat_and_artifact";
export type ArtifactKind = "docx" | "pdf" | "xlsx" | "csv" | "txt" | "json" | "md";
export type ResponseFormat =
  | "vision-result"
  | "draft-result"
  | "code-result"
  | "code-summary"
  | "chat-result"
  | "harness-step"
  | "file-result";
export interface ChatResult { text: string; }
export interface ModelConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequestBase {
  requestId: string;
  runId: string;
  taskType: TaskType;
  modelId: ModelId;
  responseFormat: ResponseFormat;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
  maxTokens?: number;
  temperature?: number;
  history?: ModelConversationMessage[];
  devWorkload?: boolean;
  onChunk?: (delta: string) => void;
}
export interface VisionModelRequest extends ModelRequestBase { taskType: "vision"; modelId: "vision-qwen25vl"; responseFormat: "vision-result"; attachment: AttachmentReference; inputMode: "typed-scan"; }
export interface CodeModelRequest extends ModelRequestBase { taskType: "code"; modelId: "code-qwen25coder"; responseFormat: "code-result" | "file-result" | "harness-step"; task: string; inputFile: InputFileReference; allowedLanguage: "python"; executionRules: string[]; }
export interface CodeSummarizeRequest extends ModelRequestBase { taskType: "code"; modelId: "code-qwen25coder"; responseFormat: "code-summary"; phase: "summarize"; execution: PythonExecutionResult; task: string; }
export interface ChatModelRequest extends ModelRequestBase { taskType: "draft"; modelId: "draft-qwen3"; responseFormat: "chat-result"; }
export interface DraftModelRequest extends ModelRequestBase { taskType: "draft"; modelId: "draft-qwen3"; responseFormat: "draft-result"; }
export interface PlanModelRequest extends ModelRequestBase { taskType: "plan"; modelId: "plan-qwen3-8b"; responseFormat: "chat-result"; }
export type ModelRequest = VisionModelRequest | CodeModelRequest | CodeSummarizeRequest | ChatModelRequest | DraftModelRequest | PlanModelRequest;
export interface ModelUsage { inputTokens?: number; outputTokens?: number; durationMs?: number; }
export interface ModelResponseBase { requestId: string; runId: string; modelId: ModelId; completedAt: string; usage?: ModelUsage; }
export interface VisionModelResponse extends ModelResponseBase { taskType: "vision"; result: VisionResult; }
export interface CodeModelResponse extends ModelResponseBase { taskType: "code"; result: CodeDraftResult | CodeSummaryResult; }
export interface ChatModelResponse extends ModelResponseBase { taskType: "draft"; result: ChatResult; }
export interface PlanModelResponse extends ModelResponseBase { taskType: "plan"; result: ChatResult; }
export type ModelResponse = VisionModelResponse | CodeModelResponse | ChatModelResponse | PlanModelResponse;
export type Confidence = "high" | "medium" | "low";
export interface PageReference { id: string; page: number; text: string; location?: string; }
export interface Finding { findingId: string; title: string; value: string; pageReferenceIds: string[]; confidence: Confidence; evidence: string; }
export interface VisionResult { sourceText: string; findings: Finding[]; pageReferences: PageReference[]; warnings?: string[]; }
export type ApprovalNoteSectionId = "equipment-header" | "findings-summary" | "recommendation";
export interface ApprovalNoteSection { id: ApprovalNoteSectionId; heading: string; body: string; }
export interface MissingInformation { field: string; note: string; }
export interface DraftResult { title: string; body: string; sections: ApprovalNoteSection[]; missingInformation: MissingInformation[]; }
export interface CodeDraftResult { filename: "task.py"; source: string; expectedResult: string; inputFiles: string[]; outputFiles: string[]; allowedImports: string[]; outputMode?: OutputMode; artifactKind?: ArtifactKind; artifactFilename?: string; artifactRationale?: string; }
export interface PythonExecutionResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; outputFiles: string[]; durationMs: number; }
export interface CodeSummaryResult { summary: string; verified: boolean; }
export type AIErrorCode = "model_unavailable" | "model_timeout" | "model_rejected_request" | "empty_model_response" | "invalid_model_response" | "unsupported_task" | "missing_required_content" | "unsafe_generated_code";
export interface AIError { kind: "ai-error"; code: AIErrorCode; message: string; retryable: boolean; requestId?: string; runId?: string; taskType?: TaskType; modelId?: ModelId; }
export interface ValidationFailure { kind: "validation-failure"; code: "wrong-type" | "missing-field" | "invalid-value" | "extra-field"; message: string; path: string; expected: string; received?: string; requestId?: string; }
export type AIWorkflowError = AIError | ValidationFailure;
export type AIResult<T> = { ok: true; value: T } | { ok: false; error: AIWorkflowError };
export type RunState = "created" | "classifying" | "planning" | "acting" | "awaiting_confirmation" | "completed" | "failed" | "cancelled";
export type ToolName = "read_file" | "draft_note" | "draft_code" | "execute_python" | "generate_xlsx" | "retrieve_sop" | "inspect_drawing";
export interface PendingAction { actionId: string; runId: string; kind: "generate_docx" | "execute_python" | "generate_xlsx"; prompt: string; createdAt: string; expiresAt: string; preview?: string; }
export interface ArtifactRef { artifactId: string; runId: string; kind: ArtifactKind; filename: string; relativePath: string; sizeBytes: number; createdAt: string; content?: string; isBinary?: boolean; }
export interface GroundingChunk {
  chunkId: string;
  docId: string;
  sectionLabel: string;
  sectionTitle?: string;
  text: string;
  page: number;
  score: number;
}
export type RunEvent =
  | { type: "run_state"; runId: string; state: RunState }
  | { type: "routing"; runId: string; taskType: TaskType; modelId: ModelId; reason: string; tier?: "text" | "vision"; tokensSaved?: number; devWorkload?: boolean; providerEndpoint?: string }
  | { type: "plan_step"; runId: string; index: number; text: string }
  | { type: "agent_thinking"; runId: string; text: string; turn?: number }
  | { type: "tool_call"; runId: string; tool: ToolName; summary: string }
  | { type: "tool_result"; runId: string; tool: ToolName; summary: string }
  | { type: "confirmation_required"; runId: string; action: PendingAction }
  | { type: "artifact_ready"; runId: string; artifact: ArtifactRef }
  | { type: "assistant_message_chunk"; runId: string; messageId: string; delta: string; modelId: ModelId }
  | { type: "assistant_message"; runId: string; messageId: string; text: string; modelId: ModelId }
  | { type: "error"; runId: string; code: string; message: string; retryable?: boolean }
  | { type: "grounding_context"; runId: string; status: "retrieving" | "injected" | "skipped"; chunkCount?: number; chunks?: GroundingChunk[] };
export interface RunSummary { runId: string; chatId: string; state: RunState; createdAt: string; completedAt: string | null; }
export interface ModelHealth { modelId: ModelId | string; port?: number; available: boolean; checkedAt: string; latencyMs?: number; message?: string; }

export interface Subtask {
  id: string;
  type: TaskType;
  description: string;
  dependsOn?: string[];
}
export interface SubtaskPlan {
  tasks: Subtask[];
}

// ── Harness types (HARNESS.md) ──────────────────────────────────────────

export type HarnessToolName = "list_dir" | "read_file" | "search" | "write_file" | "delete_file" | "run_command";

export interface WorkspaceInfo {
  root: string;
  registeredAt: string;
}

export interface HarnessDirEntry {
  name: string;
  type: "file" | "directory";
  size: number;
}

export interface HarnessSearchMatch {
  file: string;
  lineNumber: number;
  matchingLine: string;
}

export interface HarnessWriteResult {
  written: string;
  backedUp: boolean;
  backupPath?: string;
  diff?: string;
}

export interface HarnessDeleteResult {
  deleted: string;
  backedUp: boolean;
  backupPath?: string;
}

export interface HarnessCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export type HarnessToolCall =
  | { tool: "list_dir"; args: { path?: string } }
  | { tool: "read_file"; args: { path: string } }
  | { tool: "search"; args: { query: string; path?: string } }
  | { tool: "write_file"; args: { path: string; content: string } }
  | { tool: "delete_file"; args: { path: string } }
  | { tool: "run_command"; args: { command: string } };

export type HarnessToolResult =
  | { tool: "list_dir"; result: HarnessDirEntry[] }
  | { tool: "read_file"; result: string }
  | { tool: "search"; result: HarnessSearchMatch[] }
  | { tool: "write_file"; result: HarnessWriteResult }
  | { tool: "delete_file"; result: HarnessDeleteResult }
  | { tool: "run_command"; result: HarnessCommandResult };

export type WorkspaceEvent =
  | { type: "workspace_registered"; workspace: WorkspaceInfo }
  | { type: "workspace_deregistered" }
  | { type: "workspace_tree"; entries: HarnessDirEntry[] }
  | { type: "harness_tool_call"; runId: string; tool: HarnessToolName; summary: string }
  | { type: "harness_tool_result"; runId: string; tool: HarnessToolName; summary: string; detail?: string };

// ── Onboarding & Model Configuration Contracts ──────────────────────────
export type ModelRoleType = "vision" | "coding" | "draft" | "plan" | "embedding";

export interface ModelConfigRow {
  role: ModelRoleType;
  modelName: string;
  host: string;
  port: number;
  contextLength: number;
}

export interface ModelEndpointTestResult {
  ok: boolean;
  latencyMs?: number;
  modelFound?: boolean;
  availableModels?: string[];
  error?: string;
}

export interface OnboardingStatus {
  completed: boolean;
  configuredModels?: ModelConfigRow[];
}

export interface DevModeStatus {
  devOpenRouter: boolean;
  hasOpenRouterKey: boolean;
}

// ── Sovereign Workbench v2 Unified Agent Tool Contracts ────────────────────

export interface FunctionToolParameterProperty {
  type: string;
  description?: string;
  enum?: readonly string[] | string[];
  items?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  required?: readonly string[] | string[];
}

export interface FunctionToolParameters {
  type: "object";
  properties: Record<string, FunctionToolParameterProperty>;
  required?: readonly string[] | string[];
}

export interface AgentFunctionDefinition {
  name: string;
  description: string;
  parameters: FunctionToolParameters;
}

export interface AgentToolDefinition {
  type: "function";
  function: AgentFunctionDefinition;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentTurnResponse {
  content: string | null;
  tool_calls: AgentToolCall[] | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
  };
}
