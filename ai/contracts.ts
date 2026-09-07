export type TaskType = "vision" | "draft" | "code";

export type ModelRuntime = "mlx-lm" | "llama-server" | "openrouter";

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
}

export interface AttachmentReference {
  attachmentId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  relativePath: string;
}

export interface InputFileReference {
  attachmentId: string;
  filename: string;
  mediaType: string;
  columns?: string[];
  rowCount?: number;
}

export type ResponseFormat = "vision-result" | "draft-result" | "code-result";

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
}

export interface VisionModelRequest extends ModelRequestBase {
  taskType: "vision";
  modelId: "vision-qwen25vl";
  responseFormat: "vision-result";
  attachment: AttachmentReference;
  inputMode: "typed-scan";
}

export interface DraftModelRequest extends ModelRequestBase {
  taskType: "draft";
  modelId: "draft-qwen3";
  responseFormat: "draft-result";
  findings: Finding[];
  pageReferences: PageReference[];
  retrievedChunks: RetrievedKnowledgeChunk[];
  templateRequirements: string[];
}

export interface CodeModelRequest extends ModelRequestBase {
  taskType: "code";
  modelId: "code-qwen25coder";
  responseFormat: "code-result";
  task: string;
  inputFile: InputFileReference;
  allowedLanguage: "python";
  executionRules: string[];
}

export type ModelRequest =
  | VisionModelRequest
  | DraftModelRequest
  | CodeModelRequest;

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

export interface ModelResponseBase {
  requestId: string;
  runId: string;
  modelId: ModelId;
  completedAt: string;
  usage?: ModelUsage;
}

export interface VisionModelResponse extends ModelResponseBase {
  taskType: "vision";
  result: VisionResult;
}

export interface DraftModelResponse extends ModelResponseBase {
  taskType: "draft";
  result: DraftResult;
}

export interface CodeModelResponse extends ModelResponseBase {
  taskType: "code";
  result: CodeDraftResult;
}

export type ModelResponse =
  | VisionModelResponse
  | DraftModelResponse
  | CodeModelResponse;

export type Confidence = "high" | "medium" | "low";

export interface PageReference {
  id: string;
  page: number;
  text: string;
  location?: string;
}

export interface Finding {
  findingId: string;
  title: string;
  value: string;
  pageReferenceIds: string[];
  confidence: Confidence;
  evidence: string;
}

export interface VisionResult {
  sourceText: string;
  findings: Finding[];
  pageReferences: PageReference[];
  warnings?: string[];
}

export interface KnowledgeSectionReference {
  documentId: string;
  sectionId: string;
  label: string;
}

export interface RetrievedKnowledgeChunk extends KnowledgeSectionReference {
  chunkId: string;
  documentTitle: string;
  excerpt: string;
  score?: number;
}

export interface Citation extends KnowledgeSectionReference {
  inlineText: string;
  supportingExcerpt?: string;
}

export type ApprovalNoteSectionId =
  | "equipment-header"
  | "findings-summary"
  | "recommendation"
  | "grounding-references";

export interface ApprovalNoteSection {
  id: ApprovalNoteSectionId;
  heading: string;
  body: string;
}

export interface MissingInformation {
  field: string;
  note: string;
}

export interface DraftResult {
  title: string;
  body: string;
  sections: ApprovalNoteSection[];
  citations: Citation[];
  missingInformation: MissingInformation[];
}

export type ApprovalNoteDraft = DraftResult;

export interface CodeDraftResult {
  filename: "task.py";
  source: string;
  expectedResult: string;
  inputFiles: string[];
  outputFiles: string[];
  allowedImports: string[];
}

export interface PythonExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputFiles: string[];
  durationMs: number;
}

export interface CitationValidationResult {
  valid: boolean;
  invalidCitations: Citation[];
}

export type AIErrorCode =
  | "model_unavailable"
  | "model_timeout"
  | "model_rejected_request"
  | "empty_model_response"
  | "invalid_model_response"
  | "unsupported_task"
  | "no_knowledge_match"
  | "unsupported_citation"
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
