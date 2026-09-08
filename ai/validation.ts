import type {
  ApprovalNoteSectionId,
  Citation,
  CodeDraftResult,
  DraftResult,
  Finding,
  PageReference,
  RetrievedKnowledgeChunk,
  ValidationFailure,
  VisionResult,
} from "./contracts";

export interface ValidationSuccess<T> {
  ok: true;
  value: T;
  issues: readonly [];
}

export interface ValidationFailureResult {
  ok: false;
  issues: readonly ValidationFailure[];
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailureResult;

export interface RequiredFindingRule {
  titleIncludes: string;
  page: number;
  valueIncludes: readonly string[];
}

export interface VisionValidationOptions {
  requiredFindings?: readonly RequiredFindingRule[];
}

export interface DraftValidationContext {
  retrievedChunks: readonly RetrievedKnowledgeChunk[];
  findings?: readonly Finding[];
  pageReferences?: readonly PageReference[];
  sourceText?: string;
  requiredCitations?: readonly Pick<Citation, "documentId" | "sectionId">[];
}

export interface CodeValidationOptions {
  allowedImports?: readonly string[];
  inputFiles?: readonly string[];
  outputFiles?: readonly string[];
  expectedResultIncludes?: string;
}

export const LOCKED_FLOW_A_REQUIRED_FINDINGS: readonly RequiredFindingRule[] = [
  { titleIncludes: "tube wall thickness", page: 1, valueIncludes: ["3.8", "4.2", "4.6"] },
  { titleIncludes: "pitting corrosion", page: 1, valueIncludes: ["1.8"] },
  { titleIncludes: "gasket degradation", page: 2, valueIncludes: ["replacement"] },
];

export const LOCKED_FLOW_B_CODE_RULES = {
  allowedImports: ["csv", "datetime"] as const,
  inputFiles: ["reactor-temperature-log.csv"] as const,
  outputFiles: ["out-of-range-rows.csv"] as const,
  expectedResult: "OUT_OF_RANGE 7/240 (high=5, low=2)",
};

export const REQUIRED_DRAFT_SECTIONS: readonly ApprovalNoteSectionId[] = [
  "equipment-header",
  "findings-summary",
  "recommendation",
  "grounding-references",
];

const MAX_SOURCE_TEXT = 100_000;
const MAX_FIELD_TEXT = 10_000;
const MAX_CODE_SOURCE = 100_000;
const STOP_WORDS = new Set(
  "a an and are as at be by for from in into is it of on or report result the this to with".split(" "),
);
const UNSAFE_CODE_PATTERNS: readonly [RegExp, string][] = [
  [/\b(?:subprocess|socket|requests|urllib|httpx|ftplib)\b/i, "network or process module"],
  [/(?:os\.system|Popen|shell\s*=|cmd\.exe|powershell|bash\s+-c|sh\s+-c)/i, "shell execution"],
  [/(?:\beval\s*\(|\bexec\s*\(|\bcompile\s*\(|__import__|globals\s*\(|locals\s*\()/i, "dynamic code execution"],
  [/(?:os\.environ|os\.getenv|pathlib|shutil|ctypes)\b/i, "environment or unrestricted filesystem access"],
  [/```/, "Markdown fence"],
];

function issue(
  path: string,
  code: ValidationFailure["code"],
  expected: string,
  received?: unknown,
): ValidationFailure {
  const message = `${path}: expected ${expected}`;
  return {
    kind: "validation-failure",
    code,
    message,
    path,
    expected,
    ...(received === undefined ? {} : { received: describe(received) }),
  };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function success<T>(value: T): ValidationSuccess<T> {
  return { ok: true, value, issues: [] };
}

function finish<T>(value: T, issues: ValidationFailure[]): ValidationResult<T> {
  return issues.length === 0 ? success(value) : { ok: false, issues };
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  issues: ValidationFailure[],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) issues.push(issue(`${path}.${key}`, "missing-field", "field present"));
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(issue(`${path}.${key}`, "extra-field", "no additional fields"));
  }
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationFailure[],
  max = MAX_FIELD_TEXT,
): value is Record<string, string> {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    issues.push(issue(`${path}.${key}`, "wrong-type", "non-empty string", candidate));
    return false;
  }
  if (candidate.length > max) issues.push(issue(`${path}.${key}`, "invalid-value", `string length <= ${max}`));
  return true;
}

function stringArray(value: unknown, path: string, issues: ValidationFailure[], nonEmpty = false): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    issues.push(issue(path, "wrong-type", "array of non-empty strings", value));
    return [];
  }
  if (nonEmpty && value.length === 0) issues.push(issue(path, "invalid-value", "at least one item"));
  return [...value];
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value).match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? [];
}

function meaningfulTokens(value: string): string[] {
  return tokens(value).filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function textSupportsClaim(claim: string, supportingText: string): boolean {
  const claimTokens = meaningfulTokens(claim);
  const sourceTokens = new Set(meaningfulTokens(supportingText));
  return claimTokens.length > 0 && claimTokens.every((token) => sourceTokens.has(token));
}

export function findUnsupportedClaims(text: string, supportingTexts: readonly string[]): string[] {
  const supportingText = supportingTexts.join(" ");
  return text
    .replace(/\[[^\]]+\]/g, "")
    .split(/[!?\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
    .filter((sentence) => meaningfulTokens(sentence).length > 0)
    .filter((sentence) => !textSupportsClaim(sentence, supportingText));
}

function validatePageReferences(value: unknown, issues: ValidationFailure[]): PageReference[] {
  if (!Array.isArray(value)) {
    issues.push(issue("pageReferences", "wrong-type", "array", value));
    return [];
  }
  const seen = new Set<string>();
  const refs: PageReference[] = [];
  value.forEach((entry, index) => {
    const path = `pageReferences[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue(path, "wrong-type", "object", entry));
      return;
    }
    exactKeys(entry, ["id", "page", "text"], ["location"], path, issues);
    const idOk = stringField(entry, "id", path, issues);
    const textOk = stringField(entry, "text", path, issues);
    if (typeof entry.page !== "number" || !Number.isInteger(entry.page) || entry.page < 1) {
      issues.push(issue(`${path}.page`, "invalid-value", "positive one-based integer", entry.page));
    }
    if ("location" in entry && typeof entry.location !== "string") {
      issues.push(issue(`${path}.location`, "wrong-type", "string", entry.location));
    }
    if (idOk && seen.has(entry.id)) issues.push(issue(`${path}.id`, "invalid-value", "unique page-reference ID"));
    if (idOk) seen.add(entry.id);
    if (idOk && textOk && typeof entry.page === "number") refs.push(entry as unknown as PageReference);
  });
  return refs;
}

export function validateRequiredFindings(
  result: Pick<VisionResult, "findings" | "pageReferences">,
  requiredFindings: readonly RequiredFindingRule[],
): readonly ValidationFailure[] {
  const refsById = new Map(result.pageReferences.map((ref) => [ref.id, ref]));
  const issues: ValidationFailure[] = [];
  for (const [index, rule] of requiredFindings.entries()) {
    const match = result.findings.some((finding) => {
      const refs = finding.pageReferenceIds.map((id) => refsById.get(id));
      return (
        finding.title.toLowerCase().includes(rule.titleIncludes.toLowerCase()) &&
        refs.some((ref) => ref?.page === rule.page) &&
        rule.valueIncludes.every((part) => finding.value.toLowerCase().includes(part.toLowerCase()))
      );
    });
    if (!match) issues.push(issue(`findings.required[${index}]`, "invalid-value", "required evidence-backed finding"));
  }
  return issues;
}

export function validateVisionResult(input: unknown, options: VisionValidationOptions = {}): ValidationResult<VisionResult> {
  const issues: ValidationFailure[] = [];
  if (!isRecord(input)) return { ok: false, issues: [issue("result", "wrong-type", "object", input)] };
  exactKeys(input, ["sourceText", "findings", "pageReferences"], ["warnings"], "result", issues);
  const sourceTextOk = stringField(input, "sourceText", "result", issues, MAX_SOURCE_TEXT);
  const refs = validatePageReferences(input.pageReferences, issues);
  const warnings = "warnings" in input ? stringArray(input.warnings, "result.warnings", issues) : [];
  if (!Array.isArray(input.findings)) {
    issues.push(issue("result.findings", "wrong-type", "array", input.findings));
  } else {
    const seen = new Set<string>();
    const refsById = new Map(refs.map((ref) => [ref.id, ref]));
    input.findings.forEach((entry, index) => {
      const path = `result.findings[${index}]`;
      if (!isRecord(entry)) {
        issues.push(issue(path, "wrong-type", "object", entry));
        return;
      }
      exactKeys(entry, ["findingId", "title", "value", "pageReferenceIds", "confidence", "evidence"], [], path, issues);
      const idOk = stringField(entry, "findingId", path, issues);
      const titleOk = stringField(entry, "title", path, issues);
      const valueOk = stringField(entry, "value", path, issues);
      const evidenceOk = stringField(entry, "evidence", path, issues);
      const ids = stringArray(entry.pageReferenceIds, `${path}.pageReferenceIds`, issues, true);
      if (!idOk || (idOk && seen.has(entry.findingId))) issues.push(issue(`${path}.findingId`, "invalid-value", "unique finding ID"));
      if (idOk) seen.add(entry.findingId);
      if (entry.confidence !== "high" && entry.confidence !== "medium" && entry.confidence !== "low") {
        issues.push(issue(`${path}.confidence`, "invalid-value", "high, medium, or low", entry.confidence));
      }
      const missingRefs = ids.filter((id) => !refsById.has(id));
      if (missingRefs.length) issues.push(issue(`${path}.pageReferenceIds`, "invalid-value", "IDs present in pageReferences"));
      if (sourceTextOk && valueOk && evidenceOk) {
        const evidenceText = [input.sourceText as string, ...ids.map((id) => refsById.get(id)?.text ?? "")].join(" ");
        if (!textSupportsClaim(entry.value, evidenceText)) {
          issues.push(issue(`${path}.value`, "invalid-value", "claim supported by sourceText or referenced page text"));
        }
      }
      if (titleOk && valueOk && evidenceOk && ids.length === 0) {
        issues.push(issue(path, "missing-field", "finding with page evidence"));
      }
    });
  }
  if (sourceTextOk && Array.isArray(input.findings)) {
    const findings = input.findings as unknown as Finding[];
    issues.push(...validateRequiredFindings({ findings, pageReferences: refs }, options.requiredFindings ?? []));
  }
  return finish(input as unknown as VisionResult, issues);
}

function validateChunk(entry: unknown, path: string, issues: ValidationFailure[]): RetrievedKnowledgeChunk | undefined {
  if (!isRecord(entry)) {
    issues.push(issue(path, "wrong-type", "object", entry));
    return undefined;
  }
  exactKeys(entry, ["chunkId", "documentId", "sectionId", "label", "documentTitle", "excerpt"], ["score"], path, issues);
  for (const key of ["chunkId", "documentId", "sectionId", "label", "documentTitle", "excerpt"]) stringField(entry, key, path, issues);
  if ("score" in entry && (typeof entry.score !== "number" || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1)) {
    issues.push(issue(`${path}.score`, "invalid-value", "finite number from 0 through 1", entry.score));
  }
  return entry as unknown as RetrievedKnowledgeChunk;
}

export function validateRetrievedChunks(input: unknown): ValidationResult<RetrievedKnowledgeChunk[]> {
  const issues: ValidationFailure[] = [];
  if (!Array.isArray(input)) return { ok: false, issues: [issue("retrievedChunks", "wrong-type", "array", input)] };
  const chunks = input.map((entry, index) => validateChunk(entry, `retrievedChunks[${index}]`, issues)).filter(Boolean) as RetrievedKnowledgeChunk[];
  const seen = new Set<string>();
  chunks.forEach((chunk, index) => {
    if (seen.has(chunk.chunkId)) issues.push(issue(`retrievedChunks[${index}].chunkId`, "invalid-value", "unique chunk ID"));
    seen.add(chunk.chunkId);
  });
  return finish(chunks, issues);
}

function validateCitation(entry: unknown, path: string, issues: ValidationFailure[]): Citation | undefined {
  if (!isRecord(entry)) {
    issues.push(issue(path, "wrong-type", "object", entry));
    return undefined;
  }
  exactKeys(entry, ["documentId", "sectionId", "label", "inlineText"], ["supportingExcerpt"], path, issues);
  for (const key of ["documentId", "sectionId", "label", "inlineText"]) stringField(entry, key, path, issues);
  if (typeof entry.documentId === "string" && typeof entry.sectionId === "string") {
    const label = `${entry.documentId} §${entry.sectionId}`;
    if (entry.label !== label) issues.push(issue(`${path}.label`, "invalid-value", `exactly ${label}`));
    if (entry.inlineText !== `[${label}]`) issues.push(issue(`${path}.inlineText`, "invalid-value", `exactly [${label}]`));
  }
  if ("supportingExcerpt" in entry && typeof entry.supportingExcerpt !== "string") {
    issues.push(issue(`${path}.supportingExcerpt`, "wrong-type", "string", entry.supportingExcerpt));
  }
  return entry as unknown as Citation;
}

function hasMissingSourceNotice(result: DraftResult): boolean {
  return result.missingInformation.some((item) => /source|retriev|knowledge|sop|template/i.test(item.field) && item.note.trim().length > 0);
}

export function validateDraftResult(input: unknown, context: DraftValidationContext): ValidationResult<DraftResult> {
  const issues: ValidationFailure[] = [];
  if (!isRecord(input)) return { ok: false, issues: [issue("result", "wrong-type", "object", input)] };
  exactKeys(input, ["title", "body", "sections", "citations", "missingInformation"], [], "result", issues);
  stringField(input, "title", "result", issues);
  stringField(input, "body", "result", issues);
  const sections: Record<string, unknown>[] = [];
  if (!Array.isArray(input.sections)) issues.push(issue("result.sections", "wrong-type", "array", input.sections));
  else input.sections.forEach((entry, index) => {
    const path = `result.sections[${index}]`;
    if (!isRecord(entry)) return issues.push(issue(path, "wrong-type", "object", entry));
    exactKeys(entry, ["id", "heading", "body"], [], path, issues);
    stringField(entry, "id", path, issues); stringField(entry, "heading", path, issues); stringField(entry, "body", path, issues);
    sections.push(entry);
  });
  const expectedIds = REQUIRED_DRAFT_SECTIONS;
  if (sections.length !== expectedIds.length || sections.some((section, index) => section.id !== expectedIds[index])) {
    issues.push(issue("result.sections", "invalid-value", `exactly these IDs in order: ${expectedIds.join(", ")}`));
  }
  const citations: Citation[] = [];
  if (!Array.isArray(input.citations)) issues.push(issue("result.citations", "wrong-type", "array", input.citations));
  else input.citations.forEach((entry, index) => {
    const citation = validateCitation(entry, `result.citations[${index}]`, issues);
    if (citation) citations.push(citation);
  });
  const missingInformation: { field: string; note: string }[] = [];
  if (!Array.isArray(input.missingInformation)) issues.push(issue("result.missingInformation", "wrong-type", "array", input.missingInformation));
  else input.missingInformation.forEach((entry, index) => {
    const path = `result.missingInformation[${index}]`;
    if (!isRecord(entry)) return issues.push(issue(path, "wrong-type", "object", entry));
    exactKeys(entry, ["field", "note"], [], path, issues);
    const fieldOk = stringField(entry, "field", path, issues); const noteOk = stringField(entry, "note", path, issues);
    if (fieldOk && noteOk) missingInformation.push({ field: entry.field, note: entry.note });
  });
  if (issues.length) return { ok: false, issues };
  const result = input as unknown as DraftResult;
  const chunks = context.retrievedChunks;
  if (chunks.length === 0) {
    if (citations.length > 0 || /\[[^\]]+\s§[^\]]+\]/.test(result.body + " " + sections.map((s) => s.body).join(" "))) {
      issues.push(issue("result.citations", "invalid-value", "no citations when retrieval returns no sources"));
    }
    if (!hasMissingSourceNotice(result)) issues.push(issue("result.missingInformation", "missing-field", "explicit no-source notice"));
  } else {
    const identities = new Set(chunks.map((chunk) => `${chunk.documentId}:${chunk.sectionId}`));
    citations.forEach((citation, index) => {
      const identity = `${citation.documentId}:${citation.sectionId}`;
      if (!identities.has(identity)) issues.push(issue(`result.citations[${index}]`, "invalid-value", "citation present in retrievedChunks"));
      const chunk = chunks.find((candidate) => `${candidate.documentId}:${candidate.sectionId}` === identity);
      if (citation.supportingExcerpt && chunk && !normalize(chunk.excerpt).includes(normalize(citation.supportingExcerpt))) {
        issues.push(issue(`result.citations[${index}].supportingExcerpt`, "invalid-value", "excerpt contained in retrieved chunk"));
      }
    });
    for (const required of context.requiredCitations ?? []) {
      if (!citations.some((citation) => citation.documentId === required.documentId && citation.sectionId === required.sectionId)) {
        issues.push(issue("result.citations", "missing-field", `required citation ${required.documentId} §${required.sectionId}`));
      }
    }
  }
  const supportingTexts = [
    ...(context.sourceText ? [context.sourceText] : []),
    ...(context.findings ?? []).flatMap((finding) => [finding.title, finding.value, finding.evidence]),
    ...(context.pageReferences ?? []).map((ref) => ref.text),
    ...chunks.map((chunk) => chunk.excerpt),
  ];
  const draftText = [result.body, ...sections.map((section) => section.body)].join("\n");
  if (chunks.length > 0) {
    for (const claim of findUnsupportedClaims(draftText, supportingTexts)) {
      issues.push(issue("result.body", "invalid-value", `claim grounded in supplied findings or retrieved sources: ${claim}`));
    }
  }
  return finish(result, issues);
}

function logicalFilename(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..");
}

export function validateCodeDraftResult(input: unknown, options: CodeValidationOptions = {}): ValidationResult<CodeDraftResult> {
  const issues: ValidationFailure[] = [];
  if (!isRecord(input)) return { ok: false, issues: [issue("result", "wrong-type", "object", input)] };
  exactKeys(input, ["filename", "source", "expectedResult", "inputFiles", "outputFiles", "allowedImports"], [], "result", issues);
  stringField(input, "filename", "result", issues, 100);
  stringField(input, "source", "result", issues, MAX_CODE_SOURCE);
  stringField(input, "expectedResult", "result", issues);
  const inputFiles = stringArray(input.inputFiles, "result.inputFiles", issues, true);
  const outputFiles = stringArray(input.outputFiles, "result.outputFiles", issues, true);
  const allowedImports = stringArray(input.allowedImports, "result.allowedImports", issues);
  if (input.filename !== "task.py") issues.push(issue("result.filename", "invalid-value", "task.py"));
  for (const [path, files] of [["result.inputFiles", inputFiles], ["result.outputFiles", outputFiles]] as const) {
    files.forEach((file) => { if (!logicalFilename(file)) issues.push(issue(path, "invalid-value", "logical filename without path separators")); });
  }
  const expectedInputs = options.inputFiles ?? LOCKED_FLOW_B_CODE_RULES.inputFiles;
  const expectedOutputs = options.outputFiles ?? LOCKED_FLOW_B_CODE_RULES.outputFiles;
  if (JSON.stringify(inputFiles) !== JSON.stringify(expectedInputs)) issues.push(issue("result.inputFiles", "invalid-value", `exactly ${expectedInputs.join(", ")}`));
  if (JSON.stringify(outputFiles) !== JSON.stringify(expectedOutputs)) issues.push(issue("result.outputFiles", "invalid-value", `exactly ${expectedOutputs.join(", ")}`));
  const allowed = new Set(options.allowedImports ?? LOCKED_FLOW_B_CODE_RULES.allowedImports);
  allowedImports.forEach((name) => { if (!allowed.has(name)) issues.push(issue("result.allowedImports", "invalid-value", "approved import names only")); });
  if (new Set(allowedImports).size !== allowedImports.length) issues.push(issue("result.allowedImports", "invalid-value", "unique import names"));
  const expectedResult = options.expectedResultIncludes ?? LOCKED_FLOW_B_CODE_RULES.expectedResult;
  if (typeof input.expectedResult === "string" && !input.expectedResult.includes(expectedResult)) issues.push(issue("result.expectedResult", "invalid-value", `contains ${expectedResult}`));
  if (typeof input.source === "string") {
    for (const [pattern, description] of UNSAFE_CODE_PATTERNS) if (pattern.test(input.source)) issues.push(issue("result.source", "invalid-value", `no ${description}`));
    const importPattern = /^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_.]*)/gm;
    for (const match of input.source.matchAll(importPattern)) if (!allowed.has(match[1].split(".")[0])) issues.push(issue("result.source", "invalid-value", "imports from approved modules only"));
    for (const match of input.source.matchAll(/\bopen\s*\(\s*(["'])([^"']+)\1/g)) if (!expectedInputs.includes(match[2]) && !expectedOutputs.includes(match[2])) issues.push(issue("result.source", "invalid-value", "open only fixed input/output filenames"));
    if (!input.source.includes(expectedInputs[0]) || !input.source.includes(expectedOutputs[0])) issues.push(issue("result.source", "invalid-value", "reads and writes the declared fixture files"));
    if (/OUT_OF_RANGE\s+7\/240|high\s*=\s*5|low\s*=\s*2/.test(input.source)) issues.push(issue("result.source", "invalid-value", "calculate results instead of hard-coding expected counts"));
  }
  return finish(input as unknown as CodeDraftResult, issues);
}
