import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentToolDefinition } from "../../shared/contracts.js";
import type { AgentTool, ToolExecutionContext } from "../tools/types.js";
import { resolveSafe, PermissionError } from "../harness/path-guard.js";
import { listDir, clearListDirCache } from "../harness/tools/list-dir.js";
import { search } from "../harness/tools/search.js";
import { writeFile } from "../harness/tools/write-file.js";
import { deleteFile } from "../harness/tools/delete-file.js";
import { editFile, fileDigest, observedRange, prepareFileEdit, readAgentSourceBytes } from "../harness/tools/edit-file.js";
import { getExecutionLedger } from "../run/execution-ledger.js";
import { captureAgentVerificationManifest } from "./test-verification.js";
import { validateAgentDependencyChange } from "./dependency-constraint.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), relative = z.string().min(1).max(1024);
export function canonicalSourcePath(context: ToolExecutionContext, requested: string): string {
  return path.relative(resolveSafe(context.workspaceRoot, "."), resolveSafe(context.workspaceRoot, requested)).split(path.sep).join("/");
}
const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
export function sourcePageCursor(path: string, digest: string, offset: number): string {
  return cursor({offset,revision:digest,query:path});
}
function continueAt(raw: string | undefined, revision: string, query: string): number {
  if (!raw) return 0;
  const value = z.object({ offset: z.number().int().nonnegative(), revision: z.string(), query: z.string() }).strict().parse(JSON.parse(Buffer.from(raw, "base64url").toString()));
  if (value.revision !== revision || value.query !== query) throw new Error("The source changed or this cursor belongs to another query. Start a fresh read.");
  return value.offset;
}
const sourceResult = (data: Record<string, unknown>) => ({ output: JSON.stringify(data), summary: String(data.path ?? data.query ?? "Workspace observation"), data,
  intermediate: { type: "structured" as const, status: "complete" as const, origin: "source_extracted" as const, payload: data, sources: [{ filename: String(data.path ?? "."), relation: "source" as const }] } });
function authorize(context: ToolExecutionContext, operation: "write_file" | "edit_file" | "delete_file", args: Record<string, unknown>) {
  if (!context.policyGuard?.isEnforcingExplicit(context.runId) || !context.policyGuard.isAuthorized(context.runId, operation, { ...args, operation_digest: context.agentOperationDigest }, true)) throw new PermissionError("This exact operation needs approval for the current run.");
}
function tool(name: string, description: string, properties: AgentToolDefinition["function"]["parameters"]["properties"], required: string[], execute: AgentTool["execute"]): AgentTool {
  return { name, definition: { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } }, execute };
}
const pathProperty = { type: "string", description: "Workspace relative path" };

/** Check a concrete proposal before showing approval. The same conditions are rechecked under lock. */
export function validateAgentFileProposal(operation: string, args: Record<string, unknown>, context: ToolExecutionContext): void {
  const requested = relative.parse(args.path), canonical = canonicalSourcePath(context, requested), target = resolveSafe(context.workspaceRoot, canonical);
  const receipts = getExecutionLedger(context.runId)?.agentProgress?.reads ?? [];
  if (operation === "edit_file") {
    const replacements = z.array(z.object({ old: z.string().min(1), new: z.string() }).strict()).min(1).parse(args.replacements);
    const prepared = prepareFileEdit(context.workspaceRoot, { path: canonical, expectedDigest: digest.parse(args.expected_digest), replacements, requirementId: context.agentRequirementId ?? "", reason: context.agentChangeReason ?? "" }, receipts);
    validateAgentDependencyChange(context.agentDependencyConstraints, canonical, readAgentSourceBytes(context.workspaceRoot, canonical), prepared.after);
  } else if (existsSync(target)) {
    const bytes = readAgentSourceBytes(context.workspaceRoot, canonical), actual = fileDigest(bytes);
    if (actual !== args.expected_digest || (operation === "write_file" && args.replace_existing !== true) || !observedRange(receipts, canonical, actual, 0, bytes.length)) throw new PermissionError("This proposal needs the complete current source and matching digest. Use read_file or bounded edits first.");
  } else if (operation === "delete_file" || args.expected_digest) throw new PermissionError("The target is missing or changed.");
  if (operation !== "edit_file") validateAgentDependencyChange(context.agentDependencyConstraints, canonical, existsSync(target) ? readAgentSourceBytes(context.workspaceRoot, canonical) : undefined, operation === "delete_file" ? undefined : Buffer.from(z.string().parse(args.content)));
}

export const agentWorkspaceActions: AgentTool[] = [
  tool("read_file", "Read a bounded UTF-8 source page. Continue using its cursor. Returns file digest and byte/line ranges.", { path: pathProperty, start_line: { type: "integer", minimum: 1 }, max_bytes: { type: "integer", minimum: 64, maximum: 4000 }, cursor: { type: "string" } }, ["path"], async (args, context) => {
    const input = z.object({ path: relative, start_line: z.number().int().positive().default(1), max_bytes: z.number().int().min(64).max(4000).default(3000), cursor: z.string().max(4096).optional() }).strict().parse(args);
    const canonical = canonicalSourcePath(context, input.path), bytes = readAgentSourceBytes(context.workspaceRoot, canonical);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), revision = fileDigest(bytes);
    const lines = text.split("\n");
    if (!input.cursor && input.start_line > lines.length) throw new Error("The requested source line does not exist.");
    const start = input.cursor ? continueAt(input.cursor, revision, canonical) : Buffer.byteLength(lines.slice(0, input.start_line - 1).join("\n") + (input.start_line > 1 ? "\n" : ""));
    if (start > bytes.length || (start < bytes.length && (bytes[start] & 0xc0) === 0x80)) throw new Error("The source cursor is outside a UTF-8 boundary.");
    let end = Math.min(bytes.length, start + input.max_bytes);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    const data = { sourcePage: true, path: canonical, digest: revision, startByte: start, endByte: end, sizeBytes: bytes.length,
      startLine: bytes.subarray(0, start).toString().split("\n").length, endLine: bytes.subarray(0, end).toString().split("\n").length,
      content: bytes.subarray(start, end).toString(), complete: start === 0 && end === bytes.length,
      ...(end < bytes.length ? { nextCursor: sourcePageCursor(canonical,revision,end) } : {}) };
    return sourceResult(data);
  }),
  tool("list_dir", "List a bounded directory page. Continue using its cursor.", { path: pathProperty, cursor: { type: "string" } }, [], async (args, context) => {
    const input = z.object({ path: relative.default("."), cursor: z.string().max(4096).optional() }).strict().parse(args);
    resolveSafe(context.workspaceRoot, input.path); clearListDirCache();
    const entries = listDir(context.workspaceRoot, input.path), revision = fileDigest(JSON.stringify(entries)), offset = continueAt(input.cursor, revision, input.path);
    const selected = entries.slice(offset, offset + 30), next = offset + selected.length;
    return sourceResult({ path: input.path, revision, entries: selected, complete: next >= entries.length, ...(next < entries.length ? { nextCursor: cursor({ offset: next, revision, query: input.path }) } : {}) });
  }),
  tool("search", "Search source text with a revision-bound page cursor. Narrow the path for large projects.", { query: { type: "string" }, path: pathProperty, cursor: { type: "string" } }, ["query"], async (args, context) => {
    const input = z.object({ query: z.string().min(1).max(1024), path: relative.default("."), cursor: z.string().max(4096).optional() }).strict().parse(args);
    const target = resolveSafe(context.workspaceRoot, input.path);
    const revision = captureAgentVerificationManifest(context.workspaceRoot).sha256, query = fileDigest(JSON.stringify([input.query, input.path]));
    const offset = continueAt(input.cursor, revision, query), matches = search(context.workspaceRoot, input.query, input.path, offset + 21);
    const selected = matches.slice(offset, offset + 20), next = offset + selected.length;
    void target;
    return sourceResult({ path: input.path, query: input.query, revision, matches: selected, complete: matches.length <= next, ...(matches.length > next ? { nextCursor: cursor({ offset: next, revision, query }) } : {}) });
  }),
  tool("edit_file", "Apply exact unique replacements to inspected source. Supply its current digest. Existing code is preserved outside the anchors.", { path: pathProperty, expected_digest: { type: "string" }, replacements: { type: "array", items: { type: "object", properties: { old: { type: "string", format: "multiline" }, new: { type: "string", format: "multiline" } }, required: ["old", "new"], additionalProperties: false } } }, ["path", "expected_digest", "replacements"], async (args, context) => {
    const input = z.object({ path: relative, expected_digest: digest, replacements: z.array(z.object({ old: z.string().min(1), new: z.string() }).strict()).min(1).max(20) }).strict().parse(args);
    const canonical = canonicalSourcePath(context, input.path); authorize(context, "edit_file", { ...args, path: canonical });
    return context.policyGuard!.withMutationLock(`file:${canonical}`, () => {
      context.assertAuthority?.(); context.signal?.throwIfAborted();
      validateAgentFileProposal("edit_file", args, context);
      const result = editFile(context.workspaceRoot, { path: canonical, expectedDigest: input.expected_digest, replacements: input.replacements, requirementId: context.agentRequirementId ?? "", reason: context.agentChangeReason ?? "" }, getExecutionLedger(context.runId)?.agentProgress?.reads ?? []);
      context.harness?.notifyWorkspaceTreeUpdated();
      return { output: JSON.stringify(result), summary: `Edited ${canonical}`, data: result, intermediate: { type: "structured", status: "complete", origin: "execution", payload: result, sources: [{ filename: canonical, relation: "source" }] }, sideEffects: [`modified:${canonical}`] };
    });
  }),
  ...(["write_file", "delete_file"] as const).map(operation => tool(operation, operation === "write_file" ? "Create a complete new file. Replacing an existing file requires replace_existing, its digest, and a complete prior read." : "Delete a fully inspected file at its expected digest.", { path: pathProperty, ...(operation === "write_file" ? { content: { type: "string", format: "multiline" }, replace_existing: { type: "boolean" } } : {}), expected_digest: { type: "string" } }, operation === "write_file" ? ["path", "content"] : ["path", "expected_digest"], async (args, context) => {
    const input = z.object({ path: relative, content: z.string().optional(), replace_existing: z.boolean().optional(), expected_digest: digest.optional() }).strict().parse(args);
    if (operation === "write_file" && input.content === undefined) throw new Error("A complete write requires content.");
    const canonical = canonicalSourcePath(context, input.path); authorize(context, operation, { ...args, path: canonical });
    return context.policyGuard!.withMutationLock(`file:${canonical}`, () => {
      context.assertAuthority?.(); context.signal?.throwIfAborted();
      validateAgentFileProposal(operation, args, context);
      const target = resolveSafe(context.workspaceRoot, canonical);
      let beforeDigest: string | null = null;
      if (existsSync(target)) {
        const bytes = readAgentSourceBytes(context.workspaceRoot, canonical), revision = fileDigest(bytes); beforeDigest = revision;
        if (revision !== input.expected_digest || (operation === "write_file" && !input.replace_existing)) throw new PermissionError("Existing file replacement requires a fresh complete read, an expected digest, and explicit replacement.");
        if (!observedRange(getExecutionLedger(context.runId)?.agentProgress?.reads ?? [], canonical, revision, 0, bytes.length)) throw new PermissionError("The complete current source was not supplied to the model.");
      } else if (operation === "delete_file" || input.expected_digest) throw new PermissionError("The target file is missing or changed.");
      const result = operation === "write_file" ? writeFile(context.workspaceRoot, canonical, input.content!) : deleteFile(context.workspaceRoot, canonical);
      context.harness?.notifyWorkspaceTreeUpdated();
      const { backupPath, ...rest } = result;
      const data = { ...rest, beforeDigest, afterDigest: operation === "delete_file" ? null : fileDigest(input.content!), ...(backupPath === undefined ? {} : { backupPath }) };
      return { output: JSON.stringify(data), summary: `${operation} ${canonical}`, data, intermediate: { type: "structured", status: "complete", origin: "execution", payload: data, sources: [{ filename: canonical, relation: "source" }] }, sideEffects: [`${operation === "write_file" ? "modified" : "deleted"}:${canonical}`] };
    });
  })),
];
