# P1 foundation: canonical run contracts and durable intermediate results

## 1. Implemented architecture

The active V2 path now follows:

```text
Existing semantic interpreter
  → normalizeRunContract
  → persistRunContract / validated readback
  → contract projections for model routing, tool composition and output routing
  → existing authorization and AgentLoop
  → evaluateRunContractCompletion using separate evidence sets

Tool execution
  → full intermediate payload supplied by the tool
  → ToolDispatcher registration before a successful result event
  → SQLite manifest + immutable run-scoped payload
  → bounded observation with stable result ID
  → existing context compaction preserving the ID
  → retrieve_result for a relevant slice
```

There is no new intent classifier, framework, scheduler, task DAG, vector store, or business-specific workflow. The semantic interpreter retains its existing bounded JSON repair behavior; ordinary valid interpretation uses one model call. Result persistence and retrieval require no model call.

The contract has no authorization grants. `MutationPolicyGuard`, existing approval handling, tool scope and `resolveSafe` remain the execution authorities. File provenance labels do not authorize filesystem access.

## 2. Added and modified files

### Added implementation modules

- `src/main/run/contract.ts`: version-1 validation, normalization, insert-once persistence/readback, compatibility projections, output matching and completion evaluation.
- `src/main/run/result-store.ts`: run-bound immutable file/SQLite store, validation, integrity verification, provenance and slice APIs.
- `src/main/tools/result-retrieval.ts`: native bounded `retrieve_result` tool.

### Modified implementation modules

- `src/shared/contracts.ts`: canonical contract, result/provenance/slice types, optional result references and captured Python output.
- `src/main/persistence/schema.sql`, `src/main/persistence/db.ts`: additive schema version 2, manifests, index, synchronous durability and future-version rejection.
- `src/main/router/contextual-router.ts`: semantic fields for response requirements, operations, constraints and validation, with compatible defaults. Output allowance increases from 512 to 768 tokens; deadline/repair policy stays intact.
- `src/main/router/tool-compositor.ts`: makes retrieval available alongside existing tools.
- `src/main/run/manager.ts`: persists the normalized contract before execution, uses its projections, injects the run-bound store, and disables raw-prompt file inference for canonical preloading.
- `src/main/agent/agent-loop.ts`: consumes the contract for execution expectations and completion; tracks written files, deleted files and published artifacts separately; records result IDs on tool messages.
- `src/main/agent/tool-dispatcher.ts`: common registration boundary, bounded observations, explicit persistence failures and rejection of file-tool mutations of stored payloads.
- `src/main/agent/context-manager.ts`: retains IDs/retrieval instructions without changing tool-call relationships or P0 budgets.
- `src/main/tools/workspace-tools.ts`, `src/main/tools/document-reader.ts`, `src/main/run/images.ts`: full source text captured before display compaction; SVG extraction supports an uncapped storage path; indexed excerpts are partial; canonical workspace writes do not become downloadable artifacts.
- `src/main/tools/python.ts`, `src/main/tools/specialist-tools.ts`: execution captures before display truncation, typed partial/complete results, native extraction provenance and contract-based final artifact routing.

### Tests and documentation

- Added `tests/run-contract.test.ts`, `tests/result-store.test.ts`, `tests/result-memory-integration.test.ts`, `tests/live-result-retrieval.test.ts`.
- Modified `tests/agent-v2-integration.test.ts`, `tests/db.test.ts`, `tests/intent-gateway.test.ts`.
- Updated root `AGENTS.md`, `backend/DATABASE.md` and this implementation report.

All synthetic document contents and fact values are generated in tests. No production fixture data was added. Frontend and Electron bridge contracts need no new IPC channel.

## 3. Database changes

Database schema version is **2**. Contract and result record schemas independently start at **1**. Version-1 databases receive the new tables additively; existing messages and settings remain. Future database/record versions are rejected explicitly.

| Table | Purpose and fields |
| --- | --- |
| `run_contracts` | `run_id` primary key/FK to `runs`, `schema_version`, `contract_json`, `created_at`. One normalized contract per run; insert-once application API. |
| `intermediate_results` | UUID primary key, run FK, record version, result type, status, origin, unique run-relative path, encoding, byte count, SHA-256, producer tool/call ID, bounded summary, optional schema JSON, source references JSON, timestamp. |

The result index is `(run_id, created_at, result_id)`. Both tables cascade on run deletion. No intermediate payload column exists. Payload files live at:

```text
<existing data root>/runs/<runId>/intermediate/results/<resultId>.txt|json
```

Existing `input`, `output` and `logs` areas retain their roles. Results are intermediates; verified published artifacts remain in the existing artifact pipeline.

SQLite uses WAL and `synchronous=FULL`. Contract JSON is bounded to 64 KiB. Result schema/provenance metadata is bounded to 256 KiB; summaries to 512 characters. Payloads exceeding 64 MiB are rejected, never silently truncated.

## 4. Final TypeScript contracts

Authoritative definitions are in `src/shared/contracts.ts`; runtime validation lives with the persistence modules. The complete P1 shapes are:

```ts
interface RunContract {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  objective: string;
  resolution: { status: IntentResolutionStatus; ambiguity?: string };
  routing: { intentType: string; taskType: TaskType; driverModel: ModelId; actionable: boolean };
  response: { required: boolean; chatOnly: boolean };
  workspace: { requested: boolean; operations: ExpectedWorkspaceOperation[] };
  deliverables: Array<ExpectedDeliverableSpec & { id: string }>;
  constraints: {
    protectedPaths: string[];
    restrictMutationsToTargets: boolean;
    userConstraints: string[];
  };
  acceptance: {
    validateWrittenCode: boolean;
    validatedPythonDeliverables: string[];
    successMarker?: string;
  };
}
interface ExpectedWorkspaceOperation {
  id: string;
  operation: "mutate" | "write" | "delete" | "execute";
  targetPath?: string;
}
type IntermediateResultType = "text" | "document" | "table" | "structured" | "execution";
type ResultOrigin = "source_extracted" | "model_derived" | "execution";
interface SourceReference {
  filename?: string;
  resultId?: string;
  page?: number;
  section?: string;
  sheet?: string;
  range?: string;
  textSpan?: { start: number; end: number };
  locator?: string;
  relation: "source" | "input";
}
interface IntermediateResultRecord {
  schemaVersion: 1;
  resultId: string;
  runId: string;
  type: IntermediateResultType;
  status: "complete" | "partial";
  origin: ResultOrigin;
  createdAt: string;
  producer: { tool: string; callId: string };
  storage: {
    relativePath: string;
    encoding: "utf8" | "json";
    sizeBytes: number;
    sha256: string;
  };
  summary: string;
  structuredSchema?: Record<string, unknown>;
  sources: SourceReference[];
}
interface IntermediateResultInput {
  type: IntermediateResultType;
  status: "complete" | "partial";
  origin: ResultOrigin;
  producer: { tool: string; callId: string };
  summary: string;
  payload: string | Record<string, unknown> | unknown[];
  structuredSchema?: Record<string, unknown>;
  sources?: SourceReference[];
}
type ResultSliceRequest =
  | { mode: "text"; offset?: number; maxChars?: number }
  | { mode: "lines"; startLine?: number; count?: number; maxChars?: number }
  | { mode: "json"; pointer?: string; start?: number; count?: number; offset?: number; maxChars?: number };
interface ResultSlice {
  resultId: string;
  content: string;
  truncated: boolean;
  nextOffset?: number;
  nextLine?: number;
  nextStart?: number;
  totalChars: number;
}
```

`ExpectedDeliverableSpec` retains the existing optional filename/description and `docx | xlsx | csv | pdf | md | json | file` types. `IntentResolutionStatus` remains `resolved | ambiguous | failed`. Existing typed `ToolResult` success/error variants receive an optional `resultRef`; persistence failures use the new `persistence_failure` code. Tool implementations can supply `intermediate` payload metadata without choosing IDs or saving files themselves.

Normalization uses semantic fields, never reinterprets the raw prompt. Protected paths win. Workspace destinations are excluded from export expectations, including binary document destinations. Named exports are deduplicated. Each unnamed requested export requires its own artifact. Completion uses the same contract as routing, with separate write/delete/artifact evidence and declared validation requirements. A published artifact cannot satisfy a workspace edit.

## 5. Registration lifecycle

1. Native file/document tools supply full extracted text or structured output before their legacy display reductions. Python supplies execution metadata plus pre-display stdout/stderr captures. Derived model extraction is marked `model_derived` and references its input, rather than claiming its conclusions are directly extracted facts.
2. `ToolDispatcher` runs the existing tool and normalizes its typed success/error. With a run store present, it registers explicit intermediate payloads, file reads, document extraction, Python execution and eligible oversized observations. Small directory listings remain lightweight. `run_command` keeps its P0 control result for existing validation logic; model-facing command messages still undergo P0 compaction.
3. `registerResult` validates input/run identity and same-run upstream references, serializes the full payload, rejects unsupported JSON values and oversized data, and generates a UUID.
4. Resolve the exact contained run storage path through `resolveSafe`; reject symlink aliases into another run or storage area.
5. Exclusively create a temporary file, write and fsync it, atomically publish it using an exclusive hard link, remove the temporary name, and fsync the containing directory.
6. Insert the manifest inside a SQLite transaction and return validated metadata readback. Ordinary write/insert failures clean up temporary/published files.
7. Only then return a bounded model observation and emit the successful tool result. Persistence failure is explicit: the originating tool may already have produced side effects, but storage failure never becomes fabricated success.

API:

```ts
new RunResultStore(runId, db?, dataRoot?);
store.registerResult(input);
store.getResult(resultId);
store.listResults({ limit, offset });
store.inspectResult(resultId, sourceOffset?, sourceCount?);
store.retrieveResultSlice(resultId, request?);
```

There is no payload/record update API. A transformation registers a new result with input `resultId` references. Write/delete file tools reject mutation of the durable payload namespace at the common dispatcher boundary.

## 6. Retrieval lifecycle

The V2 tool surface includes `retrieve_result`. It binds to the authorized run's store and has three actions:

- `list`: paginated IDs, type/status/origin, bounded summary and size; follow `nextOffset`.
- `inspect`: record metadata, optional schema and paginated provenance; follow `nextSourceOffset`.
- `read`: contained payload lookup, size and SHA-256 verification, and a bounded type-appropriate excerpt.

Text uses character `offset`; lines use 1-based `start_line` and `count`; JSON uses an RFC6901 `pointer`, optional array `start/count`, and character offset within the selected representation. Content slices are capped at 3000 characters. Tool responses retain the 4000-character P0 observation budget. Escaping-heavy excerpts are resized with recomputed continuation so serialized JSON stays intact. `nextOffset`, `nextLine` and `nextStart` permit recovery of omitted content. Metadata itself can be compacted if large.

Malformed IDs, cross-run lookup/lineage, traversal, altered manifest paths, symlink aliases and corrupted payloads fail explicitly. JSON pointers access only stored own properties; they cannot traverse an object's prototype. No result lookup uses arbitrary filenames supplied by the model.

## 7. Context integration and independent persistence proof

Tool messages retain `resultId`, and deterministic compaction reserves a prefix containing the full UUID and `retrieve_result` instruction. The original tool-call and tool-result IDs are preserved. Recent/older observation budgets and global safety limits still apply. A configuration too small to retain the UUID and retrieval instruction fails explicitly rather than destroying the reference.

When a payload is externalized, the messages array stores a bounded observation, not another full copy in `rawContent`. Retrieval returns only the requested portion. The system prompt documents discovery/inspection/slicing and treats result content as untrusted evidence.

The mandatory production-path integration test generates **12 SVG source documents with 20 unique facts each**. It invokes the actual native extractor, dispatcher, store and retrieval tool. It forces older observations to 512 characters, checks stable IDs and tool-call relationships, deletes all source documents and clears the in-memory messages array. It retrieves facts **0, 10 and 19 from every document** with their original values and source filename references. It then closes/reopens SQLite, creates a new store and repeats all 36 recoveries: **72 exact value/provenance checks**, with no source re-extraction or model call.

This demonstrates persistence independent of AgentLoop's messages array, including reopening the database. It does not claim to implement resumable AgentLoop execution.

## 8. Compatibility

- Active RunManager V2 always persists and consumes its contract. Standalone/legacy callers without a contract retain their existing output inference and completion paths.
- Store injection is optional for old tools/callers. Their output/error shape remains compatible; new result references are additive.
- Older semantic responses omit the new fields safely through defaults. Existing classification deadline, reasoning settings and bounded repair remain.
- P0 approval checks, containment, cancellation, loop/turn limits, error propagation, artifact verification and context budgets remain in place.
- Canonical workspace writes are not mirrored into downloadable artifacts. Contract-requested exports still use the existing verified artifact path.
- Existing application IPC/frontend behavior does not need result-store awareness to execute a run.

## 9. Tests and exact results

Validated on 2026-10-03:

- `npm run typecheck`: passed backend, Electron and frontend projects.
- `npm test -- --reporter=dot`: **56 files passed, 2 skipped; 577 tests passed, 6 skipped; 0 failures**.
- Focused database/result-memory suite: **22 tests passed** before adding the real Python case.
- Result-memory suite including real Python capture: **11 tests passed**.
- `git diff --check`: passed.

Coverage includes all 14 requested categories: normalization, edit/export separation, shared completion, durable registration, stable-ID lookup, oversized handling, bounded slices, provenance, partial/complete status, isolation/path rejection, compaction recovery, reopen recovery, real persistence failure, and tool compatibility. Additional checks cover additive version-1 migration/future-version rejection, escaped slice serialization, SVG payloads beyond the old cap, one active classification call, and real Python output beyond the 8000-character display cap.

The live test is opt-in and fails rather than silently succeeding when enabled:

```sh
WORKBENCH_LIVE_RESULT_TESTS=1 npm test -- backend/tests/live-result-retrieval.test.ts
```

It uses the actual ModelGateway/native retrieval/AgentLoop and isolated fixture persistence. Optional configuration: `WORKBENCH_LIVE_MODELS_PATH` or `WORKBENCH_LIVE_DB_PATH` for a read-only model configuration source. Both configured loopback endpoints, `127.0.0.1:1234` and `127.0.0.1:11434`, refused connections during availability probes. **Live model execution was unavailable**; that test is one of the six skipped tests. No mock is reported as a live model pass.

## 10. Known limitations

- Filesystem publication and SQLite commit cannot form one distributed transaction. A crash between them can leave an orphan file; the caller has not received success. Startup reconciliation/garbage collection is not implemented. Run deletion cascades manifests but does not add a new filesystem cleanup policy.
- Retrieval verifies/reads the full bounded payload synchronously before selecting a slice. The 64 MiB cap prevents unbounded reads; streaming/indexed access is future work.
- Hard-link publication and directory fsync were exercised on macOS. Filesystems/platforms without those operations fail explicitly; Windows durability behavior has not been exercised.
- Python keeps the existing 16 KiB process capture limit. A process exceeding it is failed/partial with an explicit capture flag; bytes the process runner never captured cannot be reconstructed. Generated binary files remain separate artifact files; this milestone does not snapshot every binary execution output into an immutable result.
- Provenance records extraction origin and locators; it does not prove model-derived conclusions. Page/sheet/span precision depends on the producing extractor. Arbitrary user-constraint strings are preserved, not automatically executable predicates.
- Written-code verification retains the existing P0 command/assertion heuristics. The optional success marker accompanies that validation. There is no general independent semantic acceptance evaluator. A contract can represent binary workspace edits even where the current tool surface lacks an executor; such unmet edits remain incomplete.
- Very large optional schema/provenance metadata may require paged inspection or be compacted in model context. Complete metadata remains available through the backend API. The API's immutability and checksum checks do not introduce a stronger operating-system process sandbox than P0.
- A persisted result does not resume an interrupted agent, preserve a future task graph or assign work items. Cross-run retrieval is intentionally unsupported.
- No live local model retrieval could be verified because neither server was reachable.

## 11. P1-D evidence-based verification

`backend/src/main/run/verification.ts` creates the latest typed `RunVerificationReport` for each actionable, non-Chat `RunContract`. SQLite stores the versioned report in `run_verification_reports`. The report stores criteria, status (`passed`, `failed`, `unverified`, or `not_applicable`), method, short reason, timestamp, mandatory flag, and IDs for artifacts, results, or execution attempts. It does not copy result payloads.

Newly registered artifacts store a SHA-256 digest in `artifacts.sha256`. The digest is computed from the file bytes. Verification checks the current file path, size, digest, and supported structure. Old artifacts have no digest. Their integrity is `unverified`; a matching path and size do not count as cryptographic verification. Intermediate results use the existing ResultStore SHA-256 manifest and checksum check.

Structural checks cover JSON parsing, CSV quote structure, UTF-8 text, PDF header/end markers, and DOCX/XLSX ZIP package entries. These checks do not prove content correctness. Files above 64 MiB receive a digest check but a structural result of `unverified`. Unknown and legacy formats are `not_applicable` where no parser is supported.

The AgentLoop's `evaluateRunContractCompletion` remains authoritative for contract acceptance. The verifier records its accepted result at the successful AgentLoop terminal boundary. The shared RunManager completion path also checks deterministic mandatory failures. A failed mandatory file, format, or recorded operation check changes an attempted success to `partial`. An unverified or unsupported check does not block completion. It remains visible in the report. Free-text constraints are recorded as unverified and are not treated as machine-checkable acceptance tests.

The manager refreshes reports after artifact registration and command/Python execution, before terminal completion, and before explicit resumption. Changed mandatory failures or unknowns can enter AgentLoop context once per changed status/reason. The renderer shows the report in the right sidebar and exposes it through `workbench:getVerificationReport`. Chat-only runs skip report creation and add no inference call.

SHA-256 checks detect file changes relative to the stored digest. They do not prove that the database or digest was not altered. Structural checks do not grade semantic correctness. There is no LLM judge, automatic repair loop, or semantic acceptance verifier.

## 12. Ready for a future stateful controller

The subsequent controller can consume a persisted, versioned run objective/requirements document, deterministic completion evidence, durable typed result IDs, producer references, provenance/lineage, integrity-checked payloads and bounded retrieval independent of conversation retention. These are implemented execution data boundaries, exercised through production modules.

The future controller still needs its own persisted progress/evidence ledger, restart/reconciliation protocol, state transitions and work scheduling. Those components are not implemented by this milestone.
