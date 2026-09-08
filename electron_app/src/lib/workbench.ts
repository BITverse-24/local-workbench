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
): Promise<{ messageId: string; seq: number }> {
  return bridge().sendMessage(chatId, role, content);
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

const ALLOWED_MEDIA = new Set(["application/pdf", "text/csv"]);
function isAllowedMedia(mediaType: string): boolean {
  return ALLOWED_MEDIA.has(mediaType) || mediaType.startsWith("image/");
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
      ext === "pdf" ? "application/pdf" : ext === "csv" ? "text/csv" : ext.match(/^(png|jpg|jpeg|webp|gif|svg|heic)$/) ? "image/" + ext : "";
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
  runId?: string;
  chatId?: string;
}): Promise<{ runId: string }> {
  return bridge().startRun(input);
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

export async function getHealth(): Promise<ModelHealth[]> {
  return bridge().getHealth();
}

export function onRunEvent(listener: (event: RunEvent) => void): () => void {
  return bridge().onRunEvent(listener);
}
