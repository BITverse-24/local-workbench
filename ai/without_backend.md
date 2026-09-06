## Work you can do independently now

### 1. Define the AI/backend contract

Create the shapes that Supreet’s backend will eventually call.

Define TypeScript types for:

- `TaskType`: `vision | draft | code`
- Model registry entries
- Model requests and responses
- OCR findings
- Page references
- Retrieved knowledge chunks
- Citations
- Approval-note drafts
- Generated Python responses
- AI errors and validation failures

For example, define what the AI layer expects:

```ts
type VisionResult = {
  sourceText: string;
  findings: Finding[];
  pageReferences: PageReference[];
};
```

And what it returns to the backend:

```ts
type DraftResult = {
  title: string;
  body: string;
  citations: Citation[];
};
```

This allows Supreet to integrate your code later without guessing the formats.

### 2. Prepare the development model registry

You can decide and document:

- Which OpenRouter model represents `vision`
- Which model represents `draft`
- Which model represents `code`
- Model IDs
- Request timeouts
- Required capabilities
- Expected differences between OpenRouter models and final local models

You can prepare the registry structure, but the actual gateway/API integration depends on Supreet’s backend.

Do not place the API key in code or commit it.

### 3. Create the OCR/vision prompt

For the fixed typed inspection report, define:

- System prompt
- User prompt
- Required output schema
- Extraction rules
- Page-reference format
- What counts as a finding
- How uncertainty should be represented
- What the model must not infer
- Explicit limitation to clean typed scans

You can also prepare an expected result such as:

```json
{
  "findings": [
    {
      "title": "Pressure reading above limit",
      "value": "..."
    }
  ],
  "pageReferences": [
    { "page": 2, "text": "..." }
  ]
}
```

### 4. Create the approval-note drafting prompt

Define the prompt that receives:

- OCR findings
- Retrieved SOP sections
- Approval-note template requirements
- Citation rules
- Missing-information rules

The prompt should require:

- Fixed approval-note sections
- Citations such as `[SOP-114 §3.2]`
- No unsupported facts
- Clear marking of missing information
- Output suitable for DOCX generation
- A structured response rather than uncontrolled prose

You can prepare sample inputs and expected outputs without connecting to the backend.

### 5. Create the coding prompt

Prepare the coding task prompt for the fixed CSV.

Define:

- What the CSV contains
- Which readings are out of range
- What the generated Python must calculate
- Expected output format
- Required output files
- Restrictions on imports and filesystem access
- Requirement to return only validated Python plus an expected-result description

For example, the expected model result might include:

```ts
type CodeDraftResult = {
  source: string;
  expectedResult: string;
};
```

### 6. Prepare the fixed demo fixtures

Prepare the exact files used by the demos:

- Clean typed inspection-report PDF
- Matching SOP
- Approval-note template
- CSV containing known out-of-range readings
- Expected OCR findings
- Expected SOP citation
- Expected approval-note sections
- Expected Python stdout
- Expected exit code
- Expected generated data output

These should be fixed and pre-tested rather than improvised during the final demo.

### 7. Prepare the local RAG corpus metadata

You can prepare the knowledge-base content before the backend exists:

- Collect the 10–30 documents
- Give each document a stable name
- Assign stable section IDs
- Identify relevant excerpts
- Define metadata fields
- Define the expected search query
- Define the expected result, such as `SOP-114 §3.2`
- Prepare a no-match test case

Actual Chroma indexing and querying will need the embedding service and backend integration, but the corpus and metadata can be prepared now.

### 8. Define AI validation rules

Prepare pure validation logic for:

- OCR response structure
- Required findings
- Page references
- Draft-note sections
- Citation format
- Citations existing in retrieved sources
- Code response containing only allowed fields
- Empty or malformed model responses
- Unsupported claims
- No-source retrieval behavior

This can be implemented as standalone TypeScript schemas and tests, without Electron.

### 9. Create offline AI test fixtures

Create mock model responses for:

- Successful OCR
- Invalid OCR output
- Successful drafting
- Draft with an unsupported citation
- Draft with missing sections
- Successful code generation
- Malformed code response
- No matching knowledge source

These let Supreet test the orchestrator before live model calls are connected.

### 10. Define prompt regression tests

For each prompt, document:

- Input fixture
- Required output fields
- Expected values
- Allowed variation
- Failure conditions

Examples:

- OCR must find the known inspection issue.
- Draft must cite `SOP-114 §3.2`.
- Draft must not invent an inspection date.
- Code must flag the known out-of-range CSV rows.
- Code must return the expected summary.

### 11. Plan the model transition

Document:

- OpenRouter development model → final local model
- Prompt differences
- Expected context-window differences
- Expected output-format differences
- Any model-specific vision or tool limitations
- Revalidation steps after switching

This directly supports task 11a later.

### 12. Prepare the machine and service plan

For task 1b, you can document:

- Machine roles
- LAN IPs
- Service ports
- Startup commands
- Model aliases
- Allowed peers
- Embedding service location
- Network-monitor allowlist

This does not require the application backend.

## Work that must wait for Supreet’s backend

These cannot be genuinely completed in the final architecture yet:

- Calling OpenRouter through the application
- Routing requests through IPC
- Integrating the AI module with the orchestrator
- Live OCR execution from the UI
- Live RAG calls from a run
- Live drafting inside Flow A
- Live coding inside Flow B
- Streaming model events to the renderer
- Connecting model errors to run history
- Running the complete end-to-end flows

You can build a temporary standalone API test script, but it should be treated only as a disposable development harness. It must not become the production request path, because the intended path is:

```text
Renderer → IPC → Electron main/backend → AI model gateway → OpenRouter
```

The best immediate deliverable is therefore an AI integration packet containing:

- TypeScript schemas
- Model registry entries without secrets
- Three prompt sets
- Fixed fixtures
- Expected outputs
- RAG corpus metadata
- Mock model responses
- Validation and regression tests
- Model transition notes

That gives Supreet everything needed to connect your AI work once the minimal backend and IPC contract exist.