import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { getDb } from "../persistence/db.js";
import { createChat, getChat } from "../persistence/chats.js";
import { addMessage, listMessages } from "../persistence/messages.js";
import { resolveRunPath, sha256File } from "./filesystem.js";
import type { ExecutionMode } from "../../shared/contracts.js";

/** Fork context before the edited request. Original runs and evidence stay immutable. */
export function createMessageAttempt(messageId: string, content: string) {
  const db = getDb();
  const source = db.prepare("SELECT id,chat_id,seq,role,run_id,content FROM messages WHERE id=?").get(messageId) as
    { id: string; chat_id: string; seq: number; role: string; run_id: string | null; content: string } | undefined;
  if (!source || source.role !== "user") throw new Error("Select a saved user request to create a new attempt.");
  if (db.prepare(`SELECT r.id FROM runs r JOIN run_mode_details m ON m.run_id=r.id
    WHERE r.chat_id=? AND r.state NOT IN ('completed','partial','failed','cancelled','limit_exceeded') LIMIT 1`).get(source.chat_id))
    throw new Error("Wait for the current task to stop before creating a new attempt.");
  const parent = getChat(source.chat_id)!;
  const run = db.prepare(`SELECT r.id,m.mode,m.workspace_root,m.metrics_json FROM runs r
    JOIN run_mode_details m ON m.run_id=r.id WHERE r.id=COALESCE(?,
      (SELECT run_id FROM messages WHERE chat_id=? AND seq>? AND seq<COALESCE(
        (SELECT MIN(seq) FROM messages WHERE chat_id=? AND role='user' AND seq>?),2147483647)
        AND role='assistant' AND run_id IS NOT NULL ORDER BY seq LIMIT 1))`).get(source.run_id, source.chat_id, source.seq, source.chat_id, source.seq) as
    { id: string; mode: ExecutionMode; workspace_root: string | null; metrics_json: string } | undefined;
  const metrics = JSON.parse(run?.metrics_json ?? "{}");
  let sourceContext = typeof metrics.sourceReferenceEvidence === "string" ? metrics.sourceReferenceEvidence : "";
  if (run && metrics.workspaceManifest) {
    const reference = metrics.workspaceManifest as { relativePath: string; sha256: string };
    const prefix = `runs/${run.id}/`;
    if (!reference.relativePath.startsWith(prefix)) throw new Error("The saved source manifest is outside its run.");
    const file = resolveRunPath(run.id, reference.relativePath.slice(prefix.length), "intermediate");
    if (sha256File(file) !== reference.sha256) throw new Error("The saved source manifest changed. Select the sources again.");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    const mapping = (manifest.files ?? []).map((item: { attachmentId: string; sourcePath: string; filename: string }) => {
      const alias = (metrics.sourceAliases ?? []).find((entry: { id: string }) => entry.id === item.attachmentId);
      return `${item.sourcePath} => ${alias?.filename ?? item.filename}`;
    }).join("\n");
    sourceContext += `\nSaved source selection from the original request (read-only evidence):\n${manifest.folderEvidence ?? ""}\nCopied input names:\n${mapping}`;
  }
  let inputs: Array<{ filename: string; mediaType?: string; relativePath: string; runId: string; sha256?: string }>;
  if (run && Array.isArray(metrics.sourceAliases)) {
    inputs = metrics.sourceAliases.map((item: any) => ({ ...item, runId: run.id }));
  } else {
    inputs = db.prepare(`SELECT a.filename,a.media_type as mediaType,a.relative_path as relativePath,a.run_id as runId
      FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.attachment_id WHERE ma.message_id=?`).all(messageId) as typeof inputs;
  }
  if (inputs.length > 10) throw new Error("This request has more than ten saved inputs. Select the required files in a new chat.");
  // Read and verify before creating a branch. Never return arbitrary renderer paths.
  const files = inputs.map(input => {
    const prefix = `runs/${input.runId}/`;
    if (!input.relativePath.startsWith(prefix)) throw new Error("A saved input is outside its run.");
    const file = resolveRunPath(input.runId, input.relativePath.slice(prefix.length), "input");
    if (!statSync(file).isFile() || statSync(file).size > 10 * 1024 * 1024) throw new Error(`Saved input cannot be copied: ${input.filename}`);
    const bytes = readFileSync(file);
    if (input.sha256 && createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new Error(`Saved input changed: ${input.filename}. Select it again in a new chat.`);
    return { filename: input.filename, mediaType: input.mediaType ?? "application/octet-stream", base64: bytes.toString("base64") };
  });
  if (!content.trim() && !files.length) throw new Error("Add instructions or select an input for this attempt.");
  const prefix = listMessages(source.chat_id).filter(message => message.seq < source.seq);
  const chatId = db.transaction(() => {
    const id = createChat(`${parent.title.slice(0, 160)} · New attempt`);
    const metadata = JSON.parse(getChat(id)!.metadata);
    metadata.forkedFrom = { chatId: source.chat_id, messageId, createdAt: new Date().toISOString() };
    if (sourceContext) metadata.attemptSourceContext = sourceContext;
    db.prepare("UPDATE chats SET metadata=? WHERE id=?").run(JSON.stringify(metadata), id);
    for (const message of prefix) addMessage({ chat_id: id, role: message.role, content: message.content,
      // References still identify the original evidence; no run or approval is copied.
      run_id: message.run_id ?? undefined, model_id: message.model_id ?? undefined,
      attachment_ids: message.attachments?.map(attachment => attachment.attachmentId) });
    return id;
  })();
  return { chatId, title: getChat(chatId)!.title, sourceChatId: source.chat_id, sourceMessageId: messageId,
    text: content, originalText: source.content, mode: run?.mode ?? null, workspaceRoot: run?.workspace_root ?? null, files };
}
