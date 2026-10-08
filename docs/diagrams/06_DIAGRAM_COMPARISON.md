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

## Recommendation (revised per review — supersedes v1)

- **Use revised Candidate A (`01_COMPONENT_ARCHITECTURE.md`) on the slide.** The v2 revision fixes the four
  accepted criticisms: enclosing workstation subgraph, `results return` feedback edge, gate on the guarded-action
  path (authorise-before-execute, verify-after), persistence as side branch. A decomposes the actual software
  (operator/UI, IPC bridge, orchestrator, inference, tools, gate, persistence) instead of collapsing it into a
  pipeline, and it rewards both first-glance and close reading in an asynchronous evaluation. The initial E
  recommendation over-weighted 30-second glanceability for a live pitch; this submission has no presenter and is
  already spending two Technical Approach sections on the diagram space.
- **Runner-up: Candidate E.** Keep as the solution-overview figure (docs, blog) where glanceability matters most.
- **B is reserved** (duplicates the slide's existing AGENT EXECUTION LOOP text; save for the technical blog),
  **C is the appendix/security-scope figure** (model now drawn inside the boundary), **D suits Slides 2/5-adjacent
  workflow storytelling**, not the Technical Approach component slot.
