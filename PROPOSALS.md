# Proposed follow-up cleanup

## Remove stale retired-RAG references

- **Target:** `MIGRATION.md`, `ai/vision/README.md`,
  `ai/draft/prompts/approval-note-drafting-prompt.md`, `ai/draft/README.md`,
  `ai/mock-responses/README.md`, and `ai/shared/README.md`.
- **Issue:** These files still mention `docs/archive/rag-legacy/`,
  `expected-retrieval`, or the retired archive as historical material. The
  archive has now been deleted and Flow A fixtures live under
  `demo/flow_a/`.
- **Evidence:** Repository-wide search after archive deletion returns stale
  references in the listed files.
- **Suggested change:** Replace obsolete archive links with the active fixture
  paths and approval-readiness terminology, or remove migration-only archive
  instructions that no longer describe the repository.
- **Reason:** Prevent broken links and ensure active documentation consistently
  reflects the retired retrieval/template workflow.
- **Impact:** Documentation-only; no runtime behavior changes.
