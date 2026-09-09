# RAG legacy archive (non-runtime, non-authoritative)

Active retrieval-augmented generation was removed during the repository
migration (`MIGRATION.md` §10). Nothing under this directory is imported,
executed, or tested by the application:

- No runtime import may reach these files (verified by the no-active-RAG
  static grep over `backend/`, `frontend/`, `electron/`, `ai/`, `config/`).
- Fixture expectations, corpus manifests, section IDs, citation formats, and
  prompt text here describe the pre-migration system only.
- A future grounding capability will define new contracts from scratch; it
  must not resurrect these types or paths implicitly.

Contents: historical RAG plans, the curated demo corpus and its manifest
tooling, Flow A (scanned-report → approval-note) fixtures, and the
retrieval/citation fixture descriptions that were previously treated as
active acceptance.

## Lane 3 inventory (migration archive intake)

Moved here (not copied) during AI-layer reorganization; original paths are
gone from the active tree:

- `docs/PLAN-knowledge-fix.md` → `PLAN-knowledge-fix.md` — the
  manifest-driven retrieval fix plan for `search_knowledge`; superseded by
  RAG removal.
- `demo-fixtures/rag-corpus/` → `rag-corpus/` — ten-document demo corpus,
  `corpus-manifest.json`, `queries.json`, and corpus manifest/validate
  tooling. Untouched.
- `demo-fixtures/flow-a/` → `flow-a/` — deferred Flow A fixtures, including
  `expected-retrieval.json`, the OCR/draft oracles, the sample PDF, SOP and
  template seeds. Untouched. (`demo-fixtures/flow-b/` stays active.)
- `ai/approval-note-drafting-prompt.md` → `approval-note-drafting-prompt.md`
  — pre-migration source-grounded drafting prompt. The active decoupled
  prompt is `ai/draft/prompts/approval-note-drafting-prompt.md`.
- `ai/contracts.md` → `ai-contracts.md` — human-readable contract notes
  describing citation-membership rules; superseded by the per-service
  READMEs under `ai/`.
- `ai/prompt-regression.md` → `ai-prompt-regression.md` — offline RAG
  acceptance plan (retrieval oracle, citation grounding checks); superseded.
- `ai/backend_implement.md` → `ai-backend-implement.md` — early working
  notes for wiring the backend to the pre-migration AI contracts.
- `ai/without_backend.md` → `ai-without-backend.md` — early completed-task
  notes, including the embedding-service table.
- `ai/mock-responses/successful-drafting.json` →
  `ai-mock-successful-drafting.json` — draft mock with chunk-coupled
  citations; no longer used by any test.
- `ai/PROPOSALS.md` — deleted outright as a superseded working file
  (not archived).
- `ai/contracts.ts` (global type dump), `ai/model-registry.ts` (dev
  registry duplicating `config/models.json`, plus the LAN-local embedding
  service entry) — deleted outright; replaced by `ai/shared/`,
  `ai/vision/contract.ts`, `ai/draft/contract.ts`, `ai/code/contract.ts`,
  `ai/tools/contracts.ts` (not archived; the RAG-coupled types
  `KnowledgeSectionReference`, `RetrievedKnowledgeChunk`, `Citation`,
  `CitationValidationResult` are intentionally dropped from active paths).
