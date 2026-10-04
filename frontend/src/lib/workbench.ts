export class WorkbenchUnavailable extends Error {
  constructor() {
    super("workbench bridge unavailable (not running inside Electron)");
    this.name = "WorkbenchUnavailable";
  }
}

export function isWorkbenchAvailable(): boolean {
  return typeof window !== "undefined" && !!window.workbench;
}

function bridge(): WorkbenchBridge {
  if (!isWorkbenchAvailable() || !window.workbench) throw new WorkbenchUnavailable();
  return window.workbench;
}

export async function createChat(title?: string): Promise<string> {
  const { chatId } = await bridge().createChat(title ? { title } : {});
  return chatId;
}

export async function getChatHistory(limit = 50): Promise<ChatSummary[]> {
  const { chats } = await bridge().getChatHistory({ limit });
  return chats;
}

export async function archiveChat(chatId: string): Promise<void> {
  await bridge().archiveChat(chatId);
}

export async function getMessages(chatId: string): Promise<PersistedMessage[]> {
  const { messages } = await bridge().getMessages(chatId);
  return messages;
}

export async function sendMessage(
  chatId: string,
  role: "user" | "assistant",
  content: string,
  attachmentIds?: string[],
): Promise<{ messageId: string; seq: number }> {
  return bridge().sendMessage(chatId, role, content, attachmentIds);
}

export async function editPersistedMessage(messageId: string, content: string): Promise<void> {
  await bridge().editMessage(messageId, content);
}

export async function renameChat(chatId: string, title: string): Promise<void> {
  await bridge().renameChat(chatId, title);
}

export async function getSetting<T>(key: string): Promise<T | null> {
  const { value } = await bridge().getSetting(key);
  return (value ?? null) as T | null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await bridge().setSetting(key, value);
}

// Run protocol

const ALLOWED_MEDIA = new Set([
  "application/pdf",
  "text/csv",
  "text/plain",
  "text/x-python",
  "application/x-python-code",
  "application/json",
  "text/markdown",
]);
function isAllowedMedia(mediaType: string): boolean {
  return ALLOWED_MEDIA.has(mediaType) || mediaType.startsWith("image/") || mediaType.startsWith("text/");
}

export async function registerAttachment(input: {
  chatId?: string;
  file: File;
}): Promise<{ runId: string; attachment: AttachmentReference }> {
  const { file, chatId } = input;
  if (!isAllowedMedia(file.type) && !isAllowedMedia(file.type || "")) {
    // fallback: infer from extension for files with empty type
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const inferred =
      ext === "pdf"
        ? "application/pdf"
        : ext === "csv"
        ? "text/csv"
        : ext === "py"
        ? "text/x-python"
        : ext === "txt"
        ? "text/plain"
        : ext === "json"
        ? "application/json"
        : ext === "md"
        ? "text/markdown"
        : ext.match(/^(png|jpg|jpeg|webp|gif|svg|heic)$/)
        ? "image/" + ext
        : "";
    if (!inferred || !isAllowedMedia(inferred)) throw new Error(`unsupported file type: ${file.type || ext}`);
  }
  if (file.size > 25 * 1024 * 1024) throw new Error("file too large (limit 25MB)");
  const base64OrBuffer = await fileToBase64(file);
  return bridge().registerAttachment({
    chatId,
    filename: file.name,
    mediaType: file.type || guessMediaType(file.name),
    sizeBytes: file.size,
    base64OrBuffer,
  });
}

function guessMediaType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "csv") return "text/csv";
  if (ext === "py") return "text/x-python";
  if (ext === "json") return "application/json";
  if (ext === "md") return "text/markdown";
  if (ext === "txt") return "text/plain";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "heic"].includes(ext)) return `image/${ext === "jpg" ? "jpeg" : ext}`;
  return "application/octet-stream";
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}

export async function startRun(input: {
  userText: string;
  attachmentToken?: string;
  attachmentTokens?: string[];
  runId?: string;
  chatId?: string;
  temperature?: number;
  groundingEnabled?: boolean;
  preferredRoute?: string;
  selectedModel?: string;
  mode?: "chat" | "agent";
}): Promise<{ runId: string }> {
  return bridge().startRun(input);
}

// Knowledge Base APIs

export async function kbListDocs(): Promise<DocumentRecord[]> {
  return bridge().kbListDocs();
}

export async function kbIngestDoc(input: {
  doc_id: string;
  title: string;
  source_path: string;
  doc_type?: string;
  department?: string;
  effective_date?: string;
  page_count?: number;
  ocr_used?: boolean;
}): Promise<{ ok: boolean; docId: string; chunkCount: number }> {
  return bridge().kbIngestDoc(input);
}

export async function kbDeleteDoc(docId: string): Promise<{ ok: boolean; docId: string }> {
  return bridge().kbDeleteDoc(docId);
}

export async function kbReindex(docId?: string): Promise<{ ok: boolean; chunksIndexed: number }> {
  return bridge().kbReindex(docId);
}

export async function kbQuery(text: string, topK?: number): Promise<{ ok: boolean; results: RetrievalResult[] }> {
  return bridge().kbQuery(text, topK);
}

export async function kbStats(): Promise<RAGStats> {
  return bridge().kbStats();
}


export async function confirmAction(input: { runId: string; actionId: string; approved: boolean }): Promise<void> {
  await bridge().confirmAction(input);
}

export async function cancelRun(runId: string): Promise<void> {
  await bridge().cancelRun({ runId });
}

export async function getRunHistory(limit?: number): Promise<RunSummary[]> {
  const result = await bridge().getRunHistory(limit !== undefined ? { limit } : {});
  // backend returns raw array; normalize if wrapped
  if (Array.isArray(result)) return result;
  return (result as unknown as { history: RunSummary[] }).history ?? (result as unknown as RunSummary[]);
}

export async function getArtifact(input: { runId: string; artifactId: string }): Promise<ArtifactRef> {
  return bridge().getArtifact(input);
}

export async function openArtifact(input: { runId: string; artifactId: string }): Promise<void> {
  await bridge().openArtifact(input);
}

export async function saveArtifact(input: { runId: string; artifactId: string }): Promise<{ saved: boolean; filename?: string }> {
  return bridge().saveArtifact(input);
}

export async function copyArtifact(input: { runId: string; artifactId: string }): Promise<{ copied: boolean; mode: "text" | "file"; filename: string }> {
  return bridge().copyArtifact(input);
}

export async function getHealth(): Promise<ModelHealth[]> {
  return bridge().getHealth();
}

export async function getRunLogs(input: { runId: string; limit?: number }): Promise<{ runId: string; entries: unknown[]; files: string[]; recentFull: unknown }> {
  return bridge().getRunLogs(input);
}

export async function getRunLogFile(input: { runId: string; filename: string }): Promise<{ runId: string; filename: string; content: unknown }> {
  return bridge().getRunLogFile(input);
}

export function onRunEvent(listener: (event: RunEvent) => void): () => void {
  return bridge().onRunEvent(listener);
}

// Workspace harness APIs

export async function pickWorkspaceFolder(): Promise<string | null> {
  return bridge().pickWorkspaceFolder();
}

export async function registerWorkspace(dirPath: string): Promise<WorkspaceInfo> {
  return bridge().registerWorkspace(dirPath);
}

export async function deregisterWorkspace(): Promise<{ ok: boolean }> {
  return bridge().deregisterWorkspace();
}

export async function getCurrentWorkspace(): Promise<WorkspaceInfo | null> {
  return bridge().getCurrentWorkspace();
}

export async function listWorkspaceDir(path?: string): Promise<{ tool: "list_dir"; result: HarnessDirEntry[] }> {
  return bridge().listWorkspaceDir(path);
}

export async function readWorkspaceFile(path: string): Promise<{ tool: "read_file"; result: string }> {
  return bridge().readWorkspaceFile(path);
}

export async function searchWorkspace(query: string, path?: string): Promise<{ tool: "search"; result: HarnessSearchMatch[] }> {
  return bridge().searchWorkspace(query, path);
}

export async function writeWorkspaceFile(path: string, content: string): Promise<{ tool: "write_file"; result: HarnessWriteResult }> {
  return bridge().writeWorkspaceFile(path, content);
}

export async function runWorkspaceCommand(command: string): Promise<{ tool: "run_command"; result: HarnessCommandResult }> {
  return bridge().runWorkspaceCommand(command);
}

export function onWorkspaceEvent(listener: (event: any) => void): () => void {
  return bridge().onWorkspaceEvent(listener);
}

// Onboarding & Model Configuration
export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  return bridge().getOnboardingStatus();
}

export async function saveModelConfig(models: ModelConfigRow[]): Promise<{ ok: boolean }> {
  return bridge().saveModelConfig(models);
}

export async function testModelEndpoint(input: {
  host: string;
  port: number;
  modelName?: string;
  role?: string;
}): Promise<ModelEndpointTestResult> {
  return bridge().testModelEndpoint(input);
}

export async function resetOnboarding(): Promise<{ ok: boolean }> {
  return bridge().resetOnboarding();
}
