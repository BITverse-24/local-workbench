# Approval-note drafting prompt

This prompt is for Flow A after OCR and local knowledge retrieval. It returns
only a structured `DraftResult` suitable for DOCX generation.

## System prompt

```text
You draft an approval note from verified inspection findings and retrieved
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
- Keep the body and section bodies ready for DOCX rendering. Do not include Markdown fences, JSON commentary, or extra fields.
```

## User prompt

```text
Draft the approval note for the supplied inspection report.

OCR findings and page evidence:
<FINDINGS_JSON>

Retrieved knowledge chunks:
<RETRIEVED_CHUNKS_JSON>

Template requirements:
<TEMPLATE_REQUIREMENTS_JSON>

Produce the exact structured result required by the system prompt. Ground every
claim in the supplied inputs and mark unavailable information as missing.
```

The placeholders are serialized JSON values supplied by the backend. The
prompt must not include unrestricted file paths or ask the model to retrieve
additional documents.

## Input rules

- `findings` and `pageReferences` come from a validated `VisionResult`.
- `retrievedChunks` is the complete citation allowlist for this draft.
- `templateRequirements` contains the stable template headings and formatting
  requirements returned by local knowledge search.
- If no suitable SOP or template chunk is retrieved, return a structured
  missing-information entry; do not produce an apparently grounded note.

## Fixed Flow A acceptance result

For the locked E-201 fixture, the result must include:

- An equipment header containing E-201 and the report reference when present in
  the OCR result.
- All three OCR findings in the findings summary.
- A recommendation of conditional clearance pending retubing of the affected
  tubes, supported by the retrieved approval criteria.
- A grounding-references section containing `[SOP-114 §3.2]`.
- A citation whose exact identity is `documentId: "SOP-114"` and
  `sectionId: "3.2"`.

Example shape:

```json
{
  "title": "Approval Note — Heat Exchanger E-201",
  "body": "<DOCX-ready text containing the four sections>",
  "sections": [
    { "id": "equipment-header", "heading": "Equipment", "body": "E-201; report reference: <from OCR>" },
    { "id": "findings-summary", "heading": "Findings", "body": "<all three findings with evidence>" },
    { "id": "recommendation", "heading": "Recommendation", "body": "Conditional clearance pending retubing of the affected tubes. [SOP-114 §3.2]" },
    { "id": "grounding-references", "heading": "Grounding references", "body": "[SOP-114 §3.2]" }
  ],
  "citations": [
    {
      "documentId": "SOP-114",
      "sectionId": "3.2",
      "label": "SOP-114 §3.2",
      "inlineText": "[SOP-114 §3.2]",
      "supportingExcerpt": "<exact retrieved excerpt>"
    }
  ],
  "missingInformation": [
    { "field": "inspectionDate", "note": "Not present in the supplied OCR findings." }
  ]
}
```

Placeholder text in this example must be replaced with supplied input values;
it must never be emitted as if it were a fact.

## Validation rules

Reject the response if it is not one JSON object, contains unknown fields,
omits a required section, changes a finding, cites a non-retrieved source,
contains an unsupported recommendation, or invents missing information. The
backend must perform citation-membership validation again before DOCX creation.
