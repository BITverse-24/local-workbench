import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SourceReadReceipt } from "../../../shared/contracts.js";
import { resolveSafe, PermissionError } from "../path-guard.js";
import { writeFile } from "./write-file.js";

export const fileDigest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function observedRange(receipts: SourceReadReceipt[], path: string, digest: string, start: number, end: number): boolean {
  const ranges = receipts.filter(item => item.path === path && item.digest === digest).sort((a, b) => a.startByte - b.startByte);
  let covered = start;
  for (const range of ranges) {
    if (range.startByte > covered) break;
    if (range.endByte > covered) covered = range.endByte;
    if (covered >= end) return true;
  }
  return false;
}

/** Caller holds the existing file lock and checks scoped authority. Validate all anchors before writing. */
export function prepareFileEdit(root: string, input: { path: string; expectedDigest: string; replacements: Array<{ old: string; new: string }>; requirementId: string; reason: string }, receipts: SourceReadReceipt[]) {
  const target = resolveSafe(root, input.path);
  const before = readFileSync(target), digest = fileDigest(before);
  if (digest !== input.expectedDigest) throw new PermissionError("The file changed. Read it again and propose a new edit.");
  if (!input.requirementId || !input.reason.trim() || !input.replacements.length) throw new Error("An edit requires a requirement, reason, and replacements.");
  const edits = input.replacements.map(replacement => {
    const old = Buffer.from(replacement.old), next = Buffer.from(replacement.new);
    if (!old.length) throw new Error("An edit anchor cannot be empty.");
    const offset = before.indexOf(old);
    if (offset < 0 || before.indexOf(old, offset + 1) >= 0) throw new Error("Each old anchor must match exactly once in the inspected file.");
    if (!observedRange(receipts, input.path, digest, offset, offset + old.length)) throw new PermissionError("An edit anchor is outside the source ranges supplied to the model.");
    return { offset, end: offset + old.length, next };
  }).sort((a, b) => a.offset - b.offset);
  if (edits.some((item, index) => index > 0 && edits[index - 1].end > item.offset)) throw new Error("Edit anchors overlap.");
  const parts: Buffer[] = []; let offset = 0;
  for (const edit of edits) { parts.push(before.subarray(offset, edit.offset), edit.next); offset = edit.end; }
  parts.push(before.subarray(offset));
  const after = Buffer.concat(parts);
  return { after, beforeDigest: digest, afterDigest: fileDigest(after), requirementId: input.requirementId, reason: input.reason };
}

export function editFile(root: string, input: Parameters<typeof prepareFileEdit>[1], receipts: SourceReadReceipt[]) {
  resolveSafe(root, input.path);
  const { after, ...evidence } = prepareFileEdit(root, input, receipts);
  return { ...writeFile(root, input.path, after), ...evidence };
}
