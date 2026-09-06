// Phase DB.2 — Message data-access (backend/src/main/persistence/messages.ts).
// content ≤ 32k enforced in code; seq auto-increments per chat; addMessage + touchChat in one txn.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "./db.js";
import { chatIdSchema } from "./chats.js";

export const MAX_CONTENT_CHARS = 32 * 1024;

export const roleSchema = z.enum(["user", "assistant", "system", "tool"]);

export const addMessageSchema = z.object({
  chat_id: chatIdSchema,
  role: roleSchema,
  content: z.string().min(1).max(MAX_CONTENT_CHARS),
  run_id: z.string().uuid().optional(),
  model_id: z.string().max(200).optional(),
});

export interface Message {
  id: string;
  chat_id: string;
  run_id: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  model_id: string | null;
  created_at: string;
  edited_at: string | null;
  seq: number;
}

export type AddMessageInput = z.infer<typeof addMessageSchema>;

/** Insert a message; seq = max(seq)+1 per chat. Returns { id, seq }. */
export function addMessage(input: AddMessageInput): { id: string; seq: number } {
  const parsed = addMessageSchema.parse(input);
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    const prev = db
      .prepare("SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM messages WHERE chat_id = ?")
      .get(parsed.chat_id) as { maxSeq: number };
    const seq = prev.maxSeq + 1;
    db.prepare(
      "INSERT INTO messages(id, chat_id, run_id, role, content, model_id, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      parsed.chat_id,
      parsed.run_id ?? null,
      parsed.role,
      parsed.content,
      parsed.model_id ?? null,
      now,
      seq,
    );
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(now, parsed.chat_id);
    return seq;
  });
  const seq = txn();
  return { id, seq };
}

export function listMessages(chat_id: string): Message[] {
  chatIdSchema.parse(chat_id);
  return getDb()
    .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY seq ASC")
    .all(chat_id) as Message[];
}

/** Edit message content (≤32k); sets edited_at. */
export function editMessage(id: string, content: string): void {
  z.string().uuid().parse(id);
  z.string().min(1).max(MAX_CONTENT_CHARS).parse(content);
  getDb()
    .prepare("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?")
    .run(content, new Date().toISOString(), id);
}
