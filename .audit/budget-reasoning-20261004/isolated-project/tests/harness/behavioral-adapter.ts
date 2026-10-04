import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { containedFile } from "../helpers/files.js";
import type { FakeIpcRegistrar } from "../helpers/ipc-fake.js";
import type { AttachmentReference } from "../../backend/src/shared/contracts.js";

export function mediaType(name: string): string {
  const extension = path.extname(name).toLowerCase();
  return ({ ".pdf": "application/pdf", ".csv": "text/csv", ".py": "text/x-python", ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" } as Record<string, string>)[extension] ?? "text/plain";
}
export async function sendUserMessage(ipc: FakeIpcRegistrar, chatId: string, text: string, root: string, options: { files?: string[]; temperature?: number; groundingEnabled?: boolean; preferredRoute?: string } = {}): Promise<{ runId: string }> {
  if (!text.trim() && !options.files?.length) throw new Error("Empty message");
  if ((options.files?.length ?? 0) > 10) throw new Error("Maximum 10 attachments per run supported");
  const tokens: string[] = [];
  let attachmentRun: string | undefined;
  for (const file of options.files ?? []) {
    const bytes = readFileSync(containedFile(root, file));
    if (bytes.length > 25 * 1024 ** 2) throw new Error("Attachment exceeds 25MB");
    const result = await ipc.invoke<{ runId: string; attachment: AttachmentReference }>("workbench:registerAttachment", { chatId, filename: path.basename(file), mediaType: mediaType(file), sizeBytes: bytes.length, base64OrBuffer: bytes.toString("base64") });
    tokens.push(result.attachment.attachmentId);
    attachmentRun ??= result.runId;
  }
  await ipc.invoke("workbench:sendMessage", { chatId, role: "user", content: text, attachmentIds: tokens.length ? tokens : undefined });
  return ipc.invoke("workbench:startRun", { chatId, runId: attachmentRun ?? randomUUID(), userText: text, attachmentToken: tokens[0], attachmentTokens: tokens, temperature: options.temperature, groundingEnabled: options.groundingEnabled, preferredRoute: options.preferredRoute });
}
