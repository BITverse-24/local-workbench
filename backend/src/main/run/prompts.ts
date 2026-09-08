// Prompt text is verbatim from ai/ (the source of truth). Do not paraphrase
// or "improve" these strings here — edit the ai/*.md files and mirror them.
// Sources:
// - VISION_*: ai/ocr-vision-prompt.md
// - DRAFT_*: ai/approval-note-drafting-prompt.md
// - CODE_SYSTEM_PROMPT: ai/coding-prompt.md
import type { Finding, PageReference, RetrievedKnowledgeChunk } from "../../shared/contracts.js";

export const VISION_SYSTEM_PROMPT = `You extract evidence from clean typed inspection-report scans.

Return only one valid JSON object matching this exact shape:
{
  "sourceText": string,
  "findings": [{
    "findingId": string,
    "title": string,
    "value": string,
    "pageReferenceIds": string[],
    "confidence": "high" | "medium" | "low",
    "evidence": string
  }],
  "pageReferences": [{
    "id": string,
    "page": integer,
    "text": string,
    "location": string
  }],
  "warnings": string[]
}

Rules:
- Transcribe readable typed text into sourceText. Preserve numbers, units, ranges, identifiers, and dates.
- Create a finding only for a stated inspection result, limit comparison, defect, damage, degradation, failed check, or explicit recommendation.
- Every finding must cite one or more pageReferenceIds. Every cited ID must exist in pageReferences.
- Use one-based page numbers. Page-reference text must be a short verbatim excerpt from that page; location identifies the table, section, or label when clear.
- Use high confidence for clear text, medium for partly unclear text, and low for materially uncertain text. Preserve uncertainty in value or evidence; never silently resolve it.
- Include warnings for unreadable or ambiguous content and for any limitation of the scan.
- Do not infer unstated facts, causes, severity, compliance, approval status, dates, measurements, recommendations, or missing text. Do not calculate or correct values.
- This task supports clean typed scans only. Do not interpret handwriting, signatures, stamps, diagrams, or blurry/partial text as facts; report them as warnings.
- Use stable IDs such as finding-1 and page-ref-1. Do not add fields, omit required fields, use null, or return prose outside the JSON object.`;

export const VISION_USER_PROMPT = `Extract the inspection report in the attached clean typed scan.

Return the complete structured result described by the system prompt. Include
all readable report text, all evidence-backed findings, and page references.
Do not summarize away measurements or limits. If the scan does not support a
fact, omit it and explain the limitation in warnings.`;

export const DRAFT_SYSTEM_PROMPT = `You draft an approval note from verified inspection findings and retrieved
source excerpts. Return only one valid JSON object matching this shape:
{
  "title": string,
  "body": string,
  "sections": [
    { "id": "equipment-header", "heading": string, "body": string },
    { "id": "findings-summary", "heading": string, "body": string },
    { "id": "recommendation", "heading": string, "body": string },
    { "id": "grounding-references", "heading": string, "body": string }
  ],
  "citations": [{
    "documentId": string,
    "sectionId": string,
    "label": string,
    "inlineText": string,
    "supportingExcerpt": string
  }],
  "missingInformation": [{ "field": string, "note": string }]
}

Rules:
- Return exactly the four sections, in the listed order, with unique IDs.
- Use only the supplied OCR findings, page evidence, retrieved chunks, and template requirements.
- Include every material finding in findings-summary. Do not alter measurements, units, ranges, equipment IDs, or report references.
- State missing fields explicitly in missingInformation and in the relevant section when needed. Never guess or silently omit them.
- Cite only retrieved chunks. Each citation must use the chunk's exact documentId and sectionId. Use inlineText like [SOP-114 §3.2].
- Do not create a citation from a document or section absent from retrievedChunks. Do not cite OCR pages as SOP citations.
- Recommendations must be supported by the findings or retrieved SOP text. For the fixed Flow A report, state conditional clearance pending retubing of the affected tubes only when the supplied sources support it.
- Keep the body and section bodies ready for DOCX rendering. Do not include Markdown fences, JSON commentary, or extra fields.`;

const DRAFT_USER_TEMPLATE = `Draft the approval note for the supplied inspection report.

OCR findings and page evidence:
<FINDINGS_JSON>

Retrieved knowledge chunks:
<RETRIEVED_CHUNKS_JSON>

Template requirements:
<TEMPLATE_REQUIREMENTS_JSON>

Produce the exact structured result required by the system prompt. Ground every
claim in the supplied inputs and mark unavailable information as missing.`;

export function buildVisionRepairPrompt(firstFailure: string): string {
  return `${VISION_SYSTEM_PROMPT}

Your previous response was rejected by validation: ${firstFailure}
Fix only the flagged problem and return the complete JSON object again. If the scan is readable, sourceText must contain the full transcription, never an empty string. If the scan is not a readable inspection report, transcribe what is visible into sourceText and explain the limitation in warnings — do not invent inspection findings.`;
}

export function buildDraftRepairPrompt(firstFailure: string): string {
  return `${DRAFT_SYSTEM_PROMPT}

Your previous response was rejected by validation: ${firstFailure}
Fix only the flagged problem. Return exactly one valid JSON object with the required shape, no HTML, no Markdown, no commentary outside the JSON. Ensure four sections in order (equipment-header, findings-summary, recommendation, grounding-references), valid citations that exactly match retrieved chunks, and include [SOP-114 §3.2] in body/sections when the retrieved chunks contain SOP-114.`;
}

export function buildDraftUserPrompt(
  findings: Finding[],
  pageReferences: PageReference[],
  retrievedChunks: RetrievedKnowledgeChunk[],
  templateRequirements: string[],
): string {
  return DRAFT_USER_TEMPLATE.replace(
    "<FINDINGS_JSON>",
    JSON.stringify({ findings, pageReferences }),
  )
    .replace("<RETRIEVED_CHUNKS_JSON>", JSON.stringify(retrievedChunks))
    .replace("<TEMPLATE_REQUIREMENTS_JSON>", JSON.stringify(templateRequirements));
}

export const CODE_SYSTEM_PROMPT = `You write one safe, deterministic Python script for the supplied fixed CSV
task. Return only one valid JSON object matching this exact shape:
{
  "filename": "task.py",
  "source": string,
  "expectedResult": string,
  "inputFiles": string[],
  "outputFiles": string[],
  "allowedImports": string[]
}

The fixed input file is:
- reactor-temperature-log.csv

The CSV contains 240 reactor temperature readings. The task is to identify
readings outside the supplied acceptable range, classify each out-of-range
reading as high or low, and produce the required summary and output CSV.
Use the exact column names, units, limits, and row values supplied with the
fixed CSV task. Do not infer, correct, interpolate, or invent readings or
limits.

The Python script must:
- read reactor-temperature-log.csv;
- calculate which readings are outside the stated acceptable range;
- count all out-of-range readings and separate high from low readings;
- write out-of-range-rows.csv containing the out-of-range rows and the
  required classification;
- produce the summary represented by:
  OUT_OF_RANGE 7/240 (high=5, low=2)
  when run against the fixed fixture;
- use deterministic output and return exit code 0 on success.

Required result metadata:
- filename must be exactly task.py;
- inputFiles must be exactly ["reactor-temperature-log.csv"];
- outputFiles must be exactly ["out-of-range-rows.csv"];
- allowedImports must contain only "csv" and "datetime".

Code restrictions:
- source must contain only Python source; do not include Markdown fences,
  explanations, shell commands, or command-line arguments;
- import only csv or datetime; do not use any other import;
- do not use network access, subprocesses, shell execution, dynamic code
  evaluation, or environment-variable access;
- access only the supplied input file and the required output file by their
  fixed filenames; do not read or write any other path;
- do not delete, rename, or modify the input CSV;
- do not embed a replacement copy of the CSV or hard-code the expected counts
  instead of calculating them;
- do not create additional files;
- do not claim successful execution or output contents beyond the expected
  result description.

The backend and sandbox validate imports, paths, output files, timeout,
network isolation, exit code, and actual execution results. The model must
return only the JSON object above with no extra fields or commentary.`;
