export type TaskType = "vision" | "draft" | "code";
export type ModelRuntime = "mlx-lm" | "llama-server" | "ollama";
/** One configured inference model drives all semantic task types. */
export type ModelId = string;
export type ModelCapability = "text" | "image-input" | "structured-output" | "code-generation";
export interface ModelRegistryEntry { id: ModelId; /** Legacy config compatibility only; task semantics no longer select model endpoints. */ taskTypes?: TaskType[]; runtime: ModelRuntime; baseUrl: string; model: string; capabilities: ModelCapability[]; requestTimeoutMs: number; healthPath: "/models"; apiKeyEnv?: string; enabled: boolean; /** Auxiliary endpoint used only when a tool needs its capabilities. */ fallbackOnly?: boolean; maxOutputTokens?: number; contextLength?: number; toolCallingFormat?: "native" | "json"; temperature?: number; }
export interface AttachmentReference { attachmentId: string; filename: string; mediaType: string; sizeBytes: number; relativePath: string; selectedPages?: number[]; sourcePath?: string; }
export interface ChatTitleEvent { type: "chat_title_changed"; chatId: string; title: string; revision: number }
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
  purpose?: "intent_classification";
  reasoningEffort?: "none";
  responseSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  history?: ModelConversationMessage[];
  onChunk?: (delta: string) => void;
  parentToolCallId?: string;
  isRetry?: boolean;
}
export interface VisionModelRequest extends ModelRequestBase { taskType: "vision"; modelId: ModelId; responseFormat: "vision-result"; attachment: AttachmentReference; inputMode: "typed-scan"; }
export interface CodeModelRequest extends ModelRequestBase { taskType: "code"; modelId: ModelId; responseFormat: "code-result" | "file-result" | "harness-step"; task: string; inputFile: InputFileReference; allowedLanguage: "python"; executionRules: string[]; }
export interface CodeSummarizeRequest extends ModelRequestBase { taskType: "code"; modelId: ModelId; responseFormat: "code-summary"; phase: "summarize"; execution: PythonExecutionResult; task: string; }
export interface ChatModelRequest extends ModelRequestBase { taskType: "draft"; modelId: ModelId; responseFormat: "chat-result"; }
export interface DraftModelRequest extends ModelRequestBase { taskType: "draft"; modelId: ModelId; responseFormat: "draft-result"; }
export type ModelRequest = VisionModelRequest | CodeModelRequest | CodeSummarizeRequest | ChatModelRequest | DraftModelRequest;
export interface ModelUsage { inputTokens?: number; outputTokens?: number; durationMs?: number; }
export interface ModelResponseBase { requestId: string; runId: string; modelId: ModelId; completedAt: string; usage?: ModelUsage; }
export interface VisionModelResponse extends ModelResponseBase { taskType: "vision"; result: VisionResult; }
export interface CodeModelResponse extends ModelResponseBase { taskType: "code"; result: CodeDraftResult | CodeSummaryResult; }
export interface ChatModelResponse extends ModelResponseBase { taskType: "draft"; result: ChatResult; }
export type ModelResponse = VisionModelResponse | CodeModelResponse | ChatModelResponse;
export type Confidence = "high" | "medium" | "low";
export interface PageReference { id: string; page: number; text: string; location?: string; }
export interface Finding { findingId: string; title: string; value: string; pageReferenceIds: string[]; confidence: Confidence; evidence: string; }
export interface VisionResult { sourceText: string; findings: Finding[]; pageReferences: PageReference[]; warnings?: string[]; }
export type ApprovalNoteSectionId = "equipment-header" | "findings-summary" | "recommendation";
export interface ApprovalNoteSection { id: ApprovalNoteSectionId; heading: string; body: string; }
export interface MissingInformation { field: string; note: string; }
export interface DraftResult { title: string; body: string; sections: ApprovalNoteSection[]; missingInformation: MissingInformation[]; }
export interface CodeDraftResult { filename: "task.py"; source: string; expectedResult: string; inputFiles: string[]; outputFiles: string[]; allowedImports: string[]; outputMode?: OutputMode; artifactKind?: ArtifactKind; artifactFilename?: string; artifactRationale?: string; }
export interface PythonExecutionResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; outputFiles: string[]; durationMs: number; capturedOutput?: { stdout: string; stderr: string; truncated: boolean }; }
export interface CodeSummaryResult { summary: string; verified: boolean; }
export type AIErrorCode = "model_unavailable" | "model_timeout" | "model_rejected_request" | "empty_model_response" | "invalid_model_response" | "unsupported_task" | "missing_required_content" | "unsafe_generated_code";
export interface AIError { kind: "ai-error"; code: AIErrorCode; message: string; retryable: boolean; requestId?: string; runId?: string; taskType?: TaskType; modelId?: ModelId; }
export interface ValidationFailure { kind: "validation-failure"; code: "wrong-type" | "missing-field" | "invalid-value" | "extra-field"; message: string; path: string; expected: string; received?: string; requestId?: string; }
export type AIWorkflowError = AIError | ValidationFailure;
export type AIResult<T> = { ok: true; value: T } | { ok: false; error: AIWorkflowError };
export type ToolName =
  | "read_file"
  | "draft_note"
  | "draft_code"
  | "execute_python"
  | "generate_xlsx"
  | "retrieve_sop"
  | "retrieve_knowledge"
  | "inspect_drawing"
  | "list_dir"
  | "search"
  | "write_file"
  | "delete_file"
  | "run_command"
  | "extract_document"
  | "generate_deliverable"
  | "retrieve_result"
  | "request_capability"
  | (string & {});

export type ExecutionMode = "chat" | "work" | "agent";

export type CapabilityGroup =
  | "source_access"
  | "document_processing"
  | "result_retrieval"
  | "structured_computation"
  | "artifact_generation"
  | "workspace_mutation"
  | "system_execution";

export interface ExecutionEnvelope {
  schemaVersion: 1;
  runId: string;
  mode: ExecutionMode;
  modelId: ModelId;
  hasWorkspace: boolean;
  workspaceRoot?: string;
  attachments: AttachmentReference[];
  hasVisualAttachments: boolean;
  hasKnowledgeBaseDocs: boolean;
  hasRetrievableResults: boolean;
  outputPreference?: OutputMode;
  permittedCapabilities: CapabilityGroup[];
  activeCapabilities: CapabilityGroup[];
  contextLimit: number;
  authorizationState: {
    planConfirmed: boolean;
    authorizedOperations: string[];
  };
}

export type IntentResolutionStatus = "resolved" | "ambiguous" | "failed";

export interface ExpectedDeliverableSpec {
  filename?: string;
  /** True only when the user or an authoritative contract specified this exact name. */
  filenameRequired?: boolean;
  type: "docx" | "xlsx" | "csv" | "pdf" | "md" | "json" | "file";
  description?: string;
}

export interface OutputExpectation {
  chatResponse: boolean;
  expectedFiles: string[];
  workspaceMutationRequested: boolean;
  targetFiles?: string[];
  expectedDeliverables?: ExpectedDeliverableSpec[];
  protectedPaths?: string[];
  restrictMutationsToTargets?: boolean;
}

// P1: interpreted expectations, never an authorization grant. No raw prompt copy.
export interface ArtifactAcceptanceCheck {
  id: string;
  filename?: string;
  kind: "contains_text" | "heading" | "columns" | "json_key" | "row_count" | "sheet" | "semantic";
  expected: string | number;
  mandatory: boolean;
  /** Exact request or source excerpt that establishes the requirement. */
  basis: string;
}

export interface RunSnapshot {
  runId: string;
  chatId: string;
  mode: ExecutionMode | null;
  engineVersion: string | null;
  state: RunState;
  queued: boolean;
  progress: TaskProgressEvent[];
  pendingAction?: PendingAction;
  artifacts: ArtifactRef[];
  verification?: RunVerificationReport;
  metrics: Record<string, unknown>;
  draft?: { messageId:string; modelId:string; text:string };
}

export interface RunContract {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  objective: string;
  resolution: { status: IntentResolutionStatus; ambiguity?: string };
  routing: { intentType: string; taskType: TaskType; driverModel: ModelId; actionable: boolean };
  response: { required: boolean; chatOnly: boolean };
  workspace: { requested: boolean; operations: ExpectedWorkspaceOperation[] };
  deliverables: Array<ExpectedDeliverableSpec & { id: string }>;
  constraints: { protectedPaths: string[]; restrictMutationsToTargets: boolean; userConstraints: string[] };
  acceptance: { validateWrittenCode: boolean; validatedPythonDeliverables: string[]; successMarker?: string; artifactChecks?: ArtifactAcceptanceCheck[] };
}

export interface ExpectedWorkspaceOperation {
  id: string;
  operation: "mutate" | "write" | "delete" | "execute";
  targetPath?: string;
  /** Backend-resolved immutable source; never supplied by intent classification. */
  sourceId?: string;
  sourceSha256?: string;
}

export type IntermediateResultType = "text" | "document" | "table" | "structured" | "execution";
export type ResultOrigin = "source_extracted" | "model_derived" | "execution";
export interface SourceReference {
  filename?: string;
  resultId?: string;
  page?: number;
  section?: string;
  sheet?: string;
  range?: string;
  textSpan?: { start: number; end: number };
  locator?: string;
  relation: "source" | "input";
}
export interface IntermediateResultRecord {
  schemaVersion: 1;
  resultId: string;
  runId: string;
  type: IntermediateResultType;
  status: "complete" | "partial";
  origin: ResultOrigin;
  createdAt: string;
  producer: { tool: string; callId: string };
  storage: { relativePath: string; encoding: "utf8" | "json"; sizeBytes: number; sha256: string };
  summary: string;
  structuredSchema?: Record<string, unknown>;
  sources: SourceReference[];
}
export interface IntermediateResultInput {
  type: IntermediateResultType;
  status: "complete" | "partial";
  origin: ResultOrigin;
  producer: { tool: string; callId: string };
  summary: string;
  payload: string | Record<string, unknown> | unknown[];
  structuredSchema?: Record<string, unknown>;
  sources?: SourceReference[];
}
export type ResultSliceRequest =
  | { mode: "text"; offset?: number; maxChars?: number }
  | { mode: "lines"; startLine?: number; count?: number; maxChars?: number }
  | { mode: "json"; pointer?: string; start?: number; count?: number; offset?: number; maxChars?: number };
export interface ResultSlice {
  resultId: string;
  content: string;
  truncated: boolean;
  nextOffset?: number;
  nextLine?: number;
  nextStart?: number;
  totalChars: number;
}

export type AgentOutcome =
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "limit_exceeded";

export type RunState =
  | "created"
  | "classifying"
  | "planning"
  | "acting"
  | "awaiting_confirmation"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "limit_exceeded";
export interface PendingAction { actionId: string; runId: string; kind: "generate_docx" | "execute_python" | "generate_xlsx" | "plan_approval" | "uncontained_python"; prompt: string; createdAt: string; expiresAt: string; preview?: string; }
export interface ArtifactRef { artifactId: string; runId: string; kind: ArtifactKind; filename: string; relativePath: string; sizeBytes: number; sha256?: string; createdAt: string; content?: string; isBinary?: boolean; verified?: boolean; verificationDetails?: Record<string, unknown>; }
export type VerificationStatus = "passed" | "failed" | "unverified" | "not_applicable" | "skipped";
export interface VerificationEvidenceRef { kind: "result" | "artifact" | "execution" | "message"; id: string; }
export interface VerificationTermination { reason: string; criterionIds: string[]; detail: string; nextAction?: string; }
export interface VerificationPlan {
  id: string; kind: "agent_tests" | "semantic_review" | "python_behavior"; revision: string; criterionIds: string[];
  command?: string; targets?: string[]; runner?: string;
}
export interface VerificationAttempt {
  id: string; planId: string; revision: string; status: "running" | "passed" | "failed" | "unverified";
  startedAt: string; completedAt?: string; resultId?: string; reason?: string;
}
export interface RunVerificationState {
  schemaVersion: 1; phase: "pending" | "planning" | "running" | "repairing" | "complete" | "blocked";
  plans: VerificationPlan[]; attempts: VerificationAttempt[]; evidence: VerificationCheck[];
  repairCount: number; fullSuiteRevisions: string[];
  userSkip?: { basis: string; recordedAt: string }; termination?: VerificationTermination;
}
export interface VerificationCheck {
  criterionId: string;
  requirement: string;
  status: VerificationStatus;
  method: "sha256" | "result_store_checksum" | "format_parser" | "filesystem" | "execution_record" | "agent_loop_completion" | "content_check" | "independent_reader" | "message_record";
  evidence: VerificationEvidenceRef[];
  reason: string;
  verifiedAt: string;
  mandatory: boolean;
  revision?: string;
  planId?: string;
  sourceManifest?: Record<string, string | null>;
  waiver?: { basis: string; recordedAt: string };
}
export interface RunVerificationReport {
  schemaVersion: 1;
  runId: string;
  status: VerificationStatus;
  checks: VerificationCheck[];
  updatedAt: string;
  termination?: VerificationTermination;
  attempts?: { verification: number; repairs: number; modelCalls: number; recoveries: number };
}
export interface GroundingChunk {
  chunkId: string;
  docId: string;
  sectionLabel: string;
  sectionTitle?: string;
  text: string;
  page: number;
  score: number;
}
export interface CompactionMetadata {
  truncated: boolean;
  originalChars: number;
  retainedChars: number;
  toolName?: string;
  source?: string;
  omittedChars?: number;
  omittedLines?: number;
  reason?: string;
  resultId?: string;
}

export type RunEvent =
  | ModelProgressEvent
  | TaskProgressEvent
  | { type: "run_registered"; runId: string; chatId: string; mode: ExecutionMode }
  | { type: "run_queue"; runId: string; queued: boolean; queueWaitMs?: number }
  | { type: "run_state"; runId: string; state: RunState }
  | { type: "verification_report"; runId: string; report: RunVerificationReport }
  | { type: "routing"; runId: string; taskType?: TaskType; modelId: ModelId; reason: string; tier?: "text" | "vision"; tokensSaved?: number; providerEndpoint?: string }
  | { type: "plan_step"; runId: string; index: number; text: string }
  | { type: "agent_thinking"; runId: string; text: string; turn?: number }
  | { type: "tool_call"; runId: string; tool: ToolName; summary: string; callId?: string; args?: Record<string, unknown> }
  | { type: "tool_result"; runId: string; tool: ToolName; summary: string; callId?: string; output?: string; durationMs?: number; ok?: boolean; error?: ToolErrorDetail }
  | { type: "context_compaction"; runId: string; metadata: CompactionMetadata }
  | { type: "confirmation_required"; runId: string; action: PendingAction }
  | { type: "artifact_ready"; runId: string; artifact: ArtifactRef }
  | { type: "assistant_message_chunk"; runId: string; messageId: string; delta: string; modelId: ModelId }
  | { type: "assistant_message_reset"; runId: string; messageId: string }
  | { type: "assistant_message"; runId: string; messageId: string; text: string; modelId: ModelId }
  | { type: "error"; runId: string; code: string; message: string; retryable?: boolean }
  | { type: "grounding_context"; runId: string; status: "retrieving" | "injected" | "skipped"; chunkCount?: number; chunks?: GroundingChunk[] }
  | { type: "delegated_model_invocation"; runId: string; parentCallId?: string; modelId: ModelId | string; taskType: TaskType; purpose?: string; isRetry?: boolean; latencyMs: number; promptTokens: number; outputTokens: number; totalTokens: number }
  | { type: "capability_expanded"; runId: string; capability: CapabilityGroup; permitted: boolean; reason?: string };
/** Runtime checkpoints, separate from model output and acceptance decisions. */
export interface TaskProgressEvent {
  type: "task_progress";
  runId: string;
  activityId: string;
  stage: "source_inspection" | "repair_generation" | "draft_generation" | "pre_execution_review" | "post_execution_review" | "source_coverage_review" | "correction" | "result_verification" | "requirements" | "input_preparation" | "artifact_generation" | "delivery";
  status: "active" | "completed" | "blocked";
  target?: string;
  parentCallId?: string;
  /** Nested work does not count as an additional parallel task. */
  parentActivityId?: string;
  /** Complete, parsed, index-matched assessments; never a pass count. */
  assessedChecks?: number;
  totalChecks?: number;
  /** Runtime stop reason, never a partial model response. */
  reason?: string;
}

/** Transient generation activity. Never contains reasoning, JSON, or tool arguments. */
export interface ModelProgressEvent {
  type: "model_progress";
  runId: string;
  requestId: string;
  modelId: ModelId;
  purpose: string;
  parentCallId?: string;
  status: "waiting" | "receiving" | "received" | "failed";
  channel: "text" | "reasoning" | "tool_arguments" | "structured";
  outputChars: number;
  /** Bounded visible text from a draft/summary request, separate from the final answer. */
  preview?: string;
}
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
  isolationStatus?: "os_isolated" | "unisolated";
  isolationMessage?: string;
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
export type ModelRoleType = "primary" | "vision" | "coding" | "draft" | "embedding";

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


// ── Local Workbench v2 Unified Agent Tool Contracts ────────────────────

export interface FunctionToolParameterProperty {
  format?: "multiline";
  minItems?: number;
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
  /** Provider termination reason; `length` means output may be incomplete and is never dispatchable. */
  finishReason?: string | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
  };
}

export type ToolErrorCode =
  | "invalid_arguments"
  | "permission_denied"
  | "file_not_found"
  | "timeout"
  | "sandbox_failure"
  | "gateway_failure"
  | "validation_failure"
  | "tool_not_found"
  | "persistence_failure"
  | "internal_error";

export interface ToolErrorDetail {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export type ToolResult =
  | {
      ok: true;
      toolName: string;
      data: unknown;
      durationMs: number;
      artifacts?: ArtifactRef[];
      output: string;
      summary: string;
      resultRef?: IntermediateResultRecord;
    }
  | {
      ok: false;
      toolName: string;
      error: ToolErrorDetail;
      durationMs: number;
      artifacts?: ArtifactRef[];
      output: string;
      summary: string;
      resultRef?: IntermediateResultRecord;
    };


export interface ExecutionCapability {
  status: "os_isolated" | "approval_required" | "unavailable";
  message: string;
}
export interface ExecutionCapabilities {
  platform: string;
  workspaceCommands: ExecutionCapability;
  python: ExecutionCapability;
}
