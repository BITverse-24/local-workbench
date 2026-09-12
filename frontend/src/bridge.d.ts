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

type RunState =
  | "created"
  | "classifying"
  | "planning"
  | "acting"
  | "awaiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled";

interface AttachmentReference {
  attachmentId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  relativePath: string;
}

interface ArtifactRef {
  artifactId: string;
  runId: string;
  kind: "docx" | "pdf" | "xlsx" | "csv" | "txt" | "json" | "md";
  filename: string;
  relativePath: string;
  sizeBytes: number;
  createdAt: string;
  content?: string;
  isBinary?: boolean;
}

interface PendingAction {
  actionId: string;
  runId: string;
  kind: "generate_docx" | "execute_python" | "generate_xlsx";
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

type RunEvent =
  | { type: "run_state"; runId: string; state: RunState }
  | { type: "routing"; runId: string; taskType: "vision" | "draft" | "code"; modelId: string; reason: string }
  | { type: "plan_step"; runId: string; index: number; text: string }
  | { type: "tool_call"; runId: string; tool: string; summary: string }
  | { type: "tool_result"; runId: string; tool: string; summary: string }
  | { type: "confirmation_required"; runId: string; action: PendingAction }
  | { type: "artifact_ready"; runId: string; artifact: ArtifactRef }
  | { type: "assistant_message"; runId: string; messageId: string; text: string; modelId: string }
  | { type: "error"; runId: string; code: string; message: string; retryable?: boolean }
  | { type: "grounding_context"; runId: string; status: "retrieving" | "injected" | "skipped"; chunkCount?: number; chunks?: GroundingChunk[] };


interface WorkspaceInfo {
  root: string;
  registeredAt: string;
}

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
}

interface WorkbenchBridge {
  createChat: (input?: { title?: string }) => Promise<{ chatId: string }>;
  getChatHistory: (input?: { limit?: number }) => Promise<{ chats: ChatSummary[] }>;
  archiveChat: (chatId: string) => Promise<void>;
  getMessages: (chatId: string) => Promise<{ messages: PersistedMessage[] }>;
  sendMessage: (chatId: string, role: "user" | "assistant", content: string, attachmentIds?: string[]) => Promise<{ messageId: string; seq: number }>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  getSetting: (key: string) => Promise<{ value: unknown }>;
  setSetting: (key: string, value: unknown) => Promise<void>;
  startRun: (input: { userText: string; attachmentToken?: string; attachmentTokens?: string[]; runId?: string; chatId?: string; temperature?: number; groundingEnabled?: boolean }) => Promise<{ runId: string }>;
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
  openArtifact: (input: { runId: string; artifactId: string }) => Promise<{ opened: true; filename: string }>;
  saveArtifact: (input: { runId: string; artifactId: string }) => Promise<{ saved: boolean; filename?: string }>;
  copyArtifact: (input: { runId: string; artifactId: string }) => Promise<{ copied: boolean; mode: "text" | "file"; filename: string }>;
  getHealth: () => Promise<ModelHealth[]>;
  getRunLogs: (input: { runId: string; limit?: number }) => Promise<{ runId: string; entries: unknown[]; files: string[]; recentFull: unknown }>;
  getRunLogFile: (input: { runId: string; filename: string }) => Promise<{ runId: string; filename: string; content: unknown }>;
  onRunEvent: (listener: (event: RunEvent) => void) => () => void;

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
  readWorkspaceFile: (path: string) => Promise<{ tool: "read_file"; result: string }>;
  searchWorkspace: (query: string, path?: string) => Promise<{ tool: "search"; result: HarnessSearchMatch[] }>;
  writeWorkspaceFile: (path: string, content: string) => Promise<{ tool: "write_file"; result: HarnessWriteResult }>;
  runWorkspaceCommand: (command: string) => Promise<{ tool: "run_command"; result: HarnessCommandResult }>;
  onWorkspaceEvent: (listener: (event: any) => void) => () => void;
}

interface Window {
  electronAPI?: { minimize: () => void; maximize: () => void; close: () => void };
  workbench?: WorkbenchBridge;
}
