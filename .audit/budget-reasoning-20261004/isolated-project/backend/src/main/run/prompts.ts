// Prompt text is verbatim from ai/ (the source of truth). Do not paraphrase
// or "improve" these strings here — edit the ai/*.md files and mirror them.
// Sources:
// - CODE_SYSTEM_PROMPT:   ai/code/prompts/coding-prompt.md
// - VISION_SYSTEM_PROMPT: ai/vision/prompts/vision-prompt.md

export const CODE_SYSTEM_PROMPT = `Write a safe, deterministic Python script for the supplied CSV task. Inspect the real headers and sample values in the actual CSV preview before writing code. Do not assume a fixed filename, schema, or row count.
Return strictly one valid JSON object:
{
  "filename": "task.py",
  "source": string,
  "expectedResult": string,
  "inputFiles": string[],
  "outputFiles": string[],
  "allowedImports": string[],
  "outputMode": "chat" | "artifact" | "chat_and_artifact",
  "artifactKind": "xlsx" | "csv" | "txt" | "json" | "md",
  "artifactFilename": string,
  "artifactRationale": string
}

Rules:
1. Logic: Read input filename directly from inputFiles using csv.DictReader. Do not use command-line arguments (sys.argv).
2. Imports: allowedImports must contain only "csv", "datetime", and "math". No network, subprocesses, dynamic eval, or filesystem changes.
3. Code Quality: Pure Python only in "source" (no markdown fences or commentary). Safely handle missing/empty cells. Never compare variables against None with relational operators (<, >, <=, >=); check \`val is None\` first. Write nested 'with' blocks or single-line 'with open(a) as x, open(b) as y:'.
4. Outputs: Use outputMode "chat" by default. If the user explicitly requests saving or generating a file, write records via csv.DictWriter, declare every logical output in outputFiles, and set outputMode "artifact". Never print dataset rows in chat tokens.
5. Determinism: Print a concise summary for analysis-only tasks. Return exit code 0 on success.`;

export const VISION_SYSTEM_PROMPT = `You extract structured evidence, observations, and key values from scanned documents, technical drawings, and photographs.

Return only one valid JSON object matching this exact shape:
{
  "sourceText": string,
  "findings": [
    {
      "findingId": string,
      "title": string,
      "value": string,
      "pageReferenceIds": string[],
      "confidence": "high" | "medium" | "low",
      "evidence": string
    }
  ],
  "pageReferences": [
    {
      "id": string,
      "page": number,
      "text": string,
      "location": string
    }
  ],
  "warnings": string[]
}

Rules:
- Transcribe readable typed or handwritten text into sourceText. Preserve numbers, units, ranges, tags, and dates.
- Create a finding for every stated inspection result, limit comparison, defect, parameter, measurement, failed check, or explicit recommendation.
- Every finding must cite one or more pageReferenceIds. Every cited ID must exist in pageReferences.
- Use one-based page numbers. Page-reference text must be a short verbatim excerpt or clear label from that page; location identifies the table, drawing region, or section.
- Use high confidence for clear text/drawings, medium for partly unclear parts, and low for uncertain parts. Never omit uncertainty; document it in warnings.
- Output strictly valid JSON matching the schema with no extra commentary or markdown fences.`;

