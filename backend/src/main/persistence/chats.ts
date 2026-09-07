// Phase DB.2 — Chat data-access (backend/src/main/persistence/chats.ts).
// Chats are the top-level session; PK = uuid4 TEXT. Enforce z.string().uuid() on all chat ids.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "./db.js";

export const chatIdSchema = z.string().uuid();
export type ChatId = z.infer<typeof chatIdSchema>;

export interface Chat {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived: number;
  metadata: string;
}

export function assertChatId(id: string): asserts id is ChatId {
  chatIdSchema.parse(id);
}

/** Create a chat with a uuid4 PK. Returns the new id. */
export function createChat(title?: string): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO chats(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, title?.trim() ? title.trim().slice(0, 200) : "Untitled Chat", now, now);
  return id;
}

export function getChat(id: string): Chat | undefined {
  assertChatId(id);
  return getDb().prepare("SELECT * FROM chats WHERE id = ?").get(id) as Chat | undefined;
}

export function listChats(limit = 50): Pick<Chat, "id" | "title" | "updated_at">[] {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  return getDb()
    .prepare("SELECT id, title, updated_at FROM chats WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?")
    .all(n) as Pick<Chat, "id" | "title" | "updated_at">[];
}

/** Bump updated_at to now (called in the same transaction as addMessage). */
export function touchChat(id: string, at?: string): void {
  assertChatId(id);
  getDb()
    .prepare("UPDATE chats SET updated_at = ? WHERE id = ?")
    .run(at ?? new Date().toISOString(), id);
}

export function archiveChat(id: string): void {
  assertChatId(id);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE chats SET archived = 1, updated_at = ? WHERE id = ?").run(now, id);
}

/** Rename a chat (title 1..200 chars after trim) + bump updated_at. */
export function renameChat(id: string, title: string): void {
  assertChatId(id);
  const clean = title.trim();
  if (!clean) throw new Error("chat title must not be empty");
  getDb()
    .prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?")
    .run(clean.slice(0, 200), new Date().toISOString(), id);
}

export function deleteChat(id: string): void {
  assertChatId(id);
  getDb().prepare("DELETE FROM chats WHERE id = ?").run(id);
}
