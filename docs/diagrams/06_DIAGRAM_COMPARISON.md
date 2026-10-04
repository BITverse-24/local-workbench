# 06 — Diagram Comparison and Recommendation

Rendering check: `mmdc`/Mermaid CLI is not installed in this environment and no rendering dependency was added
(per task constraints), so SVG/PNG rendering was **not verified**. All six diagrams use plain `flowchart TB`,
8–10 short-label nodes, max one subgraph, and dashed optional edges to minimise render risk; paste each fenced
block into the Mermaid live editor or the slide plugin to confirm fit at ~830 px before freezing the PPT.

## Scores (1–10, higher is better)

| Criterion | A Component | B Exec flow | C Security | D Data flow | E Minimal |
|---|:---:|:---:|:---:|:---:|:---:|
| Architectural accuracy | 9 | 9 | 10 | 8 | 8 |
| Information completeness | 9 | 8 | 7 | 8 | 6 |
| Immediate comprehensibility | 7 | 7 | 7 | 8 | 10 |
| Readability at 830 px (est.) | 7 | 7 | 7 | 8 | 10 |
| Technical differentiation | 8 | 9 | 8 | 8 | 9 |
| Stands alone w/o presenter | 8 | 7 | 7 | 8 | 9 |
| **Total** | **48** | **47** | **46** | **48** | **52** |

Notes: scores are editorial judgement against the stated PPT use (right-half, ~1.2:1, complements left-half text,
no presenter). Accuracy deductions: A loses one point for merging the two gates; D loses for merging extract/compute/
deliver; E loses for collapsing the shell/IPC and guard internals (deliberate, disclosed in-file).

## Recommendation

- **Use Candidate E (`05_MINIMAL_ARCHITECTURE.md`) on the slide.** 8 nodes, top-to-bottom, no nesting, dashed optional
  RAG, no three-model cluster implication, and the two genuinely distinctive claims (guarded workspace tools; verify +
  human approve before final) survive at 30-second reading distance. It complements rather than duplicates the left-half
  text, which already covers the agent loop in words.
- **Runner-up for technical detail: Candidate A.** If the panel rewards component completeness over glanceability,
  A carries shell, orchestrator, model, tools, gate, RAG, storage, and artifacts in 10 nodes. Pair it with the left-half
  loop description and drop B to avoid repeating the turn-by-turn story.
- **Do not put B alone on the slide.** It is the most honest depiction of the 100-turn loop with upfront + per-turn gates,
  but its feedback edges tangle fastest at 830 px and it needs the component context from A/E to stand alone.
- **C and D are supplements, not slide candidates.** C is the correct security-scope figure for documentation or appendix
  (it is the only one that labels air-gap as deployment-conditional and isolation as Linux-only). D is the best provenance
  figure for an evidence/audit narrative. Link both in public docs; keep them out of the crowded slide.
