# Proposed follow-up cleanup

## Remove stale retired-RAG references (COMPLETED)

- **Target:** `MIGRATION.md`, `ai/vision/README.md`,
  `ai/draft/prompts/approval-note-drafting-prompt.md`, `ai/draft/README.md`,
  `ai/mock-responses/README.md`, and `ai/shared/README.md`.
- **Status:** **RESOLVED / COMPLETED**.
- **Action Taken:** Obsolete links to `docs/archive/rag-legacy/` and historical archive instructions have been replaced with active fixture paths (`demo/flow_a/`, `demo/flow_b/`, `demo/flow_c/`), and approval-readiness terminology.
- **Impact:** Documentation-only; verified with clean repository-wide search. All test suites continue to pass.
