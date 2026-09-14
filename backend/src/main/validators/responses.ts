import { z } from "zod";
import type { ChatResult, CodeDraftResult, Finding, VisionResult } from "../../shared/contracts.js";
const page = z.object({ id: z.string().min(1), page: z.number().int().positive(), text: z.string().min(1).max(8000), location: z.string().max(200).optional() }).strict();
const finding = z.object({ findingId: z.string().min(1), title: z.string().min(1).max(200), value: z.string().min(1).max(1000), pageReferenceIds: z.array(z.string().min(1)).min(1), confidence: z.enum(["high", "medium", "low"]), evidence: z.string().min(1).max(2000) }).strict();
export const visionResultSchema = z.object({ sourceText: z.string().max(50000), findings: z.array(finding), pageReferences: z.array(page), warnings: z.array(z.string().max(500)).optional() }).strict();
const nullableOptional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === null || (typeof value === "string" && value.trim() === "") ? undefined : value), schema.optional());
export const codeResultSchema = z.object({
  filename: z.literal("task.py"),
  source: z.string().min(1).max(30000),
  expectedResult: z.string().min(1).max(4000),
  inputFiles: z.array(z.string().min(1)),
  outputFiles: z.array(z.string().min(1)),
  allowedImports: z.array(z.string().min(1)),
  outputMode: nullableOptional(z.enum(["chat", "artifact", "chat_and_artifact"])),
  artifactKind: nullableOptional(z.enum(["docx", "pdf", "xlsx", "csv", "txt", "json", "md"])),
  artifactFilename: nullableOptional(z.string().min(1).max(200)),
  artifactRationale: nullableOptional(z.string().max(1000)),
}).strict();
export const codeSummarySchema = z.object({
  summary: z.string().min(1).max(4000),
  verified: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() === "true" : v), z.boolean()),
}).strict();
export const chatResultSchema = z.object({ text: z.string().min(1).max(40000) });
function failure(error: z.ZodError) {
  const first = error.issues[0];
  const field = first.path.join(".");
  const msg = field ? `field '${field}': ${first.message}` : first.message;
  return {
    kind: "validation-failure" as const,
    code: first.code === "unrecognized_keys" ? "extra-field" as const : first.code === "invalid_type" ? "wrong-type" as const : "invalid-value" as const,
    message: msg,
    path: field,
    expected: "valid response"
  };
}
// Bare zod messages ("String must contain at least 1 character(s)") are
// useless in the UI. Always surface the failing field and what was expected.
export function validationMessage(label: string, error: { message: string; path: string; expected: string }): string {
  return `${label} failed validation at '${error.path || "<root>"}': ${error.message} (expected ${error.expected})`;
}
export function validateVision(value: unknown): { ok: true; value: VisionResult } | { ok: false; error: ReturnType<typeof failure> } { const parsed = visionResultSchema.safeParse(value); return parsed.success ? { ok: true, value: parsed.data as VisionResult } : { ok: false, error: failure(parsed.error) }; }
const SAFE_IMPORTS = new Set(["csv", "datetime", "math"]);

export function sanitizePythonSource(source: string): string {
  if (!source) return source;

  // 1. Unescape double-escaped newlines if real newlines are absent or sparse
  const realNewlines = (source.match(/\n/g) || []).length;
  const escapedNewlines = (source.match(/\\n/g) || []).length;
  if (escapedNewlines > 0 && (realNewlines <= 1 || escapedNewlines >= realNewlines)) {
    source = source.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n");
  }

  // 2. Strip markdown code fences if model enclosed code inside fences
  source = source.replace(/^```(?:python|py)?[\r\n\s]*/i, "").replace(/[\r\n\s]*```$/g, "").trim();

  const lines = source.split(/\r?\n/);
  const result: string[] = [];
  let inWith = false;
  let parenDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Normalize leading tabs / escaped tabs to 4 spaces to prevent TabError and backslash syntax errors
    line = line.replace(/^([ \t]|\\+t)+/, (indent) => {
      let spaces = 0;
      let j = 0;
      while (j < indent.length) {
        if (indent[j] === " ") {
          spaces += 1;
          j += 1;
        } else if (indent[j] === "\t") {
          spaces += 4;
          j += 1;
        } else {
          const m = indent.slice(j).match(/^\\+t/);
          if (m) {
            spaces += 4;
            j += m[0].length;
          } else {
            j += 1;
          }
        }
      }
      return " ".repeat(spaces);
    });

    const trimmed = line.trim();

    if (/^\s*with\b/.test(line)) {
      inWith = true;
    }

    for (const ch of line) {
      if (ch === "(" || ch === "[" || ch === "{") parenDepth++;
      else if (ch === ")" || ch === "]" || ch === "}") parenDepth = Math.max(0, parenDepth - 1);
    }

    if (inWith && parenDepth === 0) {
      // If line ends with a comma without an unclosed parenthesis or trailing backslash, add backslash
      if (/,\s*$/.test(line) && !/\\\s*$/.test(line)) {
        line = line.replace(/\s*$/, " \\");
      }
      if (trimmed.endsWith(":")) {
        inWith = false;
      }
    }

    result.push(line);
  }
  return result.join("\n");
}

function unsafePython(source: string): boolean { return /(subprocess|socket|requests|urllib|httpx|os\.system|eval\s*\(|exec\s*\(|__import__|https?:\/\/|\b(import|from)\s+(os|sys|pathlib|shutil|ctypes)\b)/i.test(source) || /open\s*\([^)]*(\/|\\\\|\.\.)/i.test(source); }
function unsafeName(name: string): boolean { return !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes(".."); }
export function validateCode(value: unknown): { ok: true; value: CodeDraftResult } | { ok: false; error: ReturnType<typeof failure> } {
  const parsed = codeResultSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: failure(parsed.error) };
  const result = parsed.data;
  result.source = sanitizePythonSource(result.source);
  const declaredFiles = [...result.inputFiles, ...result.outputFiles];
  const importPattern = /^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_.]*)/gm;
  const imports = [...result.source.matchAll(importPattern)].map((match) => match[1].split(".")[0]);
  const declaredImports = new Set(result.allowedImports);
  const wantsArtifact = result.outputMode === "artifact" || result.outputMode === "chat_and_artifact";
  const invalid = unsafePython(result.source)
    || result.inputFiles.length !== 1
    || result.inputFiles.some(unsafeName)
    || result.outputFiles.some(unsafeName)
    || result.allowedImports.some((name) => !SAFE_IMPORTS.has(name))
    || (wantsArtifact && (!result.artifactKind || !result.artifactFilename || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(xlsx|csv|txt|json|md)$/i.test(result.artifactFilename)))
    || new Set(declaredFiles).size !== declaredFiles.length
    || imports.some((name) => !SAFE_IMPORTS.has(name) || !declaredImports.has(name));
  if (invalid) return { ok: false, error: { kind: "validation-failure", code: "invalid-value", message: "generated Python must use one safe CSV input, approved standard-library imports, and no network/shell/path escape; outputs must be declared when requested", path: "source", expected: "validated local Python task" } };
  return { ok: true, value: result as CodeDraftResult };
}
export function validateCodeSummary(value: unknown) { const parsed = codeSummarySchema.safeParse(value); return parsed.success ? { ok: true as const, value: parsed.data } : { ok: false as const, error: failure(parsed.error) }; }
export function validateChat(value: unknown): { ok: true; value: ChatResult } | { ok: false; error: ReturnType<typeof failure> } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return { ok: true, value: { text: trimmed.slice(0, 40000) } };
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (obj.text !== undefined && obj.text !== null) {
      const str = String(obj.text).trim();
      if (str.length > 0) {
        return { ok: true, value: { text: str.slice(0, 40000) } };
      }
    }

    const altKeys = ["message", "response", "answer", "reply", "content", "output", "result", "summary"];
    for (const k of altKeys) {
      if (obj[k] !== undefined && obj[k] !== null) {
        const str = typeof obj[k] === "object" ? JSON.stringify(obj[k]) : String(obj[k]).trim();
        if (str.length > 0) {
          return { ok: true, value: { text: str.slice(0, 40000) } };
        }
      }
    }

    const keys = Object.keys(obj);
    if (keys.length === 1 && obj[keys[0]] !== undefined && obj[keys[0]] !== null) {
      const val = obj[keys[0]];
      const str = typeof val === "object" ? JSON.stringify(val) : String(val).trim();
      if (str.length > 0) {
        return { ok: true, value: { text: str.slice(0, 40000) } };
      }
    }
  }

  const parsed = chatResultSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data as ChatResult } : { ok: false, error: failure(parsed.error) };
}
export type ValidatedFinding = Finding;
