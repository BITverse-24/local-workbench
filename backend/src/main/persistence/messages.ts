// Phase DB.2 — Message data-access (backend/src/main/persistence/messages.ts).
// content ≤ 32k enforced in code; seq auto-increments per chat; addMessage + touchChat in one txn.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb, prepareCached } from "./db.js";
import { chatIdSchema } from "./chats.js";
import type { ArtifactRef, AttachmentReference, RunVerificationReport } from "../../shared/contracts.js";

export const MAX_CONTENT_CHARS = 32 * 1024;

export const roleSchema = z.enum(["user", "assistant", "system", "tool"]);

export const addMessageSchema = z.object({
  id: z.string().uuid().optional(),
  chat_id: chatIdSchema,
  role: roleSchema,
  content: z.string().min(1).max(MAX_CONTENT_CHARS),
  run_id: z.string().uuid().optional(),
  model_id: z.string().max(200).optional(),
  attachment_ids: z.array(z.string()).optional(),
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
  artifacts?: ArtifactRef[];
  attachments?: AttachmentReference[];
  verification?: RunVerificationReport;
}

export type AddMessageInput = z.infer<typeof addMessageSchema>;

/** Insert a message; seq = max(seq)+1 per chat. Returns { id, seq }. */
export function addMessage(input: AddMessageInput): { id: string; seq: number } {
  const parsed = addMessageSchema.parse(input);
  const db = getDb();
  const id = parsed.id ?? randomUUID();
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    const prev = prepareCached(
      db,
      "SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM messages WHERE chat_id = ?",
    ).get(parsed.chat_id) as { maxSeq: number };
    const seq = prev.maxSeq + 1;
    prepareCached(
      db,
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
    if (parsed.attachment_ids && parsed.attachment_ids.length > 0) {
      const attachStmt = prepareCached(
        db,
        "INSERT OR IGNORE INTO message_attachments(message_id, attachment_id) VALUES (?, ?)",
      );
      for (const attId of parsed.attachment_ids) {
        attachStmt.run(id, attId);
      }
    }
    prepareCached(db, "UPDATE chats SET updated_at = ? WHERE id = ?").run(now, parsed.chat_id);
    return seq;
  });
  const seq = txn();
  return { id, seq };
}

export function listMessages(chat_id: string): Message[] {
  chatIdSchema.parse(chat_id);
  const db = getDb();
  const rows = prepareCached(
    db,
    "SELECT * FROM messages WHERE chat_id = ? ORDER BY seq ASC",
  ).all(chat_id) as Message[];

  if (rows.length === 0) return [];

  try {
    // PERF OPTIMIZATION: Batch subquery execution to eliminate N+1 queries.
    // Instead of executing artifactStmt and attachmentStmt in a loop per message (2N queries),
    // retrieve all artifacts and attachments for the entire chat in 2 batch JOIN queries
    // and map them in memory using HashMaps (O(N) time complexity).
    const artifactsByRun = new Map<string, ArtifactRef[]>();
    const verificationByRun = new Map<string, RunVerificationReport>();
    const attachmentsByMsg = new Map<string, AttachmentReference[]>();

    const runIds = Array.from(
      new Set(rows.map((r) => r.run_id).filter((id): id is string => Boolean(id)))
    );

    if (runIds.length > 0) {
      const runPlaceholders = runIds.map(() => "?").join(",");
      const allArtifacts = db
        .prepare(
          `SELECT artifact_id as artifactId, run_id as runId, kind, filename, relative_path as relativePath, size_bytes as sizeBytes, created_at as createdAt FROM artifacts WHERE run_id IN (${runPlaceholders})`
        )
        .all(...runIds) as ArtifactRef[];

      for (const art of allArtifacts) {
        let list = artifactsByRun.get(art.runId);
        if (!list) {
          list = [];
          artifactsByRun.set(art.runId, list);
        }
        list.push(art);
      }

      try {
        const allReports = db
          .prepare(
            `SELECT run_id as runId, report_json as reportJson FROM run_verification_reports WHERE run_id IN (${runPlaceholders})`
          )
          .all(...runIds) as Array<{ runId: string; reportJson: string }>;
        for (const row of allReports) {
          try {
            verificationByRun.set(row.runId, JSON.parse(row.reportJson) as RunVerificationReport);
          } catch { /* ignore malformed report */ }
        }
      } catch { /* table optional in older test fixtures */ }
    }

    const allAttachments = prepareCached(
      db,
      `SELECT ma.message_id as messageId, a.attachment_id as attachmentId, a.filename, a.media_type as mediaType, a.size_bytes as sizeBytes, a.relative_path as relativePath FROM attachments a JOIN message_attachments ma ON a.attachment_id = ma.attachment_id JOIN messages m ON ma.message_id = m.id WHERE m.chat_id = ?`,
    ).all(chat_id) as (AttachmentReference & { messageId: string })[];

    for (const att of allAttachments) {
      const { messageId, ...ref } = att;
      let list = attachmentsByMsg.get(messageId);
      if (!list) {
        list = [];
        attachmentsByMsg.set(messageId, list);
      }
      list.push(ref);
    }

    return rows.map((msg) => {
      const artifacts = msg.run_id ? artifactsByRun.get(msg.run_id) : undefined;
      const verification = msg.role === "assistant" && msg.run_id ? verificationByRun.get(msg.run_id) : undefined;
      const attachments = attachmentsByMsg.get(msg.id);
      return {
        ...msg,
        ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
        ...(verification ? { verification } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
    });
  } catch {
    return rows;
  }
}

/** Edit message content (≤32k); sets edited_at. */
export function editMessage(id: string, content: string): void {
  z.string().uuid().parse(id);
  z.string().min(1).max(MAX_CONTENT_CHARS).parse(content);
  const db = getDb();
  prepareCached(db, "UPDATE messages SET content = ?, edited_at = ? WHERE id = ?").run(
    content,
    new Date().toISOString(),
    id,
  );
}
