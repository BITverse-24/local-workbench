# Sovereign Workbench V0 — MVP Ship Framework

## Purpose

This document defines the **Version 0 (V0) shipping criteria** for Sovereign Workbench.

V0 is not intended to prove that a small local model can complete every task perfectly or deterministically.

The V0 objective is:

> **Ship a safe, useful, honest, repeatable-enough local agent MVP that can complete representative multi-step work with acceptable reliability and can be iterated upon after release.**

The harness and the model must be evaluated differently.

- The **harness** is expected to behave deterministically with respect to safety, authorization, persistence, execution integrity, artifact truthfulness, and failure handling.
- The **model** is inherently probabilistic. Its task-completion quality must therefore be evaluated statistically and with thresholds appropriate to the specific model.

The initial V0 reference models are:

- **Qwen2.5 Coder 7B**
- **Qwen3.5 9B**

Qwen2.5 Coder 7B is the primary V0 shipping target.  
Qwen3.5 9B is evaluated against a somewhat higher semantic-quality threshold while being allowed higher latency.

---

# 1. V0 Supported Capability Families

V0 officially supports the following capability families.

| Capability Family | V0 Expectation |
|---|---|
| Chat / analysis | Read supplied information and provide grounded answers |
| Grounded document work | Read sources and available knowledge, then produce a useful DOCX/Markdown deliverable |
| Code modification | Modify an attached program, execute it on real supplied input, and return working source |
| Grounded inspection | Inspect document/drawing evidence against retrieved requirements and report grounded findings |

Visual fallback is supported as an **input capability**, not as a separate headline workflow.

The following are explicitly outside the minimum V0 claim:

- broad autonomous planning
- perfect arbitrary document understanding
- general-purpose structured-data primitives
- heavyweight multi-step orchestration
- production-grade semantic verification
- perfect recovery from every model mistake
- universal multi-model routing

---

# 2. Evaluation Model

V0 evaluation is split into two distinct layers:

1. **Harness correctness**
2. **Model task quality**

These must not be conflated.

---

# 3. Layer A — Harness Correctness

Harness correctness uses **hard gates**.

The model receives no allowance for failures in these areas.

V0 must not knowingly ship with violations of the following invariants:

- Unauthorized mutations cannot occur.
- Chat and Agent authority boundaries are enforced by the backend.
- Truncated executable model output fails closed.
- Tool errors remain real errors.
- No fabricated fallback result may replace a failed model or tool call.
- A requested artifact must actually exist before the run claims it exists.
- Generated artifacts must pass supported structural validation.
- Intermediate results must persist correctly.
- Result and artifact references must remain truthful across execution and recovery.
- Uncertain mutations must not be blindly replayed.
- The original RunContract must remain authoritative across recovery.
- No Flow A/B/C identifiers may be used as active runtime routing logic.
- No fixture-specific filenames, expected values, findings, measurements, or conclusions may be hardcoded into production runtime behavior.
- No fake benchmark outputs may be used.
- Build and type checking must pass.
- New V0 regression tests must pass.

## Harness expectation

**Target: effectively 100%**

A harness failure is more serious than a model-quality failure.

---

# 4. Layer B — Model Task Quality

A model run is classified into one of four outcomes.

## PASS

The user's primary objective was achieved.

The result or artifact is useful, materially correct, and sufficiently grounded for the requested task.

Minor omissions, wording differences, or formatting differences are allowed.

Examples:

- A requested report is produced and contains the important findings and decisions.
- A repaired program executes successfully and satisfies the core requested behavior.
- A grounded inspection correctly identifies the major non-compliance findings.

## PARTIAL

Useful work was produced, but one significant requested requirement was omitted or incorrect.

Examples:

- A mostly correct report omits one important source instruction.
- An inspection gets the core conclusion right but misses one relevant identifier.
- A deliverable exists and is useful but is incomplete.

A PARTIAL result is **not equivalent to a total failure**.

## FAIL

The user's primary objective was not achieved.

Examples:

- Requested artifact was never produced.
- Repaired program still crashes.
- Core inspection conclusion is wrong.
- Final response is unusable.
- Required execution never successfully completes.

## HARNESS FAILURE

The infrastructure malfunctioned independently of the model's semantic quality.

Examples:

- A valid tool proposal cannot be dispatched because of transport bugs.
- A repeated-tool-call deadlock prevents completion.
- The runtime claims an artifact exists when it does not.
- Authorization boundaries are violated.
- Run state is materially incorrect.
- Persistence or recovery logic loses valid completed work.

HARNESS FAILURE is a V0-blocking category.

---

# 5. Requirement Severity

Evaluators must distinguish between **critical**, **major**, and **minor** requirements.

Not every evaluator mismatch should fail the whole task.

## Critical

Failure means the task fundamentally failed.

Examples:

- Requested artifact does not exist.
- Modified program does not execute.
- Core business/compliance conclusion is materially wrong.
- Evidence is fabricated.
- Unsafe or unauthorized behavior occurs.

## Major

Failure meaningfully reduces usefulness but does not necessarily invalidate the entire task.

Examples:

- One important source finding is omitted.
- A required identifier is omitted where traceability matters.
- A requested corrective action is missing.
- A major instruction from the source is not carried into the result.

## Minor

Failure does not materially prevent use.

Examples:

- Table versus numbered-list formatting.
- `change` versus `replace`.
- Citation appears on a different line.
- Different heading or layout structure.
- Exact evaluator regex wording is not matched.

## Evaluation rule

V0 must not classify a useful run as a total failure solely because of minor wording or presentation differences.

Existing strict evaluators may remain as diagnostics, but V0 ship scoring must use requirement severity.

---

# 6. V0 Evaluation Suite

The V0 semantic-quality suite contains **9 representative tasks**.

The suite must include both known regression flows and unrelated tasks to detect benchmark overfitting.

## Document work — 3 tasks

1. Flow A
2. One paraphrased A-style task
3. One unrelated grounded-document task

## Code modification — 3 tasks

1. Flow B
2. One paraphrased B-style repair task
3. One unrelated small Python repair task

## Grounded inspection — 3 tasks

1. Flow C
2. One paraphrased C-style inspection task
3. One unrelated drawing/document compliance task

The unrelated task in each capability family is mandatory.

It serves as a lightweight hardcoding/generalization check.

---

# 7. Qwen2.5 Coder 7B — V0 Certification

Qwen2.5 Coder 7B is the **reference V0 shipping model**.

It is small, fast, non-reasoning, and suitable for the target local environment.

## Semantic reliability gate

To certify V0 on Qwen2.5 Coder 7B:

- At least **6/9 PASS**
- At least **2/3 PASS in each capability family**
- Remaining runs may be PARTIAL
- Preferably no more than **1–2 outright FAIL**
- **0 HARNESS FAILURES**

This corresponds to approximately **67% or better full useful completion** across representative multi-step tasks.

Perfect first-shot success is not required.

## Recovery

The final task outcome is the primary metric.

Allowed:

- initial work turn
- normal tool execution
- up to **2 bounded corrective/recovery turns** when genuinely useful

First-shot success should still be recorded as a separate metric.

It is not a V0 shipping gate.

## Latency

For Qwen2.5 Coder 7B:

- **Target:** under 90 seconds
- **Acceptable V0:** under 120 seconds for normal A/B/C-class work
- An occasional recovered task up to approximately 150 seconds may be tolerated during evaluation

Latency optimization is not a priority while successful-run latency remains within this range.

A 75-second PASS is better than a 25-second PARTIAL.

---

# 8. Qwen3.5 9B — V0 Certification

Qwen3.5 9B is evaluated separately.

Because it is larger and reasoning-heavy in the current environment, it is expected to provide somewhat stronger semantic quality while being allowed additional latency.

## Semantic reliability gate

To certify Qwen3.5 9B:

- At least **7/9 PASS**
- At least **2/3 PASS in each capability family**
- Preferably no outright FAIL
- **0 HARNESS FAILURES**
- Higher expectation for completeness and grounding than Qwen2.5 Coder 7B

## Recovery

Up to **2 bounded corrective/recovery turns** are allowed.

## Latency

For Qwen3.5 9B:

- **Target:** under 150 seconds
- **Acceptable V0:** approximately 180 seconds for representative workflows

Higher latency is acceptable when it produces meaningfully better semantic quality.

## Shipping dependency

**Qwen3.5 9B certification does not block V0 shipping.**

If Qwen2.5 Coder 7B passes its V0 certification and Qwen3.5 9B does not, ship Qwen2.5 Coder 7B as the supported/reference model configuration and treat Qwen3.5 9B as experimental until stabilized.

---

# 9. Vision / Visual Fallback Gate

Visual fallback receives a small smoke-test gate.

Required scenarios:

1. Image-only PDF → successful meaningful visual extraction
2. Raster image → meaningful visual extraction
3. SVG/image geometry without useful text → visual fallback succeeds

## Requirement

**3/3 smoke scenarios must pass.**

This proves that the visual capability exists and is correctly integrated.

It does not claim perfect interpretation of every scanned document or engineering drawing.

---

# 10. Recorded Demo Criteria

The recorded demo has different criteria from statistical model certification.

The demo must show genuine successful executions.

It does not need to prove deterministic success on every stochastic run.

## Flow A demo

At least one genuine run where:

- real source PDFs are processed
- real knowledge retrieval occurs
- a useful grounded report is produced
- the requested DOCX is actually generated
- the artifact opens and validates

## Flow B demo

At least one genuine run where:

- the real provided source is modified
- the real supplied input CSV is used
- the modified program executes successfully
- the repaired source artifact is genuine

## Flow C demo

At least one genuine run where:

- the real drawing is inspected
- real knowledge retrieval occurs
- the core mismatches are correctly identified
- the final response is grounded and useful

## Demo integrity requirements

The demo must not use:

- hardcoded outputs
- manually edited final artifacts
- fixture-specific result substitution
- fake tool results
- hidden benchmark-only runtime branches

It is acceptable to record a successful genuine stochastic run.

---

# 11. V0 Shipping Dashboard

The project should be evaluated using the following dashboard.

| Gate | Qwen2.5 Coder 7B | Qwen3.5 9B |
|---|---:|---:|
| Harness critical invariants | **100%** | **100%** |
| 9-task full PASS | **≥6/9** | **≥7/9** |
| Minimum per capability family | **2/3** | **2/3** |
| Harness failures | **0** | **0** |
| Recovery turns allowed | ≤2 | ≤2 |
| Normal latency | ≤120s | ≤180s |
| Vision smoke | 3/3 where applicable | 3/3 where applicable |
| Required for initial V0 ship | **YES** | NO |

## Demo readiness

Track separately:

- Flow A authentic successful recording: ☐
- Flow B authentic successful recording: ☐
- Flow C authentic successful recording: ☐

---

# 12. What Does NOT Block V0

The following are explicitly **not V0 requirements**:

- 18/18 benchmark success
- 100% first-shot success
- identical outputs across paraphrases
- sub-30-second execution
- exactly two model calls
- perfect intent classification
- perfect arbitrary document extraction
- universal semantic correctness verification
- P2 structured-data primitives
- Laya/Jev-style routing
- automatic multi-model selection
- every strict evaluator regex passing
- every source fact appearing in every answer
- production-grade tail latency
- production-grade generality
- broad autonomous planning
- a heavyweight multi-agent framework

These belong to later iterations.

---

# 13. Development Prioritization Rule

From this point onward, every proposed code or architecture change must answer:

> **Which failing V0 gate does this change improve?**

If the answer is unclear, the change should not be implemented before V0 ships.

Examples:

- Qwen2.5 takes 95 seconds but passes → **do nothing**
- Flow B repaired code still crashes → **V0-relevant; fix**
- Flow C says `change` instead of `replace` → **minor evaluator wording issue; do nothing**
- Harness falsely reports completion after failed execution → **critical V0 issue; fix immediately**
- Laya/Jev router proposed without evidence routing blocks certification → **post-V0**
- P2-A structured operations → **post-V0**
- Another broad latency study → **post-V0**
- Minor formatting inconsistency → **post-V0 unless it materially affects usability**

---

# 14. V0 Development Order

Work should proceed in this order:

1. Fix any remaining **HARNESS FAILURE** conditions.
2. Build/finalize the 9-task V0 evaluation suite.
3. Run the suite on Qwen2.5 Coder 7B.
4. Classify each result as PASS / PARTIAL / FAIL / HARNESS FAILURE.
5. Fix only the highest-impact general failures preventing the Qwen2.5 certification threshold.
6. Re-run the affected V0 suite.
7. Once Qwen2.5 reaches:
   - ≥6/9 PASS
   - ≥2/3 PASS in every family
   - 0 harness failures
   - acceptable latency
   freeze the runtime.
8. Capture one authentic successful recording for Flow A, B and C.
9. Ship V0.
10. Evaluate Qwen3.5 9B separately without blocking release.

---

# 15. V0 Product Claim

The V0 claim should be:

> **Sovereign Workbench is a local-first agentic AI harness that enables small locally hosted models to perform useful multi-step workstation and knowledge-work tasks through durable state, real tools, grounded evidence, controlled execution, recovery, artifact generation, and trustworthy failure handling.**

V0 does **not** claim that a 7B local model is infallible.

The core product value is that the surrounding harness makes small models substantially more operationally capable while preserving local execution, user control, evidence, safety, and truthful outcomes.

---

# 16. Definition of Done

Sovereign Workbench V0 is ready to ship when all of the following are true:

- Harness critical invariants pass.
- Build and typecheck pass.
- New V0 regression tests pass.
- Qwen2.5 Coder 7B achieves at least **6/9 PASS**.
- Qwen2.5 Coder 7B achieves at least **2/3 PASS in each capability family**.
- There are **0 harness failures** in the certification suite.
- Representative successful-run latency is acceptable for V0.
- Visual fallback smoke tests pass.
- One genuine successful Flow A demo has been recorded.
- One genuine successful Flow B demo has been recorded.
- One genuine successful Flow C demo has been recorded.
- No fixture-specific production hardcoding is required for those successful runs.

Once these conditions are met:

> **Freeze V0 and ship.**

Everything else becomes V0.1, V0.2, or P2 work.
