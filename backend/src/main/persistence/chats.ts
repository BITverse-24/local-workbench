// Phase DB.2 — Chat data-access (backend/src/main/persistence/chats.ts).
// Chats are the top-level session; PK = uuid4 TEXT. Enforce z.string().uuid() on all chat ids.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb, prepareCached } from "./db.js";

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
  prepareCached(
    db,
    "INSERT INTO chats(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, title?.trim() ? title.trim().slice(0, 200) : "New chat", now, now);
  if (title?.trim() && !isPlaceholderTitle(title)) {
    db.prepare("UPDATE chats SET metadata=? WHERE id=?").run(JSON.stringify({ titleOrigin: "manual", titleRevision: 1 }), id);
  }
  return id;
}

export function getChat(id: string): Chat | undefined {
  assertChatId(id);
  const db = getDb();
  return prepareCached(db, "SELECT * FROM chats WHERE id = ?").get(id) as Chat | undefined;
}

export function listChats(limit = 50): Array<Pick<Chat, "id" | "title" | "updated_at"> & { forkedFrom?: { chatId: string; messageId: string } }> {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  const db = getDb();
  const chats = prepareCached(
    db,
    "SELECT id, title, updated_at FROM chats WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?",
  ).all(n) as Pick<Chat, "id" | "title" | "updated_at">[];
  for (const chat of chats) {
    if (isPlaceholderTitle(chat.title)) {
      const first = db.prepare("SELECT id, content FROM messages WHERE chat_id=? AND role='user' ORDER BY seq LIMIT 1").get(chat.id) as { id: string; content: string } | undefined;
      const names = first ? (db.prepare("SELECT a.filename FROM attachments a JOIN message_attachments m ON m.attachment_id=a.attachment_id WHERE m.message_id=?").all(first.id) as { filename: string }[]).map(row => row.filename) : [];
      if (first) chat.title = initializeChatTitle(chat.id, first.content, names)?.title ?? chat.title;
    }
  }
  return chats.map(chat => {
    const metadata = chatMetadata(getChat(chat.id)!);
    const forkedFrom = metadata.forkedFrom as { chatId: string; messageId: string } | undefined;
    return { ...chat, ...(forkedFrom ? { forkedFrom } : {}) };
  });
}

/** Bump updated_at to now (called in the same transaction as addMessage). */
export function touchChat(id: string, at?: string): void {
  assertChatId(id);
  const db = getDb();
  prepareCached(db, "UPDATE chats SET updated_at = ? WHERE id = ?").run(
    at ?? new Date().toISOString(),
    id,
  );
}

export function archiveChat(id: string): void {
  assertChatId(id);
  const db = getDb();
  const now = new Date().toISOString();
  prepareCached(db, "UPDATE chats SET archived = 1, updated_at = ? WHERE id = ?").run(now, id);
}

/** Rename a chat (title 1..200 chars after trim) + bump updated_at. */
export function renameChat(id: string, title: string): void {
  assertChatId(id);
  const clean = title.trim();
  if (!clean) throw new Error("chat title must not be empty");
  const db = getDb();
  prepareCached(db, "UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(
    clean.slice(0, 200),
    new Date().toISOString(),
    id,
  );
  const metadata = chatMetadata(getChat(id)!);
  metadata.titleOrigin = "manual";
  metadata.titleRevision = Number(metadata.titleRevision ?? 0) + 1;
  db.prepare("UPDATE chats SET metadata=? WHERE id=?").run(JSON.stringify(metadata), id);
}

export function isPlaceholderTitle(title: string): boolean {
  return /^(?:new chats?|untitled chat)$/i.test(title.trim());
}

export function fallbackChatTitle(text: string, filenames: string[] = []): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  const candidate = clean || (filenames.length ? `Review ${filenames.join(", ")}` : "Review attachments");
  const words = candidate.split(/\s+/u).filter(Boolean).slice(0, 4);
  while (words.length < 3) words.push(words.length === 1 ? "chat" : "request");
  let title = words.join(" ");
  if (title.length > 60) {
    title = words.slice(0, 3).join(" ");
    if (title.length > 60) title = "Review workspace request";
  }
  return title;
}

export function chatMetadata(chat: Chat): Record<string, unknown> {
  try { const value = JSON.parse(chat.metadata); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}

export function initializeChatTitle(chatId: string, text: string, filenames: string[] = []) {
  const chat = getChat(chatId);
  if (!chat) return;
  const metadata = chatMetadata(chat);
  if (metadata.titleOrigin === "manual" || (!isPlaceholderTitle(chat.title) && metadata.titleOrigin !== "fallback")) return;
  if (metadata.titleOrigin === "fallback") return;
  const title = fallbackChatTitle(text, filenames);
  const revision = Number(metadata.titleRevision ?? 0) + 1;
  getDb().prepare("UPDATE chats SET title=?,metadata=? WHERE id=?").run(title,
    JSON.stringify({ ...metadata, titleOrigin: "fallback", titleRevision: revision }), chatId);
  return { type: "chat_title_changed" as const, chatId, title, revision };
}

/** Claim one model attempt; revision is used to protect manual renames. */
export function claimChatTitle(chatId: string): number | undefined {
  const chat = getChat(chatId);
  if (!chat || chat.archived) return;
  const metadata = chatMetadata(chat);
  if (metadata.titleOrigin !== "fallback" || metadata.titleAttempted) return;
  getDb().prepare("UPDATE chats SET metadata=? WHERE id=?").run(JSON.stringify({ ...metadata, titleAttempted: true }), chatId);
  return Number(metadata.titleRevision);
}

export function applyGeneratedChatTitle(chatId: string, title: string, expectedRevision: number) {
  const chat = getChat(chatId);
  if (!chat || chat.archived) return;
  const metadata = chatMetadata(chat);
  if (metadata.titleOrigin !== "fallback" || metadata.titleRevision !== expectedRevision) return;
  const revision = expectedRevision + 1;
  getDb().prepare("UPDATE chats SET title=?,metadata=? WHERE id=?").run(title,
    JSON.stringify({ ...metadata, titleOrigin: "model", titleRevision: revision }), chatId);
  return { type: "chat_title_changed" as const, chatId, title, revision };
}

export function deleteChat(id: string): void {
  assertChatId(id);
  const db = getDb();
  prepareCached(db, "DELETE FROM chats WHERE id = ?").run(id);
}
