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

export const startRunSchema = z.object({ userText: z.string().trim().max(8000), attachmentToken: z.string().uuid().optional(), runId: z.string().uuid().optional(), chatId: z.string().uuid().optional(), temperature: z.number().min(0).max(2).optional() }).strict().refine((d) => d.userText.length > 0 || d.attachmentToken !== undefined, { message: "message text or an attachment is required" });
export const confirmActionSchema = z.object({ runId: z.string().uuid(), actionId: z.string().uuid(), approved: z.boolean() }).strict();
export const cancelRunSchema = z.object({ runId: z.string().uuid() }).strict();
export const getArtifactSchema = z.object({ runId: z.string().uuid(), artifactId: z.string().uuid() }).strict();
export const getRunHistorySchema = z.object({ limit: z.number().int().min(1).max(200).optional() }).strict();
export const registerAttachmentSchema = z.object({ chatId: z.string().uuid().optional(), filename: z.string().min(1).max(255), mediaType: z.string().min(1).max(100), sizeBytes: z.number().int().nonnegative(), base64OrBuffer: z.union([z.string(), z.instanceof(Buffer)]) }).strict();
export const openArtifactSchema = getArtifactSchema;
