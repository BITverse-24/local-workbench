# Plan: Fix Knowledge Retrieval (Remove Hardcode, Use Corpus Manifest)

**Goal:** Replace `backend/src/main/tools/knowledge.ts:4` term-matching stub + `backend/src/main/run/manager.ts:268-294` SOP-114 injection with manifest-driven retrieval so `search_knowledge` returns `SOP-114 §3.2` + `TPL-012` naturally and draft validates `citation ∈ retrievedChunks`.

**Token budget:** <1.5k tokens total.

## 1. Problem
- `knowledge.ts` scans `demo-fixtures/rag-corpus/docs/*.md`, scores `terms.filter(t=>text.includes(t)).length`. Ignores `demo-fixtures/rag-corpus/corpus-manifest.json` (10 docs, section = chunk, `stableChunkId=<documentId>:<sectionId>`). Produces `§content` labels, single chunk per file, wrong scores. Query `IR-E201 ... tube-wall below minimum ... pitting ... gasket degradation` ranks `WI-008`/`SOP-520` equally, misses `SOP-114 §3.2`.
- `manager.ts:267-294` works around it by injecting hardcoded `SOP-114:3.2` excerpt (slice `## [section:3.2]`). Masks bug; draft then cites injected chunk but validation `backend/src/main/validators/responses.ts:validateDraft` allows any injected `WI-008 §content`, leading to `[SOP-520 §content]` in DOCX.

## 2. Changes

### A. `backend/src/main/tools/knowledge.ts:1-4` (primary)
Replace whole file:
- Resolve manifest path: `existsSync(cwd/demo-fixtures/rag-corpus/corpus-manifest.json)` else `../demo-fixtures/...`.
- Load & cache JSON once (module-level `let manifest`). Parse `documents[].sections[]`. Keep `embedding.model=BAAI/bge-small-en-v1.5, dimensions=384, cosine, normalize=true` from manifest for future real embeddings.
- Implement `searchKnowledge(query, topK=5): RetrievedKnowledgeChunk[]`:
  1. Tokenize query `query.toLowerCase().split(/\W+/).filter(Boolean)` + keep hyphenated `tube-wall` as both `tube-wall` and `tube` `wall`.
  2. For each section, compute score = weighted overlap: `keywords ∩ terms` *2 + `excerpt lower includes term` *1 + `label/documentId` bonus (+3 if `tube-wall|pitting|gasket` + `approval criteria`). Normalize by keywords length to prefer precise matches. This gives `SOP-114 §3.2` excerpt `When a report identifies a tube-wall measurement below... pitting, or gasket degradation` score ~12 vs `SOP-520` ~3.
  3. Return `chunks.sort((a,b)=>b.score-a.score).slice(0,topK)` mapped to `RetrievedKnowledgeChunk{chunkId: "<documentId>:<sectionId>", documentId, sectionId, label:"<documentId> §<sectionId>", documentTitle, excerpt: section.excerpt, score}`. No filesystem scan.
- Fallback: if manifest missing, return `[]` (manager throws `no matching knowledge source`). No `readFileSync` on `flow-a/*.md`.
- Optional phase-2: replace scoring with real Chroma `chroma-js` + local transformer `bge-small-en-v1.5` embeddings; manifest already defines `distanceMetric=cosine`. Keep deterministic fallback for offline.
- Add `clearCache()` export for tests.

### B. `backend/src/main/run/manager.ts:265-296`
- Delete lines 267-294 hardcode injection (the `if (!chunks.some(...SOP-114...)) { readFileSync candidates... }` block). Keep:
  ```ts
  const chunks = searchKnowledge(`${vision.value.sourceText} ${vision.value.findings.map(f=>f.value).join(" ")}`);
  if (!chunks.length) throw new Error("no matching knowledge source");
  ```
- No other logic change. Flow remains `ocr_extract -> search_knowledge -> routing:draft -> draft_note`. Ensures `manager.ts:326 validateDraft(chunks)` actually validates real retrieval; wrong `WI-008 §content` will now fail and trigger `buildDraftRepairPrompt` retry.

### C. No change required
- `backend/config/models.json`, `prompts.ts`, `ai/contracts.ts` unchanged. `DRAFT_SYSTEM_PROMPT` already says `citations must be from retrievedChunks`. `validators/responses.ts` already enforces `unsupported_citation` — now effective.
- `model-gateway.ts` vision fix (`PDF -> 2x image_url 1024px`) stays.

## 3. Verification
1. Unit: `npm test` — update `knowledge.test.ts` if exists to assert `searchKnowledge("tube-wall below minimum pitting gasket")[0].label==="SOP-114 §3.2"` and top 5 includes `TPL-012 §equipment-header`.
2. Integration: `npm run build && npm test` (34 tests). Manual Flow-A: attach `demo-fixtures/flow-a/inspection-report-E201.pdf`, expect gateway log `visionPartsCount:2 image_url`, `prompt_tokens ~820`, then `search_knowledge: 5 local chunks retrieved` where `SOP-114 §3.2 score ~0.9` top, `TPL-012` next, no `WI-008 §content`.
3. Draft: `draft_note validated` on first try, `expected-approval-note.json` content matches `IR-E201-2026-08-20, E-201, Headers Exchanger Midwest Unit 2 IR-E201-2026-08-20 inspection report 2026-08-20; Findings Summary p1/p2; Recommendation conditional clearance pending retubing + gasket replacement; Grounding [SOP-114 §3.2]`.

## 4. Risks
- Naive keyword scoring still brittle vs true cosine; mitigate by weighting `keywords` from manifest (authoritative) not full text. Upgrade to real embeddings later without API change.
- Manifest `contentSha256` unchanged — no re-embedding needed.

## 5. Files Touched
- `backend/src/main/tools/knowledge.ts` (rewrite ~40 lines)
- `backend/src/main/run/manager.ts` (delete ~28 lines)
- `docs/PLAN-knowledge-fix.md` (this plan)
