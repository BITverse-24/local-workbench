# P2-A — Architecture audit and implementation specification

**Recommendation:** Add three bounded operations over the existing RunResultStore: `structure_result`, `transform_result`, and `compare_results`. Use a small record-table payload, an internal checked payload reader, and one optional adapter in the existing XLSX generator. No new store, inference stage, router, or execution engine is needed.

Audit baseline: commit `2e9f3f5432589cfe854f2b4378d68d09d4e7caf1`. Findings below come from current code and inspected test bodies. Production code was not changed. Tests and live inference were not run for this read-only audit; test references show existing coverage, not current pass results.

## A. Capability inventory

Status applies to the named operation and its present limits. **Accessible** means registered in the active V2 tool path, subject to progressive exposure. **Internal** means implemented but not directly available as that model-facing operation. **Partial** means important limits remain. **Missing** means no reusable implementation was found in the inspected execution and data paths.

| Capability | Status | Evidence and limits |
|---|---|---|
| Canonical objective, requested exports, workspace operations, protected paths, acceptance | Accessible/internal infrastructure | `normalizeRunContract`, `persistRunContract`, `evaluateRunContractCompletion` in [contract.ts](/Users/krishay/projects/agent/backend/src/main/run/contract.ts:23). Contract is persisted once; it does not itself grant permission. |
| Durable arbitrary text, JSON objects and arrays | Accessible | `RunResultStore.registerResult` in [result-store.ts](/Users/krishay/projects/agent/backend/src/main/run/result-store.ts:61). Types already include text/document/table/structured/execution; origin, complete/partial state, producer, optional schema, and source references are stored. Payloads are immutable files; SQLite stores manifests. |
| Result discovery and bounded slices | Accessible | `retrieveResultTool` in [result-retrieval.ts](/Users/krishay/projects/agent/backend/src/main/tools/result-retrieval.ts:13); `listResults`, `inspectResult`, `retrieveResultSlice` in [result-store.ts](/Users/krishay/projects/agent/backend/src/main/run/result-store.ts:141). Text offsets, line ranges, JSON pointers and array slices are supported. No filter/join operation. |
| Workspace listing, reads, search, writes, deletes and commands | Accessible | [workspace-tools.ts](/Users/krishay/projects/agent/backend/src/main/tools/workspace-tools.ts:129), underlying [harness/tools](/Users/krishay/projects/agent/backend/src/main/harness/tools/read-file.ts:10), and `resolveSafe` in [path-guard.ts](/Users/krishay/projects/agent/backend/src/main/harness/path-guard.ts:18). Workspace text reads normally reject files over 200 KiB. Run-file fallback reads have a different size path. Writes/commands remain subject to policy and mode. |
| Digital PDF text | Accessible, format-limited | `extractPdfText`, `readDocumentContent` in [document-reader.ts](/Users/krishay/projects/agent/backend/src/main/tools/document-reader.ts:183), and `extractDocumentTool` in [specialist-tools.ts](/Users/krishay/projects/agent/backend/src/main/tools/specialist-tools.ts:111). Full page text is stored. Text layout is flattened; there is no reliable PDF table-to-record parser. Digital “findings” currently wrap page text, rather than extract arbitrary semantic fields. |
| DOCX paragraphs and tables | Accessible, format-limited | `parseDocxXml`, `extractDocxText` in [document-reader.ts](/Users/krishay/projects/agent/backend/src/main/tools/document-reader.ts:84). Tables become Markdown text. No typed table objects, real page mapping, merged-cell model, or complete header/footer extraction. `.doc` is accepted by extension, but this reader opens an OpenXML ZIP; genuine binary DOC support is absent. DOCX can use `read_file`; `extract_document` registration currently depends on visual attachments. |
| SVG text; scanned PDFs and images | Accessible, partial | Native SVG branch and model fallback in [specialist-tools.ts](/Users/krishay/projects/agent/backend/src/main/tools/specialist-tools.ts:148), PDF/image preparation in [images.ts](/Users/krishay/projects/agent/backend/src/main/run/images.ts:128). Scans/images need inference; model-derived findings are distinguishable from native extraction. No generic schema-directed record extraction. |
| CSV/TSV input as reusable records | Partial | `readFileTool` stores full text in [workspace-tools.ts](/Users/krishay/projects/agent/backend/src/main/tools/workspace-tools.ts:300). Python can parse CSV. `parseCsvLine` in [artifacts.ts](/Users/krishay/projects/agent/backend/src/main/tools/artifacts.ts:266) is internal and processes one physical line; it is unsuitable for quoted multiline CSV. There is no native model-facing table import. |
| JSON parsing | Internal/partial | Strict JSON is used for stored payloads and artifact checks. `parseStructuredData` in [structured-data.ts](/Users/krishay/projects/agent/backend/src/main/gateway/structured-data.ts:3) supports complete JSON/JSON5 model arguments. `read_file` stores JSON files as text. No import that validates a reusable record array. |
| XLSX read and write | Internal read; accessible write | ExcelJS opens workbooks in `verifyArtifactFile` in [artifacts.ts](/Users/krishay/projects/agent/backend/src/main/tools/artifacts.ts:147). `generateXlsx`, `generateXlsxFromContent` create workbooks. There is no worksheet/range reader for AgentLoop. `read_file` does not parse XLSX; Python's advertised standard library lacks an XLSX library. `.xls` labels do not establish binary XLS support. |
| Calculation, normalization and cross-source comparison | Accessible through generated scripts; reusable native primitive missing | `executePythonTool` in [specialist-tools.ts](/Users/krishay/projects/agent/backend/src/main/tools/specialist-tools.ts:455) accepts code and filenames. The persisted result is an execution object with stdout/stderr/files, not a validated record table. No result-ID inputs, record projection, append, or keyed comparison tool. |
| Engineering measurement and compliance helpers | Internal, domain-limited | `extractMeasurements`, `evaluateSop114Rules` in [sop114-engine.ts](/Users/krishay/projects/agent/backend/src/main/grounding/sop114-engine.ts:60); `extractDrawingAttributes`, `evaluateDrawingComplianceWithModel` in [spec-compliance.ts](/Users/krishay/projects/agent/backend/src/main/grounding/spec-compliance.ts:64). These are engineering-specific rules/model evaluation, not general record operations. Do not reuse their thresholds as generic reconciliation logic. |
| Knowledge retrieval and source citations | Accessible, partial persistence | `retrieveKnowledgeTool` in [specialist-tools.ts](/Users/krishay/projects/agent/backend/src/main/tools/specialist-tools.ts:404) returns chunk/document/section/page labels. Small results have no explicit intermediate payload; dispatcher fallback stores large outputs. Indexed `read_file` excerpts do explicitly persist chunks and source locators in [workspace-tools.ts](/Users/krishay/projects/agent/backend/src/main/tools/workspace-tools.ts:280). RAG ingestion in [ingestion.ts](/Users/krishay/projects/agent/ai/rag/ingestion.ts:135) chunks PDF/DOCX/plain text, not reusable tables. |
| Evidence and provenance | Accessible, partial granularity | `SourceReference` in [contracts.ts](/Users/krishay/projects/agent/backend/src/shared/contracts.ts:167) supports filename, upstream result ID, page, section, sheet, range, text span and locator. Store checks same-run parent IDs. Current producers mainly fill filenames; PDF extraction adds pages. No general record/cell lineage, source-byte digest, or attachment identity in that contract. |
| Durable execution, restart and verification | Internal infrastructure | `recordExecutionToolStarted/Outcome`, `prepareExecutionResume`, `executionLedgerSummary` in [execution-ledger.ts](/Users/krishay/projects/agent/backend/src/main/run/execution-ledger.ts:132); `RunManager.resume` in [manager.ts](/Users/krishay/projects/agent/backend/src/main/run/manager.ts:354); `verifyRunEvidence` in [verification.ts](/Users/krishay/projects/agent/backend/src/main/run/verification.ts:100). Result IDs/artifact refs survive restart. Unknown mutation outcomes block resume. Integrity and structure do not establish semantic correctness. |
| Deliverable generation | Accessible, with representation limits | `generateDeliverableTool` in [specialist-tools.ts](/Users/krishay/projects/agent/backend/src/main/tools/specialist-tools.ts:655) advertises DOCX/XLSX/Markdown/exact text files. `createDocxBuffer` and `generateXlsxFromContent` compile model text. No advertised PDF renderer; exact-file output cannot create a valid binary PDF. No explicit table-result input. |

### Existing facilities worth reusing

- ExcelJS already supplies XLSX parsing/writing and CSV parsing through its `workbook.csv.read` API. The installed implementation uses `fast-csv`; it defaults to number/date inference. Supply an identity `map` for CSV values and explicit parser options. This avoids new dependencies and preserves IDs such as `0017`. The installed API was inspected in `node_modules/exceljs/lib/csv/csv.js`, lines 43–96.
- Zod already validates execution and result contracts. Node supplies checked file access, hashing, maps and JSON parsing.
- PDF/DOCX/SVG extraction, Markdown-to-DOCX rendering, and XLSX staging/validation are reusable. They should retain their current responsibilities.
- `parseStructuredData` serves tolerant model argument decoding; canonical JSON source import should use strict JSON. Do not silently repair source data with the gateway's output-normalization helpers.
- `ai/tools/contracts.ts` defines attachment/input metadata only. Its `columns`/`rowCount` fields are not an implemented processing facility.

## B. Current information path

### Representative source-to-result-to-consumer trace

Consider a digital PDF passed to `extract_document`:

1. `RunManager.execute` persists RunContract, creates a run-bound ResultStore and passes it through `ToolExecutionContext`: [manager.ts](/Users/krishay/projects/agent/backend/src/main/run/manager.ts:1132), [tool context](/Users/krishay/projects/agent/backend/src/main/run/manager.ts:1235). V2 is the default gateway path unless explicitly disabled; legacy paths remain in the file.
2. `extractDocumentTool.execute` reads page text with pdfjs and returns both a display JSON string and an `intermediate` object containing full text, full pages and page source references: [specialist-tools.ts](/Users/krishay/projects/agent/backend/src/main/tools/specialist-tools.ts:111).
3. `ToolDispatcher.dispatchConcurrent` registers that full payload **before** publishing success. `registerResult` writes/fsyncs an exclusive immutable file and inserts its manifest. Failure becomes `persistence_failure`: [tool-dispatcher.ts](/Users/krishay/projects/agent/backend/src/main/agent/tool-dispatcher.ts:504), [result-store.ts](/Users/krishay/projects/agent/backend/src/main/run/result-store.ts:61).
4. The dispatcher returns a bounded observation with a durable ID. Successful `data` becomes `{resultId,type,status}`. Page labels also enter `context.sourceReferences`. The ledger receives the result ID at the same boundary: [tool-dispatcher.ts](/Users/krishay/projects/agent/backend/src/main/agent/tool-dispatcher.ts:491), [outcome recording](/Users/krishay/projects/agent/backend/src/main/agent/tool-dispatcher.ts:562).
5. AgentLoop retains that ID on the tool message. Later compaction preserves an ID/retrieval prefix. `retrieve_result` can read `/pages/2/text` or a bounded substring, after a checksum check: [agent-loop.ts](/Users/krishay/projects/agent/backend/src/main/agent/agent-loop.ts:1718), [context-manager.ts](/Users/krishay/projects/agent/backend/src/main/agent/context-manager.ts:150).
6. To build a report today, the model supplies complete Markdown in `generate_deliverable.content`. The generator renders that text and appends filename/page citations. It cannot take the PDF result ID and mechanically select its records. The model must interpret and copy the useful information.

The inspected integration test already traces native SVG extraction through the same persistence/retrieval path, removes original sources and messages, reopens SQLite, and retrieves stored facts: [result-memory-integration.test.ts](/Users/krishay/projects/agent/backend/tests/result-memory-integration.test.ts:29). This is concrete coverage for durability, not for record transformation.

### Bounds and direct consumption

The store accepts text or JSON up to **64 MiB**, rejects unsupported JSON values, and limits schema-plus-source metadata to **256 KiB**. Summaries are capped at **512 characters**. Retrieval returns at most **3,000 characters** per slice; JSON slices are display strings and may require further pagination. It reads/checks the entire stored payload internally even for a small slice. There is no internal method that returns a complete, validated payload directly to another tool. Calling `JSON.parse` on a display slice would be unsafe because that slice may be incomplete.

Observations are separately bounded: recent `read_file` 8,000 characters, document/retrieval/default tools 4,000, command 3,000; older turns have tighter bounds. The 8,000-character global ceiling is a character ceiling, not a token guarantee. Full persisted payloads remain available. These limits are in [context-manager.ts](/Users/krishay/projects/agent/backend/src/main/agent/context-manager.ts:47).

Initial attachment injection is a separate path: RunManager may insert entire small text files or extracted document text into the system prompt before any tool call, outside these tool-observation caps: [manager.ts](/Users/krishay/projects/agent/backend/src/main/run/manager.ts:1292). For P2-A-supported data attachments, prefer filenames and bounded schema/sample metadata once native import is available. Do not change all document context handling as part of this milestone.

`retrieve_result` is the only general explicit result-ID consumer. Artifact generation has one internal exception: placeholder content may select an execution result from the first default result page and read its default slice, under a fixed “Financial Reconciliation Findings” heading: [specialist-tools.ts](/Users/krishay/projects/agent/backend/src/main/tools/specialist-tools.ts:790). This is implicit, bounded, domain-specific fallback behavior; it is not a safe reusable result adapter. New result-based exports must use an explicit ID and full checked payload, bypassing that fallback.

### Present exposure rules

`composeTools` registers available tool implementations using workspace/attachment/KB state; `constrainToolsToIntent` then removes tools outside contract scope: [tool-compositor.ts](/Users/krishay/projects/agent/backend/src/main/router/tool-compositor.ts:114). Envelope initialization uses mode, file types, requested exports and some prompt cues: [envelope.ts](/Users/krishay/projects/agent/backend/src/main/run/envelope.ts:51). Tool definitions are filtered each turn by active groups. Result retrieval becomes active when a stored result exists. `request_capability` grants only envelope-permitted groups: [capabilities.ts](/Users/krishay/projects/agent/backend/src/main/tools/capabilities.ts:80).

The compositor exposes `filterToolsForTurn`, but current AgentLoop also contains its own filtering block: [agent-loop.ts](/Users/krishay/projects/agent/backend/src/main/agent/agent-loop.ts:861). P2-A must cover the actual loop and the helper in tests. Adding a tool only to the catalogue or capability metadata is insufficient. No new classification or capability router is needed.

Mechanical work now delegated to model output includes CSV parsing scripts, key matching, value normalization, difference calculation, JSON/Markdown serialization, and retyping result rows for XLSX output. Document interpretation, selection of meaningful comparison fields, and explanation of differences remain valid semantic work.

## C. Prioritized gaps

| Priority and addition | Generality/context benefit | Determinism/reuse | Complexity/safety/local-model benefit |
|---|---|---|---|
| **1. Native table import and direct result consumption** | Reuse CSV/JSON/XLSX data across unrelated workflows without repeated full reads or serialization. | Existing ResultStore, Zod, ExcelJS; checked full-payload reader. | Moderate parser adapter work. No arbitrary code. Preserves strings and rejects ambiguous table selection. Gives a small model stable IDs and column names. |
| **2. Bounded projection, normalization and append** | Reuse cleaned subsets; align differently named fields; combine compatible batches. Keeps whole tables out of context. | Fixed typed operations over stored records. Preserve parent refs and exact input data. | Low to moderate. Explicit rules avoid silent type/unit guesses. Removes script generation for common mechanical work. |
| **3. Keyed comparison** | Missing/changed record reports across inventories, schedules, registers, lab results and other tables. Return counts plus a small preview. | Maps over explicit keys and field pairs; reuse normalized tables and lineage. | Moderate correctness work around duplicate/null keys and numeric equality. No fuzzy matching. Reduces repeated reasoning about every row. |

Do not add general document-schema extraction first. Native document extraction exists; reliable semantic field extraction is a separate optional adapter. Do not add SQL, dataframe expressions, arbitrary pipelines, aggregation libraries or another provenance database.

## D. Minimum P2-A architecture

### Result representation and checked access

Retain `IntermediateResultRecord` and its immutable result IDs. Existing `type="table"` is only a label: the payload is `unknown[]`/an opaque object and `structuredSchema` is unchecked descriptive metadata. Add a versioned **payload** contract for flat records. No SQLite table or result-envelope version change is required.

```ts
type Cell = string | number | boolean | null;
type Column = { name: string; type: "string" | "number" | "boolean" | "null" };
type ResultRowRef = { resultId: string; row: number };

interface RecordTableV1 {
  kind: "record_table";
  version: 1;
  columns: Column[];
  rows: Array<{
    values: Record<string, Cell>;
    evidence: SourceReference[];
  }>;
  operation: { name: string; parameters: unknown }; // validated per operation
  warnings: Array<{ code: string; row?: number; column?: string }>;
}

interface CheckedPayloadReader {
  readPayload<T>(
    resultId: string,
    parse: (payload: unknown) => T,
    maxBytes: number,
  ): { record: IntermediateResultRecord; payload: T };
}
```

Implement the reader on RunResultStore. Factor its current contained-path/size/checksum read into one private helper used by slices and internal reads. Decode stored text as UTF-8, or parse canonical JSON once, according to the persisted encoding. Validate the requested payload contract and apply operation bounds. Never return this complete payload through a routine model observation or accept an arbitrary payload path.

Use `structuredSchema` for bounded discovery metadata: kind/version, columns, row count and warning count. Keep rows, row evidence and operation parameters in the payload. Result-level `sources` lists distinct parent result IDs. Do not duplicate every parent manifest or raw source file in each derived result.

Every row must have exactly the declared columns. Null is permitted in any column; an all-null column has type `null`. Reject mixed non-null scalar types within a column. Do not coerce them to fit a schema. Bound column names to 128 characters and reject duplicates. Use safe property access when handling arbitrary names such as `__proto__`; column names are data, not object prototypes.

For P2-A file imports, minimally extend `SourceReference` with optional `attachmentId` and `sha256`. The digest identifies the exact bytes read; an attachment ID is included only when resolved from authorized attachment metadata. Workspace sources use a contained relative path and digest. This fits existing `sources_json`; older records remain valid. Source digest and result-payload digest have different meanings. A digest cannot recover missing original bytes.

Record evidence uses existing page/sheet/range/text-span fields where available. For JSON/result records, use a documented JSON-pointer locator; for CSV use a logical record index, not an invented physical line number. XLSX rows use actual sheet/range coordinates. Derived rows reference their parent result and `/rows/<index>/values`. Compare entries reference both parent rows and compared columns. Validate all embedded result refs against the same run; current registration checks only manifest-level parent refs.

This supports record-level lineage and exact cell access within canonical tables. It does **not** establish OCR boxes, real DOCX page numbers, original PDF cells, or field-level semantic attribution that current readers do not supply. Native DOCX's synthetic page 1 must not be presented as verified pagination. `origin="execution"` on a transform describes its producer; source ancestry must still reveal any model-derived inputs.

Recommended initial limits: source bytes **10 MiB**, **10,000 rows**, **100 columns**, **1,000,000 cells**, **32,000 characters per cell**, and **16 MiB per output payload including evidence**. Apply all limits to imports and derived outputs; append does not increase them. Limit XLSX uncompressed archive bytes to **64 MiB** before workbook parsing. Validate or preflight the archive with existing ZIP facilities; a compressed-file limit alone is insufficient. These are initial scope limits, not measured throughput claims. Reject excess data explicitly; do not silently truncate it. Check cancellation between bounded batches.

### Primitive 1: `structure_result`

**Purpose:** Convert supported data sources into reusable records without generating parser code. **Reuses:** source access, ExcelJS, strict JSON, Zod, ResultStore and dispatcher registration.

```ts
type TableSource = { resultId: string } | { filename: string };
interface StructureResultInput {
  source: TableSource;
  format: "csv" | "json" | "xlsx";
  sheet?: string;
  range?: string;
  headerRow?: number;
  pointer?: string; // JSON array of flat records
  delimiter?: "," | "\t" | ";";
  allowPartial?: boolean; // defaults to false
}
```

Model-facing; file and result resolution are internal. CSV values stay strings, including empty strings and leading zeroes. JSON retains scalar types; reject nested cells unless a later explicit projection supports them. XLSX requires one selected sheet, or a workbook with exactly one sheet; use an explicit range or the occupied worksheet rectangle within limits. Preserve scalar cell values and blank cells as null. Reject date, rich-text, error and merged cells in the selected range in this initial adapter. Cached scalar formula results must be labelled as cached observations; unavailable/error formula results fail. Do not recalculate formulas, evaluate macros, follow links or guess merged headers. Empty data is valid when columns are known; missing/duplicate headers or an ambiguous range require clarification. Result-ID sources may contain UTF-8 CSV/JSON or JSON records selected by pointer; XLSX import requires an authorized file because the store does not persist binary payloads.

Return a `ToolExecutionResult.intermediate` with `type="table"`, the validated payload and sources. The dispatcher assigns its immutable ID. Native file parsing uses `origin="source_extracted"`; result-ID import retains the upstream origin, including `model_derived` or `execution`. Reject partial inputs by default. `allowPartial=true` permits processing the available records, but the output remains partial and visibly labelled. The flag does not make source evidence complete.

Reads require existing source authority and `resolveSafe`; resolve attachments by exact authorized identity/path. Do not copy `extract_document`'s permissive absolute-file fallback. Internal result persistence needs no workspace mutation approval. Bound source bytes, sheet/range size, row/column/cell counts and total evidence bytes before registration; never silently drop records.

Expose only for supported attached sources, permitted source access with a workspace, or a compatible stored source. Reuse `source_access`/`structured_computation` groups, with one defined mapping to `structured_computation`; initial supported data attachments may activate that group deterministically. A workspace-only request can use existing `request_capability`. No prompt-specific classifier.

Tests: CSV quoting, embedded newlines, BOM, delimiters, empty cells, zero-prefixed IDs; strict JSON pointers/types; XLSX sheet/range selection, blanks, dates/formulas/errors; invalid headers; limits; containment/symlinks; exact source digests; partial-origin handling; persistence failure.

### Primitive 2: `transform_result`

**Purpose:** Select fields/records, normalize explicit values, or append compatible batches. **Reuses:** checked table loader, same-run IDs, Zod and immutable result registration.

Use a small discriminated input union, not an expression language:

```ts
type TransformResultInput = { allowPartial?: boolean } & (
  | { action: "select"; resultId: string; columns: string[];
      rename?: Record<string, string>;
      filter?: { column: string; equals: Cell } }
  | { action: "normalize"; resultId: string;
      rules: Array<{ column: string; trim?: boolean;
        lowercase?: boolean; toNumber?: boolean }> }
  | { action: "append"; resultIds: string[] }
);
```

Model-facing, deterministic, returns another `RecordTableV1`. Each call does one operation. `select` preserves input order and uses strict scalar equality. Reject missing columns and rename collisions. `normalize` applies only supplied rules, preserves source evidence, and never guesses dates, locale, currency or units. Number conversion accepts finite unambiguous syntax and rejects unsafe integer precision; invalid conversion fails with row/column evidence. `append` requires equal canonical column names/types, preserves input order and does not deduplicate. Use separate explicit select/rename calls to align schemas.

Store `origin="execution"`, parent manifest refs, operation parameters and row lineage. Default partial rejection/explicit partial propagation applies. No original data overwrite, workspace side effect or approval gate. Apply row/byte bounds and cancellation checks.

Expose after at least one validated table is discoverable and `structured_computation` is permitted. Activate from successful table creation or explicit capability request. Pure Chat without sources/results exposes none of these operations. Do not accidentally prune this tool under the current file-inspection rule that removes Python.

Tests: projections/renames/filter equality; null versus empty; conversion failures and integer precision; retained order; duplicate row retention; append schema mismatch; same-run lineage; input immutability; ancestor model-derived evidence; cancellation; restart consumption.

### Primitive 3: `compare_results`

**Purpose:** Align records by explicit keys and identify changed or missing records. **Reuses:** checked tables, maps, result lineage and dispatcher.

```ts
interface CompareResultsInput {
  leftResultId: string;
  rightResultId: string;
  keys: Array<{ left: string; right: string }>;
  fields: Array<{ left: string; right: string;
    absoluteTolerance?: number }>;
  allowPartial?: boolean;
}
interface ComparisonV1 {
  kind: "record_comparison";
  version: 1;
  counts: { equal: number; changed: number; leftOnly: number;
    rightOnly: number; ambiguous: number };
  entries: Array<{
    key: Cell[];
    status: "changed" | "left_only" | "right_only" | "ambiguous";
    ambiguity?: "duplicate_key" | "missing_key";
    left: ResultRowRef[];
    right: ResultRowRef[];
    differences?: Array<{ leftColumn: string; rightColumn: string;
      leftValue: Cell; rightValue: Cell }>;
  }>;
  operation: CompareResultsInput;
}
```

Model-facing, deterministic. Return a typed `structured` result with parent IDs and full entries stored outside context. Keys use typed tuple equality; do not concatenate strings or equate `"17"` with `17`. Null/empty keys and duplicate keys create explicit ambiguous groups; never pick the first match or create a Cartesian expansion. String equality is exact after any prior explicit normalization. Numeric equality is exact by default; a finite nonnegative absolute tolerance applies only to number fields. No inferred business thresholds or fuzzy entity matching.

Counts have fixed meanings: `equal` and `changed` count matched unique key pairs; `leftOnly` and `rightOnly` count unpaired unique records; `ambiguous` counts unresolved key groups. A duplicate key forms one group across both inputs; each record with an incomplete key forms its own unresolved entry. Ambiguous records do not also enter matched or unpaired counts. Keep equal counts rather than copying every equal record; parents retain the underlying data. Stable output order follows left input then unmatched right input. Missing fields/type mismatches fail. A complete comparison may truthfully contain differences or unresolved groups; tool success does not mean the user's sources agree or that the task is complete. Partial inputs require `allowPartial=true` and remain labelled partial. The model explains the significance and asks about unresolved semantic choices.

No workspace approval is required for the internal operation. Result isolation, limits, cancellation and checksum checks remain mandatory. Expose once two compatible table candidates exist and the group is active. Test explicit key pairs, multiple keys, duplicate/null keys, typed key collisions, changed/missing/equal cases, zero differences, numeric tolerance boundaries, partial data, provenance and stable ordering.

### Shared integration and optional artifact adapter

- Routine observations return ID, kind/version, row counts, limited columns, warnings and at most three short preview rows. Target **2,000 characters including the durable prefix**, below current default caps. `retrieve_result` remains the only paging/inspection tool. Comparison observations show counts and a few entries, never the full inputs.
- Add the three tools to the existing catalogue and capability mapping. Use one small state predicate for table candidates and enforce validated loading in the tool. Cover both compositor and current AgentLoop filtering; an untrusted metadata marker is not sufficient for execution.
- Add the operations to the ledger's meaningful-operation list, as **nonmutating** operations. Preserve IDs and errors. Keep the existing sequential dispatcher barrier for derived result creation, so a later consumer cannot run before registration. Do not add a plan item for each normalization.
- P1-D can already check stored-result integrity. Schema validation is operation evidence, not semantic acceptance. Preserve RunContract completion checks and free-text constraints as unverified when no valid semantic check exists.
- Optional `generate_deliverable.result_id` for XLSX uses the internal loader and writes typed cells through ExcelJS. Require exactly one of `result_id` and `content`. Accept only validated `RecordTableV1` or `ComparisonV1` payloads. Tables preserve all rows; comparisons render stored entries in fixed columns for status, key, left/right refs, compared field and values. Missing/ambiguous records retain their parent refs even without field differences. Include counts, partial status and a source-reference sheet, then use the current staging/validation/promotion lifecycle. Requested exports still require contract scope and the existing approval boundary. No implicit choice of a stored result. Retain text that resembles spreadsheet formulas as literal string cells. Verify generated cells against the full submitted payload in deterministic tests. DOCX narrative/table-block integration can follow later.
- Narrowly stop embedding full supported table attachments in RunManager's initial prompt when this path is enabled. Pass filenames and bounded metadata instead; source access/import stays available. This is required to achieve the context benefit, not a broad compaction rewrite.
- Preserve finish-reason rejection before tool dispatch, original model selection, mode/protected paths, explicit resume and generation profiles. Pure table operations do not grant permission to mutate/export. A restart reads stored tables by ID; it does not automatically execute operations.

## E. Incremental implementation and acceptance

| Change | Acceptance criterion |
|---|---|
| **1. Checked payload access and versioned table contract** | Full text/JSON is consumed internally without display pagination; corruption, cross-run IDs and invalid tables fail. Existing slices behave the same. No new DB store or mandatory call. |
| **2. CSV/JSON import, then XLSX adapter** | Parsed values/record counts and original locators match fixtures. Ambiguous headers/sheets fail clearly. No silent coercion or record loss; limits fail explicitly. Reopening the store preserves values/evidence. |
| **3. Select/normalize/append** | Results match deterministic expected records; source tables remain unchanged; row refs are retained; invalid rules and partial policy are tested. |
| **4. Keyed comparison** | Changed, missing, equal and ambiguous cases produce exact expected counts and refs. Duplicate keys never become false matches. No inference inside the operation. |
| **5. Tool/ledger/exposure integration** | Actual AgentLoop can discover/import/transform/compare by IDs. Pure Chat has the same inference-call count and no new schemas. Hidden/denied capabilities, malformed/truncated calls, cancellation and explicit restart paths remain covered. |
| **6. One XLSX result adapter and bounded attachment path** | An authorized export receives all table rows or comparison entries by ID without model reserialization; reopened XLSX cells match. Unrequested export and malicious paths fail; formula-like strings stay literal. Initial table context is bounded. |

Each step adds focused deterministic tests. Required implementation checks: `npm run typecheck` and `npm test`, followed by one focused primary-model smoke test under General and one under `demo_fast` if tools fit both profiles. Use the repository's `scripts/test.cjs` wrapper: it runs Vitest under Electron's Node runtime to match native addons. The experimental Bounded profile remains selectable; passing it is not a new architectural requirement. Do not conduct a throughput/latency audit.

Existing tests to extend or retain:

| Existing tests | Reusable coverage |
|---|---|
| [result-store.test.ts](/Users/krishay/projects/agent/backend/tests/result-store.test.ts:17) | Immutable files/manifests, restart, exact payloads, pagination, partial state, same-run lineage, corruption and rollback. |
| [result-memory-integration.test.ts](/Users/krishay/projects/agent/backend/tests/result-memory-integration.test.ts:29) | Source/message removal, reopen and retrieval, pre-compaction full reads, real Python output, persistence failure. |
| [document-reader.test.ts](/Users/krishay/projects/agent/backend/tests/document-reader.test.ts:36) | Real DOCX table-to-Markdown and PDF native text extraction. Not generic record import/comparison coverage. |
| [context-compaction.test.ts](/Users/krishay/projects/agent/backend/tests/context-compaction.test.ts:17) | Large/minified observations, old/recent bounds and valid tool-message structure. |
| [dynamic-dispatch.test.ts](/Users/krishay/projects/agent/backend/tests/dynamic-dispatch.test.ts:193) | Progressive capability chain and Chat mutation denial; the chain test simulates exposure, not complete record processing. |
| [execution-ledger.test.ts](/Users/krishay/projects/agent/backend/tests/execution-ledger.test.ts:32) | Idempotent outcome recording, pending approval, interruption, uncertain mutation guard and bounded recovery. |
| [run-verification.test.ts](/Users/krishay/projects/agent/backend/tests/run-verification.test.ts:121) | Result digest refs, restart, truthful missing/failed evidence and simple Chat bypass. |
| [artifact-verification-lifecycle.test.ts](/Users/krishay/projects/agent/backend/tests/artifact-verification-lifecycle.test.ts:156) | Invalid data rejection, real DOCX/XLSX staging/validation/promotion and placeholder rejection. |

### First end-to-end target

Compare two equipment/inventory registers supplied as **CSV and XLSX**. The user explicitly identifies key fields and the fields to compare. Import both; project/rename columns; explicitly trim/lowercase only the requested key; compare; retrieve a changed record and its source evidence; optionally export the requested difference table through the existing XLSX generator.

Fixtures cover equal, changed, left-only, right-only and duplicate-key records; vary filenames, column names and values. These are test fixtures only. The same operations must work for unrelated schedules or sample registers without runtime prompt/entity branches.

The deterministic integration test exercises real files through ToolDispatcher and ResultStore. Remove source files and model messages, reopen SQLite, and complete comparison from stored IDs. Assert exact counts, values, locators, bounded observations and retained partial/failure status. Also cancel before a transform, corrupt a parent payload, and verify no success is published. A mocked gateway confirms zero inference inside the primitives and unchanged ordinary Chat calls. A small live smoke test checks discovery and argument use; it does not prove semantic interpretation for arbitrary documents.

Future P2-B/P2-C work needs only a stable payload loader, result IDs/locators, and adapters to existing extraction/rendering tools. Optional schema-directed document interpretation can produce this table contract with `origin="model_derived"` and source refs. Presentation can consume table/comparison IDs directly. Their full scope is not specified here; P2-A should not invent it.

## F. Risks and non-goals

- **False precision:** a parsed row, valid JSON, checksum, or successful comparison does not prove a document interpretation or business conclusion. Preserve origins and unresolved groups.
- **Silent data changes:** default ExcelJS CSV coercion, numeric rounding, locale dates, missing formulas, merged headers and null/empty equivalence can alter meaning. Keep raw strings by default and require explicit conversion.
- **Weak source identity:** filenames can collide; existing run-file helpers choose basenames/prefix matches. New imports must resolve exact authorized attachments or contained workspace paths and record the byte digest. A source association must not claim stronger evidence than was captured.
- **Context duplication:** tool observations are bounded, but initial attachment injection and artifact-content arguments can still copy full datasets. Address only the supported table path and explicit ID export adapter.
- **Resource limits:** the current store reads whole payloads and caps them at 64 MiB. P2-A uses lower operation bounds and must account for provenance/output expansion and XLSX decompression. No streaming database engine is proposed.
- **Integration omissions:** both per-turn filters and the ledger's tool allowlist need updates. Do not treat newly stored results as completed contract deliverables or bypass approvals for exports.
- **Existing artifact fallback:** first execution slice plus a fixed financial heading is not a generic evidence pipeline. The new explicit adapter must avoid it. Broad legacy/P1 cleanup is outside this audit and implementation scope.
- **Scope growth:** no task DAG, query language, arbitrary formulas/code callbacks, fuzzy joins, automatic semantic retries, aggregation framework, binary DOC/XLS support, new PDF generator, source-authority expansion, routing change or mandatory planning/classification/summarization call.

## G. Decisions for review

1. **Initial format scope:** Include CSV and flat JSON in the core, then XLSX in the next small change before end-to-end acceptance. Prefer this sequence because ExcelJS is already present and workbook access is a concrete current gap. DOCX/PDF table inference remains a later optional adapter.
2. **Ambiguous matching and numeric semantics:** Prefer explicit key pairs, duplicate/null keys reported as unresolved, exact typed equality by default, and caller-supplied absolute numeric tolerance. Defer fuzzy matching, unit conversion and decimal/currency rules until a real requirement defines them.
3. **P2-A export scope:** Prefer one optional XLSX result-ID adapter for tables and comparison entries in the existing generator. Defer narrative document result blocks. This completes a useful source-to-export path without adding a fourth tool or a new document system.

These decisions need scope review before implementation. The existing ResultStore, execution authority, ledger and verification remain the implementation foundation.
