# OCR/vision prompt

This prompt is for the fixed Flow A input: a clean, typed, two-page inspection
report. The model must return structured JSON matching `VisionResult`; it must
not return Markdown, commentary, or an alternative shape.

## System prompt

```text
You extract evidence from clean typed inspection-report scans.

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
- Use stable IDs such as finding-1 and page-ref-1. Do not add fields, omit required fields, use null, or return prose outside the JSON object.
```

## User prompt

```text
Extract the inspection report in the attached clean typed scan.

Return the complete structured result described by the system prompt. Include
all readable report text, all evidence-backed findings, and page references.
Do not summarize away measurements or limits. If the scan does not support a
fact, omit it and explain the limitation in warnings.
```

The attachment is supplied separately as the `VisionModelRequest.attachment`;
the user prompt does not contain a filesystem path.

## Required output constraints

- Output format: one JSON object only; no Markdown fences.
- Required fields: `sourceText`, `findings`, `pageReferences`, `warnings`.
- `findingId` and page-reference `id` values are unique within the response.
- `page` is a positive one-based integer.
- `pageReferenceIds` is non-empty for every finding.
- Findings may only use evidence present in `sourceText` and their referenced excerpts.
- Empty arrays are valid when no supported finding or warning exists.

## Fixed Flow A expected result

The fixture should produce these findings, with findings 1 and 2 on page 1 and
finding 3 on page 2. Wording may be normalized, but the measurements and
meaning must remain supported by the report.

```json
{
  "sourceText": "<complete readable report transcription>",
  "findings": [
    {
      "findingId": "finding-1",
      "title": "Tube wall thickness below minimum allowable",
      "value": "Rows 12–15 measured 3.8–4.2 mm; minimum allowable is 4.6 mm",
      "pageReferenceIds": ["page-ref-1"],
      "confidence": "high",
      "evidence": "The report states the measured range and minimum allowable value."
    },
    {
      "findingId": "finding-2",
      "title": "Localised pitting corrosion at shell inlet nozzle",
      "value": "Maximum depth 1.8 mm",
      "pageReferenceIds": ["page-ref-2"],
      "confidence": "high",
      "evidence": "The report identifies the location and maximum pitting depth."
    },
    {
      "findingId": "finding-3",
      "title": "Channel-head gasket degradation",
      "value": "Replacement recommended",
      "pageReferenceIds": ["page-ref-3"],
      "confidence": "high",
      "evidence": "The report states the gasket condition and recommendation."
    }
  ],
  "pageReferences": [
    { "id": "page-ref-1", "page": 1, "text": "<verbatim thickness excerpt>", "location": "tube-wall-thickness table" },
    { "id": "page-ref-2", "page": 1, "text": "<verbatim pitting excerpt>", "location": "corrosion findings" },
    { "id": "page-ref-3", "page": 2, "text": "<verbatim gasket excerpt>", "location": "channel-head findings" }
  ],
  "warnings": []
}
```

The placeholder excerpts above are intentional: the expected fixture result
must use the exact readable wording from the PDF rather than invented quotes.

## Validation and failure cases

Reject the model response if it is not a single JSON object, contains unknown
fields, omits required fields, uses a non-positive page number, references an
unknown page-reference ID, gives a finding no evidence, or states a fact that
is absent from the report evidence. A clean scan with no findings is valid; an
unclear scan is valid only when the uncertainty is represented in `warnings`
and/or the affected finding's confidence and evidence.
