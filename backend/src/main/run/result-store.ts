import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { IntermediateResultInput, IntermediateResultRecord, ResultSlice, ResultSliceRequest } from "../../shared/contracts.js";
import { getDb } from "../persistence/db.js";
import { resolveSafe, PermissionError } from "../harness/path-guard.js";
import { dataRoot } from "./filesystem.js";

export const RESULT_SUMMARY_MAX_CHARS = 512;
export const RESULT_SLICE_MAX_CHARS = 3000;
export const RESULT_PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;
const sourceSchema = z.object({
  filename: z.string().max(1024).optional(), resultId: z.string().uuid().optional(),
  page: z.number().int().positive().optional(), section: z.string().max(1024).optional(),
  sheet: z.string().max(1024).optional(), range: z.string().max(1024).optional(),
  textSpan: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).refine((span) => span.end >= span.start).optional(),
  locator: z.string().max(1024).optional(), relation: z.enum(["source", "input"]),
}).refine((source) => Boolean(source.filename || source.resultId), "Source requires a file or upstream result");
const inputSchema = z.object({
  type: z.enum(["text", "document", "table", "structured", "execution"]), status: z.enum(["complete", "partial"]),
  origin: z.enum(["source_extracted", "model_derived", "execution"]),
  producer: z.object({ tool: z.string().min(1).max(128), callId: z.string().min(1).max(256) }),
  summary: z.string(), payload: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]),
  structuredSchema: z.record(z.unknown()).optional(), sources: z.array(sourceSchema).default([]),
});
type ResultRow = {
  result_id: string; run_id: string; schema_version: number; result_type: IntermediateResultRecord["type"];
  status: IntermediateResultRecord["status"]; origin: IntermediateResultRecord["origin"]; relative_path: string;
  encoding: "utf8" | "json"; size_bytes: number; sha256: string; producer_tool: string; producer_call_id: string;
  summary: string; structured_schema_json: string | null; sources_json: string; created_at: string;
};

/** Run-bound facade over existing SQLite and intermediate files; contains no conversation state. */
export class RunResultStore {
  private readonly root: string;
  constructor(readonly runId: string, private readonly db: Database.Database = getDb(), root = dataRoot()) {
    z.string().uuid().parse(runId);
    this.root = path.resolve(root);
  }

  isStoragePath(absolutePath: string): boolean {
    const storageRoot = path.join(realpathSync(this.root), "runs", this.runId, "intermediate", "results");
    const target = path.resolve(absolutePath);
    return target === storageRoot || target.startsWith(`${storageRoot}${path.sep}`);
  }

  private payloadPath(resultId: string, encoding: "utf8" | "json", create = false): string {
    z.string().uuid().parse(resultId);
    if (create) mkdirSync(this.root, { recursive: true });
    const base = realpathSync(this.root);
    const relative = `runs/${this.runId}/intermediate/results/${resultId}.${encoding === "json" ? "json" : "txt"}`;
    const resolved = resolveSafe(base, relative);
    // Reject symlink aliases, including aliases into another run or another run area.
    if (resolved !== path.join(base, relative)) throw new PermissionError("Result path escapes authorized run storage through an alias");
    if (create) mkdirSync(path.dirname(resolved), { recursive: true });
    return resolved;
  }

  registerResult(input: IntermediateResultInput): IntermediateResultRecord {
    const parsed = inputSchema.parse(input);
    if (!this.db.prepare("SELECT 1 FROM runs WHERE id=?").get(this.runId)) throw new Error("Result registration requires an existing run");
    for (const source of parsed.sources) if (source.resultId) this.getResult(source.resultId); // run isolation also applies to lineage
    const encoding = typeof parsed.payload === "string" ? "utf8" : "json";
    const text = typeof parsed.payload === "string" ? parsed.payload : JSON.stringify(parsed.payload, (_key, value: unknown) => {
      if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Result payload contains a non-JSON value; no data was discarded");
      return value;
    });
    if (text === undefined) throw new Error("Result payload is not serializable");
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > RESULT_PAYLOAD_MAX_BYTES) throw new Error(`Result payload exceeds ${RESULT_PAYLOAD_MAX_BYTES} bytes; no payload was truncated`);
    const schemaJson = parsed.structuredSchema ? JSON.stringify(parsed.structuredSchema) : null;
    const sourcesJson = JSON.stringify(parsed.sources);
    if (Buffer.byteLength(sourcesJson) + Buffer.byteLength(schemaJson ?? "") > 256 * 1024) throw new Error("Result metadata exceeds limit; no payload was truncated");
    const resultId = randomUUID();
    const target = this.payloadPath(resultId, encoding, true);
    const temp = `${target}.pending-${randomUUID()}`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let fd: number | undefined;
    let published = false;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      // Atomic exclusive publication: unlike rename, never overwrite an immutable payload.
      linkSync(temp, target); published = true;
      unlinkSync(temp);
      const dirFd = openSync(path.dirname(target), "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      this.db.transaction(() => {
        this.db.prepare(`INSERT INTO intermediate_results
          (result_id,run_id,schema_version,result_type,status,origin,relative_path,encoding,size_bytes,sha256,producer_tool,producer_call_id,summary,structured_schema_json,sources_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          resultId, this.runId, 1, parsed.type, parsed.status, parsed.origin,
          `intermediate/results/${path.basename(target)}`, encoding, bytes.length, sha256,
          parsed.producer.tool, parsed.producer.callId, parsed.summary.slice(0, RESULT_SUMMARY_MAX_CHARS), schemaJson, sourcesJson, new Date().toISOString(),
        );
      })();
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
      if (published && existsSync(target)) unlinkSync(target);
      throw error;
    }
    return this.getResult(resultId);
  }

  getResult(resultId: string): IntermediateResultRecord {
    z.string().uuid().parse(resultId);
    const row = this.db.prepare("SELECT * FROM intermediate_results WHERE result_id=? AND run_id=?").get(resultId, this.runId) as ResultRow | undefined;
    if (!row) throw new PermissionError("Result is unavailable in the authorized run");
    if (row.schema_version !== 1) throw new Error(`Unsupported result schema version: ${row.schema_version}`);
    const expected = `intermediate/results/${resultId}.${row.encoding === "json" ? "json" : "txt"}`;
    if (row.relative_path !== expected) throw new PermissionError("Result metadata path escapes authorized run storage");
    this.payloadPath(resultId, row.encoding);
    return {
      schemaVersion: 1, resultId: row.result_id, runId: row.run_id, type: row.result_type, status: row.status, origin: row.origin,
      producer: { tool: row.producer_tool, callId: row.producer_call_id }, createdAt: row.created_at,
      storage: { relativePath: row.relative_path, encoding: row.encoding, sizeBytes: row.size_bytes, sha256: row.sha256 },
      summary: row.summary, structuredSchema: row.structured_schema_json ? JSON.parse(row.structured_schema_json) : undefined,
      sources: sourceSchema.array().parse(JSON.parse(row.sources_json)),
    };
  }

  verifyIntegrity(resultId: string): { valid: boolean; reason: string } {
    try {
      const record = this.getResult(resultId);
      const target = this.payloadPath(resultId, record.storage.encoding);
      const stat = statSync(target);
      if (!stat.isFile() || stat.size !== record.storage.sizeBytes || stat.size > RESULT_PAYLOAD_MAX_BYTES) return { valid: false, reason: "Stored result is missing or its size does not match the manifest." };
      const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
      if (digest !== record.storage.sha256) return { valid: false, reason: "Stored result SHA-256 does not match the manifest." };
      return { valid: true, reason: "Stored result SHA-256 matches the manifest." };
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message.slice(0, 240) : "Stored result could not be verified." };
    }
  }

  listResults(options: { limit?: number; offset?: number } = {}): IntermediateResultRecord[] {
    const limit = z.number().int().min(1).max(50).parse(options.limit ?? 10);
    const offset = z.number().int().nonnegative().parse(options.offset ?? 0);
    const rows = this.db.prepare("SELECT result_id FROM intermediate_results WHERE run_id=? ORDER BY created_at,result_id LIMIT ? OFFSET ?").all(this.runId, limit, offset) as Array<{ result_id: string }>;
    return rows.map((row) => this.getResult(row.result_id));
  }

  inspectResult(resultId: string, sourceOffset = 0, sourceCount = 5) {
    z.number().int().nonnegative().parse(sourceOffset);
    z.number().int().min(1).max(20).parse(sourceCount);
    const record = this.getResult(resultId);
    return { ...record, sources: record.sources.slice(sourceOffset, sourceOffset + sourceCount), sourceCount: record.sources.length, nextSourceOffset: sourceOffset + sourceCount < record.sources.length ? sourceOffset + sourceCount : undefined };
  }

  retrieveResultSlice(resultId: string, request: ResultSliceRequest = { mode: "text" }): ResultSlice {
    const record = this.getResult(resultId);
    const target = this.payloadPath(resultId, record.storage.encoding);
    if (!statSync(target).isFile() || statSync(target).size !== record.storage.sizeBytes || record.storage.sizeBytes > RESULT_PAYLOAD_MAX_BYTES) throw new Error("Result payload size/integrity mismatch");
    const bytes = readFileSync(target);
    if (createHash("sha256").update(bytes).digest("hex") !== record.storage.sha256) throw new Error("Result payload checksum mismatch");
    const maxChars = z.number().int().min(1).max(RESULT_SLICE_MAX_CHARS).parse(request.maxChars ?? 2000);
    const text = bytes.toString("utf8");
    if (request.mode === "text") {
      const offset = z.number().int().nonnegative().parse(request.offset ?? 0);
      const content = text.slice(offset, offset + maxChars);
      return { resultId, content, totalChars: text.length, truncated: offset + content.length < text.length, nextOffset: offset + content.length < text.length ? offset + content.length : undefined };
    }
    if (request.mode === "lines") {
      const start = z.number().int().min(1).parse(request.startLine ?? 1) - 1;
      const count = z.number().int().min(1).max(100).parse(request.count ?? 20);
      const lines = text.split("\n");
      const selected = lines.slice(start, start + count).join("\n");
      const content = selected.slice(0, maxChars);
      return { resultId, content, totalChars: selected.length, truncated: selected.length > content.length || start + count < lines.length,
        // A long line is recovered by text offset instead of incorrectly advancing past omitted content.
        nextOffset: selected.length > content.length ? lines.slice(0, start).reduce((n, line) => n + line.length + 1, 0) + content.length : undefined,
        nextLine: selected.length <= content.length && start + count < lines.length ? start + count + 1 : undefined };
    }
    if (request.mode !== "json" || record.storage.encoding !== "json") throw new Error("JSON slicing requires a structured result and mode=json");
    const pointer = request.pointer ?? "";
    if (pointer.length > 2048 || (pointer && !pointer.startsWith("/"))) throw new Error("Invalid JSON pointer");
    let value: unknown = JSON.parse(text);
    for (const segment of pointer ? pointer.slice(1).split("/") : []) {
      if (/~(?:[^01]|$)/.test(segment)) throw new Error("Invalid JSON pointer escape");
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) throw new Error("JSON pointer does not identify stored data");
      value = (value as Record<string, unknown>)[key];
    }
    const start = z.number().int().nonnegative().parse(request.start ?? 0);
    const count = z.number().int().min(1).max(100).parse(request.count ?? 10);
    const array = Array.isArray(value) ? value : undefined;
    const selection = array ? array.slice(start, start + count) : value;
    const selected = typeof selection === "string" ? selection : JSON.stringify(selection, null, 2);
    const offset = z.number().int().nonnegative().parse(request.offset ?? 0);
    const content = selected.slice(offset, offset + maxChars);
    return { resultId, content, totalChars: selected.length, truncated: offset + content.length < selected.length || Boolean(array && start + count < array.length),
      nextOffset: offset + content.length < selected.length ? offset + content.length : undefined,
      nextStart: array && offset + content.length >= selected.length && start + count < array.length ? start + count : undefined };
  }
}
