// Renderer-facing shared declarations (frontend/src/bridge.d.ts).
// These describe the typed preload bridge and domain shapes only: no Node
// APIs, no Electron imports, no model URLs, no filesystem handles.

interface ChatSummary {
  id: string;
  title: string;
  updated_at: string;
}

interface PersistedMessage {
  id: string;
  chat_id: string;
  run_id: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  model_id: string | null;
  created_at: string;
  edited_at: string | null;
  seq: number;
  artifacts?: ArtifactRef[];
  attachments?: AttachmentReference[];
}

interface OutputExpectation {
  chatResponse: boolean;
  expectedFiles: string[];
  workspaceMutationRequested: boolean;
}

type AgentOutcome =
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "limit_exceeded";

type RunState =
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

interface AttachmentReference {
  sourcePath?: string;
  attachmentId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  relativePath: string;
}

interface VerificationCheck {
  criterionId: string;
  requirement: string;
  status: "passed" | "failed" | "unverified" | "not_applicable";
  method: "sha256" | "result_store_checksum" | "format_parser" | "filesystem" | "execution_record" | "agent_loop_completion" | "content_check" | "independent_reader";
  evidence: Array<{ kind: "result" | "artifact" | "execution"; id: string }>;
  reason: string;
  verifiedAt: string;
  mandatory: boolean;
}
interface RunVerificationReport {
  schemaVersion: 1;
  runId: string;
  status: "passed" | "failed" | "unverified" | "not_applicable";
  checks: VerificationCheck[];
  updatedAt: string;
}

interface ArtifactRef {
  artifactId: string;
  runId: string;
  kind: "docx" | "pdf" | "xlsx" | "csv" | "txt" | "json" | "md";
  filename: string;
  relativePath: string;
  sizeBytes: number;
  sha256?: string;
  createdAt: string;
  content?: string;
  isBinary?: boolean;
  verified?: boolean;
  verificationDetails?: Record<string, unknown>;
}

interface PendingAction {
  actionId: string;
  runId: string;
  kind: "generate_docx" | "execute_python" | "generate_xlsx" | "plan_approval" | "uncontained_python";
  prompt: string;
  createdAt: string;
  expiresAt: string;
  preview?: string;
}

interface RunSummary {
  runId: string;
  chatId: string;
  state: RunState;
  createdAt: string;
  completedAt: string | null;
}

interface ModelHealth {
  modelId: string;
  port?: number;
  available: boolean;
  checkedAt: string;
  latencyMs?: number;
  message?: string;
}

interface GroundingChunk {
  chunkId: string;
  docId: string;
  sectionLabel: string;
  sectionTitle?: string;
  text: string;
  page: number;
  score: number;
}

interface DocumentRecord {
  doc_id: string;
  title: string;
  source_path: string;
  doc_type: string;
  department: string;
  effective_date: string;
  indexed_at: string;
  page_count: number;
  ocr_used: boolean;
  chunk_count?: number;
}

interface RetrievalResult {
  chunk_id: string;
  text: string;
  doc_id: string;
  section_label: string;
  page: number;
  score: number;
}

interface RAGStats {
  docCount: number;
  chunkCount: number;
  initialized: boolean;
}

interface ModelProgressEvent {
  type: "model_progress";
  runId: string;
  requestId: string;
  modelId: string;
  purpose: string;
  parentCallId?: string;
  status: "waiting" | "receiving" | "received" | "failed";
  channel: "text" | "reasoning" | "tool_arguments" | "structured";
  outputChars: number;
  preview?: string;
}

type TaskProgressEvent = import("../../backend/src/shared/contracts.js").TaskProgressEvent;

type RunSnapshot = import("../../backend/src/shared/contracts.js").RunSnapshot;
type ExecutionMode = import("../../backend/src/shared/contracts.js").ExecutionMode;
type RunEvent =
  | {type:"run_registered";runId:string;chatId:string;mode:ExecutionMode}
  | {type:"run_queue";runId:string;queued:boolean;queueWaitMs?:number}
  | ModelProgressEvent
  | TaskProgressEvent
  | { type: "run_state"; runId: string; state: RunState }
  | { type: "verification_report"; runId: string; report: RunVerificationReport }
  | { type: "routing"; runId: string; taskType?: "vision" | "draft" | "code"; modelId: string; reason: string; tier?: "text" | "vision" }
  | { type: "plan_step"; runId: string; index: number; text: string }
  | { type: "agent_thinking"; runId: string; text: string; turn?: number }
  | { type: "tool_call"; runId: string; tool: string; summary: string; callId?: string; args?: Record<string, unknown> }
  | { type: "tool_result"; runId: string; tool: string; summary: string; callId?: string; output?: string; durationMs?: number; ok?: boolean; error?: { code: string; message: string; retryable: boolean; details?: unknown } }
  | { type: "context_compaction"; runId: string; metadata: { truncated: boolean; originalChars: number; retainedChars: number; toolName?: string; source?: string; omittedChars?: number; omittedLines?: number; reason?: string } }
  | { type: "confirmation_required"; runId: string; action: PendingAction }
  | { type: "artifact_ready"; runId: string; artifact: ArtifactRef }
  | { type: "assistant_message_chunk"; runId: string; messageId: string; delta: string; modelId: string }
  | { type: "assistant_message_reset"; runId: string; messageId: string }
  | { type: "assistant_message"; runId: string; messageId: string; text: string; modelId: string }
  | { type: "error"; runId: string; code: string; message: string; retryable?: boolean }
  | { type: "grounding_context"; runId: string; status: "retrieving" | "injected" | "skipped"; chunkCount?: number; chunks?: GroundingChunk[] }
  | { type: "capability_expanded"; runId: string; capability: string; permitted: boolean; reason?: string };


interface WorkspaceInfo {
  root: string;
  registeredAt: string;
}
interface WorkspaceReference { path: string; kind: "file" | "directory" }
interface ChatTitleEvent { type: "chat_title_changed"; chatId: string; title: string; revision: number }

interface HarnessDirEntry {
  name: string;
  type: "file" | "directory";
  size: number;
}

interface HarnessSearchMatch {
  file: string;
  lineNumber: number;
  matchingLine: string;
}

interface HarnessWriteResult {
  written: string;
  backedUp: boolean;
  backupPath?: string;
  diff?: string;
}

interface HarnessCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  isolationStatus?: "os_isolated" | "unisolated";
  isolationMessage?: string;
}

interface WorkbenchBridge {
  createChat: (input?: { title?: string }) => Promise<{ chatId: string }>;
  getChatHistory: (input?: { limit?: number }) => Promise<{ chats: ChatSummary[] }>;
  archiveChat: (chatId: string) => Promise<void>;
  getMessages: (chatId: string) => Promise<{ messages: PersistedMessage[] }>;
  sendMessage: (chatId: string, role: "user" | "assistant", content: string, attachmentIds?: string[]) => Promise<{ messageId: string; seq: number; chatTitle?: ChatTitleEvent }>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  getSetting: (key: string) => Promise<{ value: unknown }>;
  setSetting: (key: string, value: unknown) => Promise<void>;
  getRunSnapshot: (input:{chatId?:string;runId?:string}) => Promise<RunSnapshot | undefined>;
  startRun: (input: { userText: string; attachmentToken?: string; attachmentTokens?: string[]; runId?: string; chatId?: string; temperature?: number; groundingEnabled?: boolean; preferredRoute?: string; selectedModel?: string; mode?: "chat" | "work" | "agent"; workspaceIdentity?: WorkspaceInfo; workspaceReferences?: WorkspaceReference[] }) => Promise<{ runId: string }>;
  resumeRun: (input: { runId: string; largerGenerationAllowance?: boolean }) => Promise<{ runId: string }>;
  registerAttachment: (input: {
    chatId?: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    base64OrBuffer: string;
  }) => Promise<{ runId: string; attachment: AttachmentReference }>;
  confirmAction: (input: { runId: string; actionId: string; approved: boolean }) => Promise<void>;
  cancelRun: (input: { runId: string }) => Promise<void>;
  getRunHistory: (input?: { limit?: number }) => Promise<RunSummary[]>;
  getArtifact: (input: { runId: string; artifactId: string }) => Promise<ArtifactRef>;
  getVerificationReport: (input: { runId: string }) => Promise<RunVerificationReport | undefined>;
  openArtifact: (input: { runId: string; artifactId: string }) => Promise<{ opened: true; filename: string }>;
  saveArtifact: (input: { runId: string; artifactId: string }) => Promise<{ saved: boolean; filename?: string }>;
  copyArtifact: (input: { runId: string; artifactId: string }) => Promise<{ copied: boolean; mode: "text" | "file"; filename: string }>;
  getExecutionCapabilities: () => Promise<ExecutionCapabilities>;
  getHealth: () => Promise<ModelHealth[]>;
  getRunLogs: (input: { runId: string; limit?: number }) => Promise<{ runId: string; entries: unknown[]; files: string[]; recentFull: unknown }>;
  getRunLogFile: (input: { runId: string; filename: string }) => Promise<{ runId: string; filename: string; content: unknown }>;
  onRunEvent: (listener: (event: RunEvent) => void) => () => void;
  onChatEvent: (listener: (event: ChatTitleEvent) => void) => () => void;

  // Knowledge base APIs
  kbListDocs: () => Promise<DocumentRecord[]>;
  kbIngestDoc: (input: {
    doc_id: string;
    title: string;
    source_path: string;
    doc_type?: string;
    department?: string;
    effective_date?: string;
    page_count?: number;
    ocr_used?: boolean;
  }) => Promise<{ ok: boolean; docId: string; chunkCount: number }>;
  kbIngestFile: (file: File, input: Omit<Parameters<WorkbenchBridge["kbIngestDoc"]>[0], "source_path">) => Promise<{ ok: boolean; docId: string; chunkCount: number }>;
  kbDeleteDoc: (docId: string) => Promise<{ ok: boolean; docId: string }>;
  kbReindex: (docId?: string) => Promise<{ ok: boolean; chunksIndexed: number }>;
  kbQuery: (text: string, topK?: number) => Promise<{ ok: boolean; results: RetrievalResult[] }>;
  kbStats: () => Promise<RAGStats>;


  // Workspace harness APIs
  pickWorkspaceFolder: () => Promise<string | null>;
  registerWorkspace: (dirPath: string) => Promise<WorkspaceInfo>;
  deregisterWorkspace: () => Promise<{ ok: boolean }>;
  getCurrentWorkspace: () => Promise<WorkspaceInfo | null>;
  listWorkspaceDir: (path?: string) => Promise<{ tool: "list_dir"; result: HarnessDirEntry[] }>;
  suggestWorkspacePaths: (input: { query: string; root: string; registeredAt: string }) => Promise<{ entries: HarnessDirEntry[]; truncated: boolean }>;
  readWorkspaceFile: (path: string) => Promise<{ tool: "read_file"; result: string }>;
  searchWorkspace: (query: string, path?: string) => Promise<{ tool: "search"; result: HarnessSearchMatch[] }>;
  writeWorkspaceFile: (path: string, content: string) => Promise<{ tool: "write_file"; result: HarnessWriteResult }>;
  runWorkspaceCommand: (command: string) => Promise<{ tool: "run_command"; result: HarnessCommandResult }>;
  onWorkspaceEvent: (listener: (event: any) => void) => () => void;

  // Onboarding & Model Configuration APIs
  getOnboardingStatus: () => Promise<OnboardingStatus>;
  saveModelConfig: (models: ModelConfigRow[]) => Promise<{ ok: boolean }>;
  testModelEndpoint: (input: { host: string; port: number; modelName?: string; role?: string }) => Promise<ModelEndpointTestResult>;
  resetOnboarding: () => Promise<{ ok: boolean }>;
}


type ModelRoleType = "primary" | "vision" | "coding" | "draft" | "embedding";

interface ModelConfigRow {
  role: ModelRoleType;
  modelName: string;
  host: string;
  port: number;
  contextLength: number;
}

interface ModelEndpointTestResult {
  ok: boolean;
  latencyMs?: number;
  modelFound?: boolean;
  availableModels?: string[];
  error?: string;
}

interface OnboardingStatus {
  completed: boolean;
  configuredModels?: ModelConfigRow[];
}


interface Window {
  electronAPI?: { minimize: () => void; maximize: () => void; close: () => void };
  workbench?: WorkbenchBridge;
}


interface ExecutionCapability {
  status: "os_isolated" | "approval_required" | "unavailable";
  message: string;
}
interface ExecutionCapabilities {
  platform: string;
  workspaceCommands: ExecutionCapability;
  python: ExecutionCapability;
}
