// Zod validators for chat-persistence IPC inputs (backend/src/main/ipc/validators.ts).
// Every handler parses its input with these before touching SQLite. Renderer must never
// send absolute paths — chat IPC carries no paths at all by design.

import { z } from "zod";
import { MAX_CONTENT_CHARS } from "../persistence/messages.js";

export const chatIdSchema = z.string().uuid();

export const createChatSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export const getChatHistorySchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

export const archiveChatSchema = z.object({
  chatId: chatIdSchema,
});

export const renameChatSchema = z.object({
  chatId: chatIdSchema,
  title: z.string().trim().min(1).max(200),
});

export const getMessagesSchema = z.object({
  chatId: chatIdSchema,
});

export const sendMessageSchema = z.object({
  chatId: chatIdSchema,
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(MAX_CONTENT_CHARS),
  attachmentIds: z.array(z.string()).optional(),
});

export const editMessageSchema = z.object({
  messageId: z.string().uuid(),
  content: z.string().min(1).max(MAX_CONTENT_CHARS),
});

// Settings: single row per key, JSON value. Secrets are never stored — block
// secret-like keys at the validation layer (defense in depth; store holds no secrets).
const SECRET_KEY_HINT = /key|secret|token|password|credential/i;

export const settingKeySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "setting key must be alphanumeric with -/_")
  .refine((k) => !SECRET_KEY_HINT.test(k), "secret-like setting keys are rejected");

export const getSettingSchema = z.object({
  key: settingKeySchema,
});

export const setSettingSchema = z.object({
  key: settingKeySchema,
  value: z.unknown().refine(
    (v) => {
      try {
        const s = JSON.stringify(v);
        return s !== undefined && s.length <= 8192;
      } catch {
        return false;
      }
    },
    "setting value must be JSON-serializable and ≤ 8k",
  ),
});

export type CreateChatInput = z.infer<typeof createChatSchema>;
export type GetChatHistoryInput = z.infer<typeof getChatHistorySchema>;
export type ArchiveChatInput = z.infer<typeof archiveChatSchema>;
export type RenameChatInput = z.infer<typeof renameChatSchema>;
export type GetMessagesInput = z.infer<typeof getMessagesSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type GetSettingInput = z.infer<typeof getSettingSchema>;
export type SetSettingInput = z.infer<typeof setSettingSchema>;

export const startRunSchema = z
  .object({
    userText: z.string().trim().max(8000),
    attachmentToken: z.string().uuid().optional(),
    attachmentTokens: z.array(z.string().uuid()).max(10).optional(),
    runId: z.string().uuid().optional(),
    chatId: z.string().uuid().optional(),
    temperature: z.number().min(0).max(2).optional(),
    groundingEnabled: z.boolean().optional(),
    preferredRoute: z.string().optional(),
    selectedModel: z.string().optional(),
    mode: z.enum(["chat", "agent"]).optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.userText.length > 0 ||
      d.attachmentToken !== undefined ||
      (d.attachmentTokens !== undefined && d.attachmentTokens.length > 0),
    { message: "message text or an attachment is required" },
  );
export const confirmActionSchema = z.object({ runId: z.string().uuid(), actionId: z.string().uuid(), approved: z.boolean() }).strict();
export const cancelRunSchema = z.object({ runId: z.string().uuid() }).strict();
export const getArtifactSchema = z.object({ runId: z.string().uuid(), artifactId: z.string().uuid() }).strict();
export const getRunHistorySchema = z.object({ limit: z.number().int().min(1).max(200).optional() }).strict();
export const registerAttachmentSchema = z.object({ chatId: z.string().uuid().optional(), filename: z.string().min(1).max(255), mediaType: z.string().min(1).max(100), sizeBytes: z.number().int().nonnegative(), base64OrBuffer: z.union([z.string(), z.instanceof(Buffer)]) }).strict();
export const openArtifactSchema = getArtifactSchema;

// ── Harness / workspace validators ──────────────────────────────────────

export const registerWorkspaceSchema = z.object({
  dirPath: z.string().min(1).max(4096),
}).strict();

export const harnessListDirSchema = z.object({
  path: z.string().max(1024).optional(),
}).strict();

export const harnessReadFileSchema = z.object({
  path: z.string().min(1).max(1024),
}).strict();

export const harnessSearchSchema = z.object({
  query: z.string().min(1).max(1000),
  path: z.string().max(1024).optional(),
}).strict();

export const harnessWriteFileSchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string().max(1024 * 1024), // 1MB max
}).strict();

export const harnessRunCommandSchema = z.object({
  command: z.string().min(1).max(4096),
}).strict();

export type RegisterWorkspaceInput = z.infer<typeof registerWorkspaceSchema>;
export type HarnessListDirInput = z.infer<typeof harnessListDirSchema>;
export type HarnessReadFileInput = z.infer<typeof harnessReadFileSchema>;
export type HarnessSearchInput = z.infer<typeof harnessSearchSchema>;
export type HarnessWriteFileInput = z.infer<typeof harnessWriteFileSchema>;
export type HarnessRunCommandInput = z.infer<typeof harnessRunCommandSchema>;

// ── Knowledge Base validators ──────────────────────────────────────────

export const kbIngestDocSchema = z.object({
  doc_id: z.string().min(1).max(100),
  title: z.string().min(1).max(255),
  source_path: z.string().min(1).max(4096),
  doc_type: z.string().min(1).max(50).default("sop"),
  department: z.string().min(1).max(100).default("engineering"),
  effective_date: z.string().max(50).default(""),
  page_count: z.number().int().nonnegative().default(1),
  ocr_used: z.boolean().default(false),
}).strict();

export const kbDeleteDocSchema = z.object({
  docId: z.string().min(1).max(100),
}).strict();

export const kbReindexSchema = z.object({
  docId: z.string().min(1).max(100).optional(),
}).strict();

export const kbQuerySchema = z.object({
  text: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(20).optional().default(5),
}).strict();

export type KbIngestDocInput = z.infer<typeof kbIngestDocSchema>;
export type KbDeleteDocInput = z.infer<typeof kbDeleteDocSchema>;
export type KbReindexInput = z.infer<typeof kbReindexSchema>;
export type KbQueryInput = z.infer<typeof kbQuerySchema>;
