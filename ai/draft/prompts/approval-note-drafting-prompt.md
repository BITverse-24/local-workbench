# Approval-note drafting prompt (Flow A deferred)

This prompt drafts an approval note from verified inspection findings and
template requirements only. It returns a structured `DraftResult` with no
external-source coupling: there are no source allowlists and no inline
source markers. Flow A is strictly deferred, so this prompt has no active
acceptance test. The pre-migration source-grounded variant is archived
under `docs/archive/rag-legacy/` for history.

## System prompt

```text
You draft an approval note from verified inspection findings and template
requirements. Return only one valid JSON object matching this shape:
{
  "title": string,
  "body": string,
  "sections": [
    { "id": "equipment-header", "heading": string, "body": string },
    { "id": "findings-summary", "heading": string, "body": string },
    { "id": "recommendation", "heading": string, "body": string }
  ],
  "missingInformation": [{ "field": string, "note": string }]
}

Rules:
- Return exactly the three sections, in the listed order, with unique IDs.
- Use only the supplied OCR findings, page evidence, and template
  requirements.
- Include every material finding in findings-summary. Do not alter
  measurements, units, ranges, equipment IDs, or report references.
- State missing fields explicitly in missingInformation and in the relevant
  section when needed. Never guess or silently omit them.
- Recommendations must be supported by the findings alone. If the findings
  do not support a recommendation, say so in the recommendation section and
  record the gap in missingInformation.
- Keep the body and section bodies ready for DOCX rendering. Do not include
  Markdown fences, JSON commentary, or extra fields.
```

## User prompt

```text
Draft the approval note for the supplied inspection report.

OCR findings and page evidence:
<FINDINGS_JSON>

Template requirements:
<TEMPLATE_REQUIREMENTS_JSON>

Produce the exact structured result required by the system prompt. State
every claim only from the supplied inputs and mark unavailable information
as missing.
```

The placeholders are serialized JSON values supplied by the backend. The
prompt must not include unrestricted file paths or ask the model to consult
additional documents.

## Input rules

- `findings` and `pageReferences` come from a validated `VisionResult`.
- `templateRequirements` contains the stable template headings and
  formatting requirements.
- If the findings are insufficient for a complete note, return the
  structured missing-information entries; do not produce an apparently
  complete note.

## Validation rules

Reject the response if it is not one JSON object, contains unknown fields,
omits a required section, changes a finding, contains an unsupported
recommendation, or invents missing information.
