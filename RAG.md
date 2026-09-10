This is the piece that turns your outputs from "plausible-sounding text" into demonstrably grounded answers — worth getting the pipeline stages right since Flow 1 and Flow 3 both lean on it. Let me lay out the full pipeline, then go stage by stage.## Ingestion: what actually needs deciding at each stage

**Document intake.** Support a watched folder (admin drops files, system auto-indexes) plus manual upload from the dashboard. Tag every document at intake with: document type, department/sensitivity level, version/revision number, effective date. This metadata is what makes citations meaningful later ("SOP-14 Rev C, effective March 2025" beats "some document").

**OCR/vision extraction.** This is the step that reuses infrastructure you already built — route scanned SOPs and drawings through the same vision-role endpoint from Flow 1/3, so you're not maintaining a second OCR pipeline. Worth flagging: OCR output on scanned technical documents often mangles tables and numbered clauses, so plan a lightweight verification step (even just: does the extracted text contain a plausible clause-numbering pattern?) rather than trusting raw OCR output blindly into the index.

**Structure-aware chunking — this is the detail most RAG builds get wrong for SOPs specifically.** Naive fixed-length chunking (e.g. "every 500 tokens") will frequently split a clause from its number, or bury a threshold value in a chunk boundary. For SOPs/manuals, chunk along document structure instead — section headers, clause numbers, table boundaries — so a retrieved chunk is a coherent, citable unit ("Clause 4.3.2 — Permissible corrosion allowance") rather than an arbitrary text fragment. This directly determines whether your Flow 1/3 citations look precise or vague in front of judges, so it's worth the extra engineering time.

**Embedding.** This is just another entry in the model-endpoint table you already designed — role: `embedding`, pointing at whatever embedding model you run (e.g. `nomic-embed-text` or `bge-large` via Ollama's `/v1/embeddings`). No new infrastructure concept needed.

**Index.** For the hackathon timeline, don't reach for a distributed vector DB — an embedded, file-backed store (Chroma or LanceDB running as a local process on your backend node) is simpler to demo and fully sufficient at SOP-corpus scale. But add a **keyword/BM25 index alongside the vector index**, not instead of it. Technical SOPs are full of exact identifiers — clause numbers, valve tags, pressure ratings — that embedding similarity handles poorly (semantically "close" isn't the same as "the exact clause number matched"). Hybrid retrieval (vector for conceptual matches + keyword for exact terms, merged) is a meaningfully better result for this domain, and it's also an easy thing to point at in a demo Q&A if a judge asks how you handle exact spec lookups.

## Retrieval: the part that actually shows up in your demo

**Re-ranking.** After hybrid retrieval pulls, say, top-20 candidate chunks, run a fast re-rank pass (a small cross-encoder, or even the reasoning model itself scoring relevance) to cut down to the 3-5 chunks that actually go into the prompt. This matters more than people expect — it's the difference between the model citing the *right* SOP clause versus a plausible-but-wrong one buried in noisy retrieval.

**Grounded generation with visible citations.** The generation step should be constrained to answer *only* from retrieved chunks and required to cite which chunk backs each claim — this is what Flow 1 and Flow 3 both depend on. Surface this in the UI as a visible "source" tag or expandable snippet next to each claim, not just a footnote. That visible traceability is genuinely your strongest differentiation point against generic chatbot demos — it's the concrete answer to "how do we know it's not hallucinating."

# Local SOP / RAG Grounding Engine — MVP Spec

**Scope:** everything needed for Flow 1 (approval note) and Flow 3 (drawing compliance check) to
retrieve real, cited SOP content. Nothing else. This spec deliberately excludes features that don't
change whether the demo works.

---

## 1. Non-Goals (explicitly stripped for MVP)

Cut these now. Add only if there's time left after the three demo flows are solid.

- ❌ Chunk-level access control / sensitivity tiers — single access level for MVP, all indexed docs
  are readable by the assistant. Document-level tagging only (see §3), enforcement deferred.
- ❌ Document versioning / supersession logic — re-indexing a doc simply replaces its old chunks.
  No "superseded but retrievable" state.
- ❌ Cross-encoder re-ranking model — use score-based merge of vector + keyword results instead of
  a second model pass. Saves a model slot and a failure point.
- ❌ Auto-discovery of new files — admin manually triggers re-index from the dashboard. No file
  watcher/daemon.
- ❌ Multi-tenant / multi-org knowledge bases — one flat corpus.
- ❌ Query rewriting / multi-hop retrieval — single retrieval pass per query.
- ❌ Feedback loop / relevance learning — no click-through or thumbs-up training.

If a judge asks about any of these: answer is "designed for, deferred post-MVP" — the schema below
already has the fields these features would hang off of, so say so.

---

## 2. Components (MVP)

| Component | MVP choice | Runs on |
|---|---|---|
| OCR/vision extraction | reuse the vision-role model endpoint (already registered) | remote node, LAN |
| Embedding | reuse the embedding-role model endpoint (already registered) | remote node, LAN |
| Vector index | Chroma (persistent, local file store) | backend node |
| Keyword index | SQLite FTS5 (built-in, zero extra service) | backend node |
| Chunker | rule-based, structure-aware (see §4) | backend node |
| Retrieval merge | reciprocal rank fusion (RRF) — simple, no extra model | backend node |
| Generation | reuse the reasoning-role model endpoint | remote node, LAN |

No new services beyond what the model-endpoint registration already gives you. Chroma and SQLite
both run in-process on the backend — no separate DB server, no ports to manage, no extra onboarding
step.

---

## 3. Data Model

### 3.1 Document record

```json
{
  "doc_id": "sop-014",
  "title": "Pressure Vessel Inspection SOP",
  "source_path": "/kb/raw/sop-014.pdf",
  "doc_type": "sop",
  "department": "maintenance",
  "effective_date": "2025-03-01",
  "indexed_at": "2026-09-10T10:00:00Z",
  "page_count": 12,
  "ocr_used": true
}
```

`department` exists now so chunk-level ACL is a filter you can bolt on later without a schema change.

### 3.2 Chunk record (what actually gets embedded and retrieved)

```json
{
  "chunk_id": "sop-014-c4.3.2",
  "doc_id": "sop-014",
  "section_label": "4.3.2",
  "section_title": "Permissible corrosion allowance",
  "text": "Minimum remaining wall thickness shall not fall below ...",
  "page": 6,
  "embedding": [ /* float vector */ ]
}
```

`chunk_id` is human-readable and doubles as the citation string shown in the UI — e.g. "SOP-014,
clause 4.3.2, p.6". This is the single most important field for making Flow 1/3 look credible: the
citation the user sees should be exactly this string, not a generic "source: document.pdf".

---

## 4. Ingestion Pipeline (MVP steps only)

1. **Extract text.** Native PDFs/docx → direct text extraction. Scanned pages/images → send to the
   vision-role endpoint, get back plain text per page.
2. **Chunk by structure, not fixed length.** Split on detected section/clause headers (regex for
   patterns like `\d+(\.\d+)+` at line start, plus common headers like "Section", "Clause",
   "Table"). Fallback: if no structure is detected, chunk by paragraph with a max of ~300 tokens —
   don't over-engineer a fallback, this is an edge case for MVP.
3. **Embed each chunk** via the embedding endpoint. Batch requests, don't embed one chunk at a time.
4. **Write to both indexes:**
   - Chroma: `chunk_id`, `embedding`, `text`, metadata (`doc_id`, `section_label`, `page`)
   - SQLite FTS5: `chunk_id`, `text` (for exact keyword/clause-number matches)
5. **Re-index trigger:** admin dashboard button, per-document or "re-index all." No background
   automation needed for MVP.

That's the entire ingestion pipeline. No embedding cache invalidation logic, no incremental diffing
— just delete-and-rewrite a document's chunks on re-index.

---

## 5. Retrieval Pipeline (MVP steps only)

1. **Embed the query** (same embedding endpoint).
2. **Vector search:** top 10 chunks from Chroma by cosine similarity.
3. **Keyword search:** top 10 chunks from SQLite FTS5 (handles exact clause numbers, valve tags,
   numeric thresholds that embeddings miss).
4. **Merge via Reciprocal Rank Fusion** — no extra model call, just:
   `score(chunk) = Σ 1/(60 + rank_in_list)` across the two ranked lists. Take top 5 by fused score.
5. **Build the grounding prompt:** inject the 5 chunks with their `chunk_id` labels, instruct the
   generation model to answer only from provided context and cite `chunk_id` inline for every claim.
6. **Parse citations from the model's answer** (simple regex for the `chunk_id` pattern) and render
   them as clickable/expandable source tags in the UI.

Step 6 is what makes the grounding *visible* rather than just prompted-for — worth not skipping,
since it's your strongest demo-credibility moment.

---

## 6. Internal API Contract

Keep this to two endpoints for MVP — the agent orchestrator only ever needs these:

```
POST /kb/reindex
  body: { "doc_id": "sop-014" }        # or {} for full re-index
  returns: { "status": "ok", "chunks_indexed": 41 }

POST /kb/query
  body: { "query": "corrosion allowance for 6mm vessel wall" }
  returns: {
    "chunks": [
      { "chunk_id": "sop-014-c4.3.2", "text": "...", "doc_id": "sop-014",
        "section_label": "4.3.2", "page": 6, "score": 0.83 }
    ]
  }
```

The agent's tool-calling layer calls `/kb/query`, gets chunks back, and hands them to the
generation model itself — the KB engine doesn't call the LLM; it only retrieves. Keeps this
component testable in isolation, which matters if you need to debug retrieval quality independently
of generation quality during dev.

---

## 7. Acceptance Criteria (what "done" means for the demo)

- [ ] Re-indexing a folder of ~10-20 sample SOPs completes without manual intervention beyond
      clicking "re-index."
- [ ] A query containing an exact clause number or spec value returns the correct chunk in the top
      3 fused results (tests the keyword-search half is pulling weight, not just vector search).
- [ ] A paraphrased/conceptual query (no exact terms) also returns the correct chunk in the top 3
      (tests the vector-search half).
- [ ] Every claim in a generated approval note / compliance flag carries a visible `chunk_id`
      citation that a human can click through to the source text.
- [ ] Re-running the same query twice gives the same top result (no flaky nondeterminism from the
      fusion step).

---

## 8. Explicitly Deferred (post-MVP backlog, not built now)

Access control by sensitivity tier · document versioning/supersession · cross-encoder re-ranking ·
file-watcher auto-ingestion · multi-hop/query-rewriting retrieval · relevance feedback loop ·
multi-corpus/tenant separation.