# AI/backend contract

This folder defines the agreement between the AI work and Supreet's backend.
The agreement is in [`contracts.ts`](./contracts.ts).

The file contains TypeScript types only. It does not call OpenRouter, contact a
model, read a file, or contain an API key. Later, the backend should validate
incoming model JSON against these shapes before using or storing it.

## The basic flow

```text
User file and request
        ↓
ModelRequest
        ↓
model gateway
        ↓
ModelResponse
        ↓
validated result used by the next workflow step
```

There are three task types:

| Task type | Model | Main job |
| --- | --- | --- |
| `vision` | `vision-qwen25vl` | Read the clean typed inspection scan |
| `draft` | `draft-qwen3` | Write the approval note using retrieved SOP text |
| `code` | `code-qwen25coder` | Write the Python script for the CSV task |

The development provider mapping is kept in
[`model-registry.ts`](./model-registry.ts). The registry uses the following
OpenRouter models: Qwen2.5-VL 3B for vision, Qwen3 4B for drafting, and
Qwen2.5-Coder 7B for code generation. Embeddings are a separate local service,
`BAAI/bge-small-en-v1.5`, with 384-dimensional cosine vectors for Chroma.

## Important rules

- A file is represented by an `AttachmentReference`, not by an unrestricted
  computer path. The backend owns the run-relative path.
- A vision result keeps both the extracted text and the page evidence. A
  finding points to its evidence through `pageReferenceIds`.
- A draft contains a title, full body, fixed sections, citations, and a list of
  information that was missing. Missing information must be stated, not
  guessed.
- A citation has a stable document and section ID. The backend must check that
  every citation exists in `retrievedChunks` before creating a DOCX.
- Generated code is always Python. The model returns source and an expected
  result, but never shell commands or shell arguments.
- `AIError` describes a workflow/model problem. `ValidationFailure` describes
  a response that does not have the required shape. Both use `AIResult<T>` so a
  caller must handle failure explicitly.

## Example: vision result

```ts
const result: VisionResult = {
  sourceText: "Heat Exchanger E-201 Tube Bundle Inspection Report...",
  findings: [
    {
      findingId: "finding-1",
      title: "Tube wall thickness below minimum",
      value: "Rows 12–15 measured 3.8–4.2 mm; minimum allowable is 4.6 mm",
      pageReferenceIds: ["page-ref-1"],
      confidence: "high",
      evidence: "The report gives the measurements and the minimum allowable value.",
    },
  ],
  pageReferences: [
    {
      id: "page-ref-1",
      page: 1,
      text: "Rows 12–15: 3.8–4.2 mm; minimum allowable: 4.6 mm",
      location: "tube-wall-thickness table",
    },
  ],
};
```

## Example: approval-note result

```ts
const result: DraftResult = {
  title: "Approval Note — Heat Exchanger E-201",
  body: "...conditional clearance pending retubing of the affected tubes... [SOP-114 §3.2]",
  sections: [
    { id: "equipment-header", heading: "Equipment", body: "E-201" },
    { id: "findings-summary", heading: "Findings", body: "..." },
    { id: "recommendation", heading: "Recommendation", body: "..." },
    {
      id: "grounding-references",
      heading: "Grounding references",
      body: "SOP-114 §3.2",
    },
  ],
  citations: [
    {
      documentId: "SOP-114",
      sectionId: "3.2",
      label: "SOP-114 §3.2",
      inlineText: "[SOP-114 §3.2]",
    },
  ],
  missingInformation: [
    { field: "inspectionDate", note: "Not present in the report." },
  ],
};
```

## Example: generated Python result

```ts
const result: CodeDraftResult = {
  filename: "task.py",
  source: "...validated Python source...",
  expectedResult: "OUT_OF_RANGE 7/240 (high=5, low=2)",
  inputFiles: ["reactor-temperature-log.csv"],
  outputFiles: ["out-of-range-rows.csv"],
  allowedImports: ["csv", "datetime"],
};
```

The sandbox decides the actual command, input path, output path, timeout, and
network restrictions. The model only supplies the Python source and its
expected result.

## What comes next

The next layer should add runtime validators. TypeScript types help developers
while writing code, but they disappear when the program runs. A validator must
check the actual JSON returned by a model, including required fields, page
numbers, citation membership, fixed note sections, and safe Python output.
