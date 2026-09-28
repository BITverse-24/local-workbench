# PPT.md — Slide Content & Layout Specification
## SIH 2026 Idea Presentation — "Sovereign Workbench"

> **Status: PHASE 1 — content, argument, layout. No design work started.**
> Awaiting approval before any Canva/template implementation.
>
> **Structure:** the SIH template's 5 authored slides. Slide 1 (team details) is manual entry
> per the template. Sections A–F carry the reasoning; **Section G is the build sheet.**
>
> **Framing correction applied in this revision:** a SIH idea submission is judged on a
> **partially complete prototype plus a credible path to the final product** — not on a finished
> product. Every slide now distinguishes **shipped** (built and verified in the repository) from
> **next** (on the roadmap). That distinction is load-bearing: it is what makes the pitch credible
> to a technical panel instead of reading as overclaiming. See Section E.2 for the shipped/next
> inventory.
>
> **Supporting artefact:** the technical blog (installation, public GitHub codebase, technical
> architecture, benchmarks, roadmap) is the place where depth lives. The deck carries the argument;
> the blog carries the proof. Every "see the technical blog" reference on a slide must point at a
> real, published section.
>
> `[[...]]` = a placeholder the team MUST resolve with a real, verified value. Never ship a
> placeholder; never substitute an estimate.
>
> ✅ verified in the repository · ⚠️ needs team confirmation · ❌ do not claim

---

# PART I — STRATEGY (approve before design)

## A. Executive narrative

### A.1 The product: a T-shaped workbench

**Sovereign Workbench is T-shaped, and the T is asymmetric on purpose.**

- **The horizontal bar — a generalist floor that is genuinely good, never merely adequate.** Across
  the task types an engineering organisation actually brings, the workbench returns a result you
  can act on. Not expert-grade in every domain — but **never a refusal, never a hallucination, never
  a shrug.** The bar's job is to be *dependable*, and dependability is a harder thing to build than
  peak quality. It holds because every request is dispatched to a real specialist model by a
  deterministic router, and because a general path always exists when a specialist does not fit.
- **The vertical stem — deep, in one place: regulated, non-coding, document-centred engineering
  work.** Inspection reports, engineering drawings, vendor data, approval notes, and the SOPs and
  standards they are judged against. Here the workbench does what general tools will not: bind
  every conclusion to a source and a clause, gate every consequential action, and **withhold
  approval when the evidence does not support one.**

### A.2 The insight: coding harnesses got strong because of *skills* — and nobody has built them for this work

**Look at why coding agents actually became good.** Not because the underlying model got smarter,
and not because the harness got cleverer. Coding agents got strong because someone wrote
**skills** — reusable, named, domain-specific procedures that encode what an expert actually does.
Read a file before editing it. Run the tests before claiming success. Search for the symbol before
assuming it does not exist. Each skill is a small piece of *engineering procedure*, and the harness
got good the moment the procedure library got rich.

**That is the transferable insight, and it is the shape of the T.**

Skills are what make a generalist model *good* at a domain. They are also what make an agent loop
*reliable*: a skill can require the loop to do something — fetch the governing clause before
concluding, execute the script before reporting it works, refuse to issue a recommendation when a
field item is unresolved — and then that requirement becomes enforceable rather than aspirational.

**Nobody has built a serious skill library for regulated, non-coding engineering work.** The
commercial products in that space are closed, vertically integrated platforms that ship extraction
and review for a customer they already have. There is no open, portable, extensible set of domain
skills for inspection review, drawing compliance, vendor-data reconciliation or approval drafting
— the way `skills.sh` and the coding-harness ecosystem exist for software work.

**So the T resolves cleanly:**

- **The bar is the runtime plus the generalist skills** — the ones that apply everywhere: read the
  document, find the reference, compute the check, show the working, produce the file, say when you
  are not sure. These are what make breadth *good* rather than surface-level, and they are exactly
  what the existing coding-harness pattern already taught the industry to build.
- **The stem is the specialist skill library** — the domain procedures that a generalist model
  cannot be trusted to improvise, because getting them wrong has physical consequences. Written once,
  reusable across every plant, every SOP set, every document class.

**The two halves reinforce each other, and that is the real product.** A skill written for
inspection review is immediately reusable on a drawing audit, because both are *"extract the
evidence, retrieve the governing clause, compare, decide, and refuse if the evidence is
incomplete."* The generalist runtime plus a growing library is what turns a demo into a platform
that a plant can extend without us.

**The one sentence an evaluator must leave with:** *Coding agents got good because someone wrote
skills for the domain. We are writing the skills for regulated engineering work — open,
extensible, and running entirely inside the customer's perimeter.*

### A.3 Why OSS is the wedge, not a footnote

The commercial tools in this vertical are closed platforms sold to enterprises that already
committed. Their business model is *integration and support*, which means the skills are welded
into the product and cannot be shared, forked, or verified by a third party.

**Open-sourcing the skill library inverts that.** A plant can inspect exactly what the system knows
how to do, audit it, extend it with their own procedures, and run it on their own hardware without a
licensing negotiation. For a defence-adjacent or PSU buyer, **an auditable, forkable, self-hosted
capability base is not a consolation prize — it is the procurement requirement.** Open source is
what makes the sovereignty claim credible: you cannot audit what you cannot read.

**The wedge, stated precisely:** we are not building a cheaper commercial platform. We are building
the **open, portable skill layer** that a regulated engineering organisation can own, audit, and
extend — and the runtime that makes those skills executable by an agent.

### A.4 Why this survives a sceptical panel

- The vertical is **not** empty, and the deck must never imply it is. Four commercial platforms
  operate there. Claiming otherwise is caught immediately.
- What they do not offer is **portable, inspectable, community-extensible domain skills** combined
  with a **perimeter constraint**. They ship their own skills, welded shut, for a customer they
  already have.
- The deck's position is therefore **not** "the space is empty" but **"the open, auditable skill
  layer is unbuilt"** — see the positioning map, Section G, Slide 2.

---

## B. Content audit — what happens to the existing material

| # | Verdict | Item | Action |
|---|---|---|---|
| 1 | 🔀 **Reframe** | Whole USP | Reframed from "local + multi-model + agentic" to **T-shape + the missing-skill-library thesis**, with OSS as the wedge. |
| 2 | ✅ **Promote to headline** | The capability-driven tool surface | ✅ Verified: `router/tool-compositor.ts:27` composes the tool set from runtime environment. **This is the skill architecture already in the codebase** — currently described as "tool surface composition", which undersells it. Reframe as a **skill runtime**. |
| 3 | ✅ **Promote to headline** | Specialised tools in `tools/specialist-tools.ts` | ✅ Verified: `extract_document`, `generate_code`, `generate_text`, `retrieve_knowledge`, `execute_python`, `generate_deliverable`. **This is the first tier of the skill library.** It exists and is currently invisible in the pitch. |
| 4 | ✅ **Promote to headline** | `grounding/` module | ✅ Verified: `sop114-engine.ts`, `spec-compliance.ts`, `rag-grounding-provider.ts`. These are **domain skills in embryo** and are the direct evidence that the vertical is buildable. |
| 5 | 🆕 **New** | Explicit skill-library concept and roadmap | The core new content. Currently the codebase has the *substrate* but the pitch never names what it is. |
| 6 | 🆕 **New** | OSS positioning | The wedge against closed platforms. Absent from all current material. |
| 7 | ⚠️ **Fix before use** | `sop114-engine.ts` is named for one specific SOP | ⚠️ A skill library hardcoded to one SOP is a contradiction of the whole thesis, and violates the repo's own "no hardcoded demo data" rule. **Either generalise the skill to take its clause set as input, or present the naming honestly as "the first skill in the library, currently specialised to one standard."** Flagged as a **must-fix before Phase 2.** |
| 8 | ✅ **Promote** | Explicit `NOT APPROVED` / sign-off-withheld output | Verified in code (`spec-compliance.ts:634`, `manager.ts:1521-1532`). Now framed as a **skill-enforced rule**, not a demo detail. |
| 9 | ✅ **Promote** | Authorisation gate | Verified. Reframed as a **skill-enforced precondition** — the code, not the prompt, is what enforces it. |
| 10 | ✅ **Promote** | Clause citation | Verified. Framed as the *retrieval skill* that makes every other skill auditable. |
| 11 | ✅ **Keep** | Deterministic routing | Verified (`intent-classifier.ts` — rule-based). Repositioned: breadth is affordable *because* routing is cheap and inspectable. |
| 12 | ✅ **Keep, upgraded** | Native tool calling | Verified (`model-gateway.ts:1333-1400` sends a real `tools` array, `tool_choice: "auto"`, with prompt-schema fallback at `:1533`). **This is the substrate skills run on** — worth stating as the enabling mechanism. |
| 13 | ⚠️ **Correct** | "ChromaDB" | **`chromadb` is not a dependency.** `ai/rag/db.ts` imports `LocalIndex` from `vectra`. Say "embedded local vector index (Vectra)" or add ChromaDB. |
| 14 | ⚠️ **Qualify** | "Sandboxed execution" | `run-command.ts:44-52` **falls back to direct shell execution** on macOS, Windows and Linux without `bwrap`. State Linux-namespaced isolation, not universal sandboxing. |
| 15 | 🔀 **Consolidate** | Flows A/B/C across ~250 playbook lines | One triptych. Three workflows are one argument — *the pattern is general* — told three times. |
| 16 | ❌ **Cut** | "nothing deployable exists today for industrial users" | Contradicted by well-known tooling. Cut. |
| 17 | ❌ **Cut** | "the only one that proves model auto-routing and zero egress" | Unfalsifiable superlative. |
| 18 | ❌ **Cut** | GCP credits, "Advanced Coding Agents", glossary, component boundary tables | Internal hygiene, or irrelevant — the pitch is that no cloud resource is needed. |

---

## C. Weak and generic claims — verbatim audit

| Claim | Problem | Rewrite |
|---|---|---|
| "the only one that proves…" | Unfalsifiable superlative | "Routing and containment are conventionally *asserted*. Here both are instrumented and independently observable." |
| "nothing deployable exists today" | Factually wrong | Delete. |
| *(implied)* "no one builds this for enterprise non-coding work" | **Contradicted — four active vendors** | "Closed platforms extract and review documents for enterprises they already serve. The **open, portable, auditable skill layer** they are built on does not exist." |
| "the horizontal bar is broad, surface-level capability" | Invites *"so you're mediocre at most things"* | "The bar is a **generalist floor with real domain skills behind it** — dependable across task types because a specialist model and a reusable procedure exist for each, never a refusal." |
| "the system is secure" | Never established; isolation is Linux-only | "All inference, indexing and artefact generation execute within the organisation's perimeter; model-authored code runs under OS network namespace isolation on Linux." |
| "autonomous agent" | Red flag for a safety audience | **"Supervised agentic execution — the system proposes, the operator authorises."** |
| "publication-grade", "highly optimised", any speed/accuracy claim | No benchmark in the repo | ❌ Do not claim. Use verified engineering limits: bounded iterations, read/output size caps, wall-clock timeout. |
| "AI-powered", "seamless", "next-generation" | Generic AI marketing | ❌ Banned. Replace with a mechanism or delete. |
| "hallucination-free" | Undefensible absolute | "Conclusions are traceable to a named source, document and clause." |
| "open source" as a value statement | Meaningless unless contrasted | ❌ Never on its own. Always: **"open, so a plant can audit the skills and extend them with its own procedures."** |

---

## D. Critical gaps

**Gap 1 — The skill library is a thesis without a demonstrated skill. (Critical.)**
The whole pitch now rests on specialist skills existing and working. The codebase has the
*substrate* (`composeTools`, `specialist-tools.ts`, `grounding/`) and two reference workflows, but
**no skill is presented as a named, inspectable, reusable artefact.** *Needed:* present at least
one skill the way a coding harness presents one — named, with a defined input, a defined procedure,
a defined output, and a defined rule about when it must refuse. That artefact is the single most
convincing thing the deck can show, and it does not currently exist at slide level.

**Gap 2 — The library's growth model is unstated. (Critical.)**
"Open skill library" implies others contribute. Nothing in the repo describes a skill format, a
contribution path, or what makes a skill acceptable. *Needed:* state the shape of a skill
(declared capability + fixed schema + explicit refusal conditions), say the format is
configuration-and-code rather than prompt-tuning, and **do not claim a community exists.** A
hackathon submission can credibly say "designed to be extensible"; it cannot say "the community
will extend it."

**Gap 3 — `sop114-engine.ts` hardcodes one standard. (Critical — team has committed to fixing.)**
See audit item 13. ✅ **RESOLVED AS A COMMITMENT:** the team confirms the hardcoded standard is
being removed. This directly undercuts the skill-library thesis if an evaluator opens the repo, so
it stays on the pre-finals checklist as a **must-complete item**, not a nice-to-have. *Needed:*
generalise the skill to accept its clause set as input. Until it lands, the slide must state the
specialisation honestly — see the "shipped / next" split in Section E.2.

**Gap 4 — "Enterprise non-coding work" is too broad to be a vertical. (Critical.)**
*Needed:* name the first vertical precisely — **regulated industrial engineering documentation:
inspection reports, drawings, vendor data, approval notes, judged against internal SOPs and
standards.** The codebase supports exactly this, so precision costs nothing.

**Gap 5 — No outcome data. (Critical.)** Not one measured number exists in the repo. ⚠️ **Do not
fabricate.** Make measurement part of the proposal: state the method, mark results `[[MEASURE: …]]`.

**Gap 6 — No cost model. (Critical.)** *Needed:* open-source zero licence, runs on owned hardware,
pilot needs one GPU workstation. Mark formal figures `[[VERIFY: …]]` or omit.

**Gap 7 — Competitive framing must not become "cheaper and open-source". (High.)**
Evaluators have heard OSS positioning before and default to "not commercial". *Needed:* the wedge is
**auditability under a procurement constraint**, not price. A PSU cannot accept a closed tool it
cannot inspect for a process that touches pressure-equipment sign-off.

**Gap 8 — Model quality envelope unstated. (High.)** The registry runs 3B–8B class models.
*Needed:* state the task classes these sizes target, and that reliability is validated per
deployment. **Concede the capability gap explicitly** — it buys credibility, and it is true.

**Gap 9 — Platform support ambiguous. (High.)** Namespace isolation is Linux-only with a
direct-shell fallback. State it plainly.

**Gap 10 — Licence / supply chain absent. (High.)** ⚠️ Verify per family — licences differ. *Needed:*
one line on licence review before a model enters the registry, plus the existing provenance story
(checksummed weights transferred before disconnect). Note the *project's own* licence should also be
stated explicitly on the references slide.

**Gap 11 — "5 machines vs 1 workstation" unreconciled. (High.)** Resolve openly on Slide 4.

**Gap 12 — No failure-mode story. (Medium.)** The gateway counts external requests separately from
local ones (`model-gateway.ts:950-953`) and the loop halts on an unreachable host rather than
falling back to cloud. **Promote "no silent cloud fallback" to an explicit design commitment.**

**Gap 13 — No practitioner validation. (Medium.)** ⚠️ Do not imply otherwise. Even three honest,
labelled conversations would materially strengthen Slides 2 and 5.

---

## E.2 Build status — shipped vs next *(applies across Slides 3, 4 and 5)*

**Why this section exists.** A SIH idea submission is assessed on a working prototype plus a
credible path to the final product. Stating what is built and what is next is therefore not
hedging — it is the *correct* register for this stage, and it is what a technical panel most
values. Overclaiming is the single most avoidable mistake available to us: a reviewer who opens the
public repository and finds a claim the deck did not make costs us far more than admitting an
unfinished edge.

**The rule for every slide:** anything in the left column may be stated in the present tense.
Anything in the right column must be stated as planned, with the current limitation named.

### ✅ Shipped — built and verified in the repository

| Capability | Evidence in the repository | Shown on |
|---|---|---|
| Electron desktop shell with a narrow, typed IPC boundary | `electron/main.ts`, `electron/preload.ts` — renderer receives no filesystem or model access | Slide 3, Block 5 |
| Local multi-model registry, four roles bound to OpenAI-compatible endpoints | ✅ `config/models.json` — inspectable artefact | Slide 3, Block 1 |
| Deterministic task router — rule-based, recorded, inspectable | ✅ `router/intent-classifier.ts` | Slide 3, Block 1 |
| Native tool calling with schema fallback across runtimes | ✅ `gateway/model-gateway.ts:1333-1400`, fallback at `:1533` | Slide 3, Block 1 |
| Capability-composed tool surface (the skill runtime substrate) | ✅ `router/tool-compositor.ts:27` | Slide 3, Block 1 |
| Agent loop with streamed plan, tool transcript and confirmation gate | ✅ `agent/agent-loop.ts`, `confirmation/` | Slide 3, Block 2 |
| Six specialist capabilities as executable code | ✅ `extract_document`, `retrieve_knowledge`, `generate_deliverable`, `execute_python` + 2 more in `tools/specialist-tools.ts` | Slide 3, Block 2 |
| Path containment on every workspace operation | ✅ `harness/path-guard.ts` — enforced, tested | Slide 3, Block 5 |
| Local vector index for standards retrieval | ✅ `ai/rag/` — embedded, Vectra | Slide 3, Block 5 |
| Linux network-namespace isolation for model-authored code | ✅ `harness/tools/run-command.ts` | Slide 3, Block 3 |
| External-request counter separating local from external calls | ✅ `gateway/model-gateway.ts:950-953` | Slide 3, Block 3 |
| Document and deliverable generation (Word, Excel, PDF) | ✅ `docx-generator`, `artifacts.ts` | Slide 3, Block 4 |
| Deterministic fixtures with machine-checkable expected outcomes | ✅ `demo/flow_a\|flow_b\|flow_c` — 12 oracle files; a preflight validator checks them | Slide 3, Block 4 |
| Automated test suite across agent loop, routing, path guard, retrieval, flows | ✅ **42 test suites**, including end-to-end flow tests | Slide 5, Tier 2 |
| Guided onboarding wizard — bind a device with host, port, model name; live health probe | ✅ `ipc/onboarding-handlers.ts:42-75` — probes `/v1/models`, falls back to `/models`, reports latency and available models, persists without restart | Slide 4, Block 1 |
| Runtime-agnostic model interface with schema fallback | ✅ `shared/contracts.ts:2` targets `mlx-lm` / `llama-server` / `ollama`; `gateway/model-gateway.ts:1533` | Slide 3, Block 1 |
| Public repository | ✅ `github.com/BITverse-24/agent` | Slide 6 |

### 🔜 Next — on the roadmap, stated as planned

| Planned work | Why it matters | Priority |
|---|---|---|
| **Generalise the grounding skills to accept any clause set** | Removes the last hardcoded standard and completes the skill-library thesis. *Team has committed to this.* | **Must ship before finals** |
| Extend the skill library beyond the two reference skills | A skill written for inspection review is reusable on a drawing audit — the stem's value is library depth | High |
| Windows and macOS isolation parity | Namespace isolation is Linux-specific today; a weaker direct-shell fallback exists elsewhere | High |
| Additional document classes and standards | Directly widens the vertical, through skills rather than code | Medium |
| Multi-user, role-based access | Required for real plant deployment; explicitly out of scope today | Medium |
| Practitioner validation and a pilot | The single largest credibility gain available to the project | Medium |
| Outcome measurement (time-on-task, extraction accuracy) | Currently unmeasured; method is defined, results pending | Medium |

**How this appears on a slide — three rules:**
1. **Never present a roadmap item in the present tense.** "The library ships with two skills and is
   designed to extend" is honest; "the library extends to any document class" is not.
2. **Name the current limitation in the same breath as the plan.** "Namespace isolation is Linux-only
   today; Windows and macOS parity is next" — not "secure sandboxed execution" alone.
3. **Let the shipped column carry the weight.** That column is fifteen rows and every one is
   verifiable in a public repository. It is a stronger position than any roadmap, and the one an
   evaluator can actually check.

**The pitch in one line, for the close of Slide 4:** *the runtime, the routing, the containment and
the evidence trail are built and tested today; the library is what we grow next.*


---

## E. Narrative test

The template fixes 5 slides, so the argument is **compressed, not sequential**. The principle:
each slide carries one headline and a small number of labelled blocks, and every block earns its
place by advancing the argument. The narrative is carried by *headline + block ordering*.

| Slide | Beat | What it must do |
|---|---|---|
| 2 — Solution | Field → why skills are the mechanism → the gap → **insight** → the T → the product → uniqueness | Carry the whole argument. The insight block is the pivot; the T diagram is the memory hook. |
| 3 — Technical Approach | The skill runtime → the specialist library → sovereignty → evidence | Show the mechanism, and **show a real skill as a real artefact.** |
| 4 — Feasibility & Viability | Does it work, what breaks, what is honestly limited | Convert uncertainty into rigour. |
| 5 — Impact & Benefits | So what, measured how | Consequences, with measurement discipline stated openly. |
| 6 — Research & References | Grounding and credibility | Confirm the work is built on verified components and sits in a real research conversation. |
| 7 — Close (optional) | The one sentence | Ensure the thesis is what they remember. |

**Sequencing decisions:**
- **The competitive landscape goes at the *start* of the Solution slide** — here is the shape of
  the field, here is the occupied part, here is the gap. Naming competitors early buys permission to
  make the differentiation claim later.
- **The T diagram and the positioning map are on the same slide.** The map is the analytical version
  (where everyone sits); the T is the product version (what we built).
- **Slide 3 leads with the skill runtime, not the router.** The router is how the bar stays cheap;
  the skill runtime is what the stem is made of. The router is a supporting block, not the headline.

---

## F. Evaluator attack test

| # | The attack | Answered on | The answer |
|---|---|---|---|
| 1 | *"Novek, Pathnovo and LTTS already do engineering document AI."* | Sol. blocks 1–2 | They ship closed, vertically integrated platforms whose skills are welded into the product and sold to enterprises they already serve. We ship the **open, portable, auditable skill layer** and the runtime that executes it. |
| 2 | *"Open source is not a strategy — it's a discount."* | Sol. block 5, Feas. block 3 | The wedge is **auditability under a procurement constraint**, not price. A PSU cannot accept a closed tool it cannot inspect for a process that touches pressure-equipment sign-off. Open is the requirement. |
| 3 | *"Isn't a T-shape two half-products? Which is the real business?"* | Sol. block 4 | The stem is the product; the bar is what makes the stem usable as a daily tool. And the two are the same architecture — the stem's skills are what make the bar good, not a separate product. |
| 4 | *"Your model is 3B–8B. Frontier models are far stronger."* | Sol. block 4, Feas. block 3 | Conceded explicitly. Capability is bounded by what hardware policy permits. The value is that a sufficient-quality answer becomes *permissible* here — and auditable. No parity claim. |
| 5 | *"Code agents are solving this already — why not just use Codex?"* | Sol. block 3, Tech. block 2 | Because the skills are for a different domain, and that domain has no oracle to verify against. Swapping in a stronger model is a registry change; the skill library is the asset. |
| 6 | *"So your 'skills' are just prompts."* | Tech. blocks 1–2 | No. A skill is a declared capability with a fixed schema, composed into the tool surface by the environment, executed by the agent loop, and — critically — able to **enforce a rule the model would otherwise skip**, like refusing to conclude without a retrieved clause. That is code, not text. |
| 7 | *"Is the router an LLM? Who audits its decision?"* | Tech. block 1 | No — deterministic classification, inspectable and reproducible. The route determines which model touches sensitive data, so a rule is preferable to a softmax. |
| 8 | *"What if the model decides to send something out?"* | Tech. block 3 | It has no such tool. The tool surface is composed from declared capabilities; sandboxed code runs under an unshared network namespace; there is no network tool. |
| 9 | *"Your agent is autonomous. What stops it deleting production data?"* | Tech. block 2, Feas. block 2 | It is supervised. Every workspace operation is path-contained, consequential actions require explicit authorisation, runs are bounded by a fixed iteration cap. |
| 10 | *"It writes engineering approval notes. What if it's wrong?"* | Sol. block 6, Tech. block 4 | Decision support, not clearance. The skill **requires** a citation and **forbids** a recommendation when a verification gap is flagged. Its correct behaviour is to refuse — and frontier models are known to overcommit rather than abstain. |
| 11 | *"Five machines for a demo. PSUs don't have five spare boxes."* | Feas. block 1 | Two inference shapes, one configuration: single-device co-resident (the recommended pilot) and distributed across whatever mixed hardware the organisation already owns. Adding or replacing a device is **host, port, model name** — the same registry file either way. |
| 11a | *"Which runtimes does it actually support?"* | Feas. block 1, Ref. group 4 | Any server exposing an OpenAI-compatible `/v1` API — Ollama, LM Studio, llama.cpp, MLX, vLLM. The onboarding wizard probes `/v1/models`, falls back to `/models`, and persists the binding with no code change and no restart. *The evaluator should verify this one directly; it is the load-bearing claim behind "any device".* |
| 11b | *"If we buy a different GPU in two years, are we locked in?"* | Feas. block 1 | The contract is the HTTP interface, not a vendor. Because the join is three fields, hardware and models can change on the organisation's procurement cycle without touching the codebase. |
| 12 | *"Who maintains this as models change?"* | Tech. block 1, Feas. block 4 | Registry-driven: a new model is a config entry plus a health check, not a code change. Skills are model-agnostic and invoke through a stable interface. |
| 13 | *"What does this cost?"* | Feas. block 1 | Open source, zero licence, runs on owned hardware. Formal basis `[[VERIFY: …]]`. |
| 14 | *"What did you actually measure?"* | Tech. block 4, Impact | Three reference workflows verified end-to-end against deterministic oracles by an automated fixture validator, plus 42 test suites. Time and accuracy figures `[[MEASURE: …]]` — to be produced, not asserted. |
| 15 | *"What is this not good at?"* | Feas. block 3 | Stated before asked: single-user, English-only, Linux-namespaced isolation, coverage limited to indexed skills, no production hardening, capability bounded by hardware. |
| 16 | *"How do we know it didn't phone home?"* | Tech. block 3 | Three independent layers, the third held outside the application: registered internal endpoints only, no cloud SDK or telemetry, and an external capture showing zero external requests plus a blocked attempt. |
| 17 | *"Isn't 'we decline to answer' just a failure mode?"* | Tech. block 2 | No — the skill states the unmet condition and routes to a concrete recovery: clarify, bounded verification, or handoff. It is auditable, and it is the mechanism that replaces the missing test suite. |
| 18 | *"Who writes the skills besides you?"* | Sol. block 3, Tech. block 2 | Today, us — and the format is designed so a plant can add its own procedures against its own SOPs. **We are not claiming a community exists.** The extensibility is a design property, demonstrated by the library being capability-composed rather than hardcoded. |

---

# PART II — BUILD SHEET

## G. Slide-by-slide content and layout

### Global layout rules (all slides)

- **One takeaway headline per slide**, top-left, stating the *conclusion* — not the topic. Not
  "Technical Approach" but "Skills are code, not prompts — and they are what makes this reliable."
- **Fixed grid:** headline band (top ~12%) → labelled content blocks (left/main) → **one**
  dominant visual (right or full-width beneath) → footer (slide number + short project lockup).
- **One visual per slide.** Two visuals on a slide reads as zero visuals.
- **~40 words max of body text per block.** A block needing more is either two blocks or a table.
- **Banned:** gradients, glow, glassmorphism, neon, 3D objects, robot/brain imagery, icon confetti,
  rounded-card mosaics, stock photography, and the phrases "AI-powered", "seamless", "next-gen".
- **Build every diagram from native Canva shapes and connectors** so it stays editable.
- **Application screenshots are permitted and encouraged** — they are evidence. One per slide
  maximum, from a real run, high resolution, uncropped.
- **Blocks are labelled, not decorated:** a small caps label, then content.

---

### Slide 1 — Title & Team *(template: manual entry — do not automate)*

- **Content:** Project title, team name, three members with roles, institute.
- **Layout:** Use the template's existing title layout **unmodified**. Text entry only — no added
  shapes, no logo treatment, no colour beyond the template's own.

---

### Slide 2 — PROPOSED SOLUTION

*Template asks: idea/solution/prototype · how it addresses the problem · innovation and uniqueness.*

- **Purpose:** Carry the whole argument — field, mechanism, gap, insight, T, product, uniqueness —
  through block ordering rather than slide count.
- **Headline:** *"Coding agents got good because someone wrote skills. Nobody has written them for
  this work."*

**Blocks, in this order — the order is the argument:**

**Block 1 — The field, honestly stated.** *(The credibility block. A positioning map is correct
here — this is a genuine two-axis comparison.)*

Axes: **horizontal — is the capability portable and inspectable, or welded into one vendor's
platform? Vertical — does it produce a defensible position (clause-referenced, auditable,
willing to withhold), or just a fluent answer?**

| | Fluent answer, no proof-carrying output | Defensible position, auditable |
|---|---|---|
| **Welded into a closed platform** | — | **Commercial engineering-document platforms** — strong extraction and human-in-the-loop review, sold to enterprises they already serve; skills are integral and not inspectable or portable |
| **Portable and inspectable** | General chat & RAG assistants — open, but produce uncited answers and no decision anyone can sign | **Unoccupied** — no open, auditable skill library exists for regulated engineering documentation |

*Place the named platforms accurately from their own material.* ⚠️ `[[VERIFY: each characterisation
from the vendor's own published material]]`.
*One line beneath:* **closed platforms already do the review. What is missing is the portable,
inspectable layer underneath it — and that is the part a plant has to own.**

**Block 2 — The mechanism, not the market.** *(Why this is the right insight, stated generally.)*
Coding agents did not get good because models got smarter. They got good because someone wrote
**skills** — reusable, named procedures encoding what an expert actually does: read the file before
editing it, run the tests before claiming success, search before assuming. Each is a small piece of
*engineering procedure*, and the harness became capable the moment that library got rich ·
skills are also what make an agent **reliable**, because a skill can *require* the loop to do
something — fetch the clause before concluding, execute the script before reporting it works — and
turn that requirement from a hope into a rule the code enforces.

**Block 3 — The insight.** *(The pivot. No product name.)*
Regulated, non-coding engineering work has exactly the properties that make skills valuable and
nobody is writing them. The truth is external, versioned and adversarial, held in standards and
signed forms, so a generalist model cannot be trusted to improvise the procedure — and the domain
supplies no test suite to catch it when it does · **an open, portable, extensible skill library for
this work does not exist.** Closed platforms ship their own, welded shut, for a customer they
already have.

**Block 4 — Our answer: a T-shaped workbench.**
*Horizontal bar — a generalist floor that is genuinely good.* Across the task types an engineering
organisation actually brings, the result is dependable rather than merely adequate: no refusal, no
hallucination, no shrug. Each request goes to a real specialist model via a deterministic router,
and a general path exists when no specialist fits. **The bar is good because general-purpose skills
plus real specialists back it — it is not a surface-level approximation.**
*Vertical stem — deep, in one place.* **Regulated industrial engineering documentation:** inspection
reports, drawings, vendor data, approval notes, judged against internal SOPs and standards. Here
the workbench binds every conclusion to a source and a clause, gates every consequential action,
and withholds approval when the evidence does not support one.
*The two are the same architecture.* A skill written for inspection review is immediately reusable
on a drawing audit, because both are *"extract the evidence, retrieve the governing clause, compare,
decide, refuse if incomplete."* Generalist runtime plus a growing library is what turns a demo into
something a plant can extend without us.
*The T is a deliberate allocation of effort:* we do not compete on raw breadth, which is an arms
race we would lose.

**Block 5 — Why open.** *(The wedge against closed platforms. Do not state this softly.)*
Closed tools in this space cannot be audited, forked, or verified by a third party — the knowledge
is welded into the product · a PSU or defence-adjacent buyer **cannot accept that** for a process
that touches pressure-equipment sign-off · open source is what makes the sovereignty claim
credible: **you cannot audit what you cannot read.** The plant can inspect exactly what the system
knows how to do, extend it with its own procedures, and run it on its own hardware without a
licensing negotiation.
*❌ Never state open source as a value or a price point. Always: open, so it can be audited,
extended, and owned.*

**Block 6 — What the vertical actually does.** *(5 lines maximum — the product.)*
A desktop application on the organisation's own hardware, with no external endpoint in its
configuration · a **capability-composed skill runtime** — the available skills are assembled from
what is actually present: mounted files, attached documents, an indexed standards library · every
conclusion bound to its source document, page and retrieved governing clause · consequential actions
pass a precondition check that pauses, names the unmet condition and routes to a concrete recovery ·
**"insufficient evidence" is a valid, required output**, and a withheld sign-off is a successful run
· outputs are real deliverables — Word, Excel, PDF, code — not chat replies.
*One line:* *"Three reference workflows verified end-to-end against machine-checkable oracles by an
automated validator, backed by 42 test suites. Installation, architecture, benchmarks and roadmap
are documented in the accompanying technical blog and the public repository — slide 6."*

**Block 7 — Innovation and uniqueness.** *(3 lines, mechanism-claim format — the template asks.)*
**An open skill library for regulated engineering work** — where coding harnesses got their
capability from skills, this supplies them for inspection review, drawing compliance and approval
drafting, inspectable and plant-extensible · **skills as enforceable rules, not prompts** — a
skill can forbid a conclusion that lacks a clause, which is what makes the system auditable rather
than merely fluent · **containment the customer verifies independently** — proof held outside the
application by the customer's own infrastructure, not self-reported by the vendor.

- **Dominant visual:** **The T itself**, drawn as a structural diagram, not a letter: a wide
  horizontal band whose thickness is *modest but solid*, dropping into a single deep vertical stem.
  **Label the bar with generalist skills** (read the document · find the reference · compute the
  check · show the working · produce the file · say when unsure) and **label the stem with the
  specialist library** (extract evidence · retrieve governing clause · compare against limits ·
  decide · **refuse if incomplete**). Render the stem visibly deeper than the bar is tall — the
  asymmetry is the message, and the skill labels are what make the bar read as *good* rather than
  shallow. Native shapes only, no icons, no gradient.
- **Alternative if space is tight:** Block 1's positioning map as a small inset, Blocks 1–6 as a
  left column, the T on the right. **The T is the stronger visual — keep it.** The map can move to
  an appendix slide if the format allows.
- **❌ Do NOT put here:** model names, technology lists, screenshots, the word "platform", a
  feature grid, arrow spaghetti, or any diagram of the three reference workflows.
- **Why it exists:** It is the only slide that carries the argument, so it is the densest — but
  every block must be independently readable or the density defeats itself. The T is the image the
  evaluator will describe to their colleagues afterwards.

---

### Slide 3 — TECHNICAL APPROACH

*Template asks: technologies · methodology and implementation process · flow charts / images /
working prototype.*

- **Purpose:** Show the skill runtime as a real mechanism, and show **one skill as a real
  artefact** rather than describing the idea of one.
- **Headline:** *"Skills are code, not prompts — and they are what makes this reliable."*

**Block 1 — The skill runtime.** *(The substrate. Verified in the codebase.)*
A skill is a **declared capability with a fixed schema** — a name, typed inputs and outputs, an
executable procedure, and explicit conditions under which it must refuse · the runtime **composes
the available skills from the actual environment** — workspace mounted, documents attached,
standards indexed — so the agent is never offered a capability that is not there ✅
(`router/tool-compositor.ts:27`) · skills are invoked through **native tool calling** with
`tool_choice: "auto"`, falling back to prompt-injected schemas where a runtime rejects the
parameter ✅ (`gateway/model-gateway.ts:1333-1400`, fallback at `:1533`) — which is why an
OpenAI-compatible interface was chosen: **it is what makes model substitution portable rather than
an integration project** · a deterministic router keeps the breadth affordable by sending each
request to the right model, inspectably ✅ (`router/intent-classifier.ts` — rule-based, by design:
the route determines which model touches sensitive data, so a rule is preferable to a softmax).

**Block 2 — The specialist library, shown as a real artefact.** *(The most important block on this
slide. Present ONE skill the way a coding harness presents one.)*

> **Skill: `compliance_assessment`**
> **Purpose:** assess a document set against a governing standard and produce a decision packet.
> **Requires:** extracted evidence with a source reference for every value · the governing clause
> retrieved from the indexed standards library, cited by reference · a measured value stated
> against the limit it was compared to.
> **Refuses when:** any value lacks a source, or any verification gap is open. **Refusal is a
> successful outcome, not a failure.**
> **Output:** a clause-referenced deliverable carrying an explicit status — supported, conditional,
> or **not approved** — and an open-items list.

*Then one line:* the library is **capability-composed, not hardcoded** — a new standard is a new
clause set and a new skill, not a rewrite ✅ (`grounding/sop114-engine.ts`,
`grounding/spec-compliance.ts` — the first two entries in the library, ⚠️ currently specialised to
one standard each; generalising them to accept any clause set is on the pre-design list).
**❌ Do not claim a skill community exists.** The format is designed for extension; that is a
design property, demonstrated, not a roadmap.

**Block 3 — Sovereignty as evidence, not as a setting.** *(Three layers, increasing in strength.)*
1. **By construction** — every endpoint is a registered local/LAN address; no cloud SDK, no
   telemetry, no external DNS. The app cannot reach a cloud provider because none is configured.
2. **By containment** — model-authored code runs under an OS network namespace with read-only input
   mounts and run-scoped writable output, wall-clock timeout and capped output. ⚠️ **Linux-specific**
   — state this plainly.
3. **By independent evidence** — packet capture at switch/firewall level, held *outside* the
   application, recording zero external requests, traffic exclusively between registered internal
   hosts, and a deliberately attempted outbound request observed being **dropped and logged**.
   **Say explicitly that layer 3 is the only one that is not self-reported.**
*Plus:* **if a model host is unreachable the system halts with a visible error. It never falls back
to an external provider.**

**Block 4 — Evidence: three reference workflows.** *(Three-column triptych, columns identical in
structure.)*

| | Document review | Tool maintenance | Drawing compliance |
|---|---|---|---|
| **Input** | Scanned reports incl. a handwritten field annotation | A failing internal script + malformed vendor data | An engineering drawing + the governing specification |
| **Routed to** | Vision → reasoning | Coding | Vision + retrieval |
| **Agent does** | Extracts typed and handwritten evidence, retrieves the clause, synthesises across documents | Executes isolated, **observes a real failure**, corrects it, re-verifies to a clean exit | Extracts component values, compares against retrieved limits |
| **Deliverable** | Clause-referenced Word decision packet, **sign-off withheld pending an open field item** | Verified script and corrected output, proven by execution | Corrective-action note, **status: not approved** |
| **Proves** | Clause binding + multi-document synthesis | Genuine self-correction, not a scripted answer | Limits are **queried**, not embedded |

*Shared footer band beneath all three:* routing visible · skills executed live · external request
counter held at 0.
⚠️ **All input names, measurements and identifiers must come from an actual run.** **Describe input
*types* rather than naming asset IDs** — the types carry the argument, the IDs carry nothing.

**Block 5 — Architecture and stack.** *(Compact. The trust boundary is the message.)*
Electron main is the only process that touches models, files or the network; the renderer is
untrusted presentation with a narrow typed IPC surface and no filesystem or model access · every
workspace operation is path-contained · local inference over an OpenAI-compatible interface · embedded
local vector index for retrieval ✅ *(Vectra — **not** "ChromaDB", which is not a dependency)* ·
desktop shell, local persistence, document-generation libraries.

- **Dominant visual:** **The skill card from Block 2, rendered as a real artefact** — a bordered
  panel with labelled fields (purpose / requires / refuses when / output), set in the deck's body
  type at legible size. This is worth more than a diagram of the skill *architecture*, because it
  answers "your skills are just prompts" with something the evaluator can read. The agent loop
  (classify → plan → precondition check → act → observe → conclude) runs as a **subordinate
  process strip beneath it** — five nodes, the precondition node drawn as a gate, the loop-back from
  *Observe* to *Act* shown explicitly, because self-correction is invisible in a linear list.
- **❌ Do NOT put here:** source file paths, class names, version numbers, database schema,
  click-by-click demo instructions, or three screenshots (they collapse to illegibility at
  projection scale — one maximum, and only if it beats the skill card).
- **Why it exists:** It answers attacks 5, 6, 7, 8, 9, 10 and 17 simultaneously, and it is where
  "we built this properly" becomes visible rather than asserted.

---

### Slide 4 — FEASIBILITY AND VIABILITY

*Template asks: feasibility · challenges and risks · strategies for overcoming them.*

- **Purpose:** Convert uncertainty into rigour. The slide an evaluator photographs.
- **Headline:** *"It runs on hardware the organisation already owns — and here is exactly what
  could still go wrong."*

**Block 1 — Feasibility and deployment.**

**Two inference shapes, one configuration — and the join is three fields.**

*Shape 1 — single device.* All roles co-resident on one GPU machine. This is the recommended pilot
entry point, and the PS's stated target.
*Shape 2 — distributed.* Roles spread across whatever GPU hardware the organisation already owns —
a workstation, a server, a Mac mini, machines of different generations doing different jobs. Each
model is bound to its own endpoint. **Neither shape is privileged in the system: they are the same
configuration, and an organisation can move from one to the other without redesigning anything.**

**The join is deliberately minimal, and this is the differentiator.** Adding a device — or replacing
one — requires **host, port, and model name.** Nothing else. No adapter to write, no integration
project, no vendor lock-in, because the contract is not "Ollama" or "LM Studio" or "vLLM" — it is
**any OpenAI-compatible `/v1` API**, which every one of those runtimes already speaks. A deployment
that starts on one machine in a pilot can later spread across a mixed fleet, or swap a slow model
for a faster one, by editing a connection, not a codebase.

*Verified in the repository:*
✅ **`config/models.json`** — the registry, a plain, inspectable file mapping task type → runtime →
endpoint → model.
✅ **A guided onboarding wizard** — the operator enters host, port and model name; the app probes
`/v1/models`, falls back to `/models` for runtimes that expose it there, reports latency and
available models, and persists the binding. **It requires no code change and no restart.**
✅ **Runtime-agnostic by contract** — the model interface targets `mlx-lm`, `llama-server`,
`Ollama` and any OpenAI-compatible server, with a prompt-schema fallback where a runtime rejects
native tool parameters (`gateway/model-gateway.ts:1533`). One interface, several very different
inference engines.

*Why this matters for the buyer, stated plainly:* **the deployment is not locked to hardware the
team chose.** It runs on whatever the organisation already owns, in any mixture, and it changes
shape as their fleet and their models change. For a plant replacing hardware on a budget cycle, or
staging a pilot on a laptop before committing capital, that flexibility *is* the feasibility.

· Provisioning: models, packages and standards transferred and checksummed **before** the network
is disconnected · **Cost: open source, zero licence, run on owned hardware** — formal basis
`[[VERIFY: hardware/quoted figures, or omit]]` · **Growth path:** new devices, new models and new
standards are added as configuration and indexed content.
✅ *A preflight validator checks fixture integrity and deterministic outcomes before an evaluation —
a genuine engineering-assurance asset, worth showing.*
**❌ No machine models, processor names, rupee figures without a source, or throughput claims.**


**Block 2 — Risks and mitigations.** *(A real register. 5 rows, no more.)*

| Risk | Mitigation |
|---|---|
| Model quality below the threshold for a task class on available hardware | Task classes scoped and validated per deployment; a stronger model bound via the registry with no code change |
| The skill library stays narrow — one standard, two workflows | Library is capability-composed, so a new standard is a new clause set and a new skill; the two shipped skills are the first entries, not the design |
| Model host unreachable mid-run | Run halts with a visible reason — **no external fallback exists by design** |
| Isolation not enforced on unsupported platforms | Namespace isolation is Linux-specific and stated as such; pilot hardware chosen to match; the fallback is workspace-locked and time-bounded |
| A community never forms around the library | Not claimed as a dependency. The value holds if the library is written and extended only by the deploying organisation — which is the stated pilot model |

*One line:* every mitigation listed is **already implemented and in the repository**, not an
intention — the table is auditable at `github.com/BITverse-24/agent`.

**Block 3 — Limitations, stated openly.** *(Plain list, lightest weight on the slide.)*
Single-user, not multi-tenant · English-language documents and interface · namespace isolation on
Linux only, with a weaker fallback elsewhere · **the library ships with two specialised skills and
two reference workflows — breadth across other document classes is not yet built** · knowledge
coverage limited to what has been indexed · no production security hardening · reference workflows
are rehearsed demonstrations, **not a statistical benchmark**.

**Block 4 — What we are building next.** *(Small, subordinate, explicitly forward-looking. Present
tense is forbidden here — every item is planned, not shipped.)*
Generalising the grounding skills so any clause set can be loaded rather than one being hardcoded ·
extending the library beyond the two reference skills · isolation parity beyond Linux · additional
document classes and standards · multi-user and role-based access, which real plant deployment
requires and which is out of scope today · practitioner validation and a pilot · **outcome
measurement — time-on-task and extraction accuracy — where the method is defined and the results
are pending.**
*One line, and the honest framing of the whole slide:* **the runtime, routing, containment and
evidence trail are built and tested today; the library is what we are growing next.**


- **Dominant visual:** The **three-field join**, shown as a single small diagram rather than a
  deployment sketch. Left: a stack of heterogeneous boxes labelled only by *what they are* — a
  workstation, a server, a Mac mini, a laptop — deliberately unlabelled by model, because the point
  is that the hardware is irrelevant. Right: the workbench, bound to them by three labelled
  connectors: **host · port · model name**. Beneath: a single line, **"any OpenAI-compatible `/v1`
  API — Ollama · LM Studio · llama.cpp · MLX · vLLM."** The risk table remains the substance of the
  slide; this diagram sits small inside Block 1. Block 3 (limitations) sits beneath as a plain list.
  Block 4 (what's next) sits last, lightest weight.
- **❌ Do NOT put here:** machine specs from internal planning docs, invented cost savings, hidden
  limitations, or a mitigation describing a future intention.
- **Why it exists:** It answers attacks 4, 9, 11, 13 and 15, and candour here converts directly into
  credibility.

---

### Slide 5 — IMPACT AND BENEFITS

*Template asks: impact on the target audience · benefits (social, economic, environmental, etc.).*

- **Purpose:** Show consequence honestly, making measurement discipline part of the claim.
- **Headline:** *"The impact is not faster typing — it is work that could not previously be done
  with AI at all."*

**Three tiers, deliberately unequal in visual weight so the reader always knows which is which:**

**Tier 1 — Structural. Demonstrable now; needs no measurement.**
A class of work becomes AI-assisted that policy previously excluded entirely · deliverables carry
their evidence trail into the approval process rather than into a chat window · unresolved field
items are surfaced and routed rather than smoothed over · **the organisation keeps its skills,
documents, indexes and outputs** rather than transferring them to a third party.
*These are the strongest claims in the deck because they are statements of fact requiring no number.*

**Tier 2 — Organisational. Measurable; method defined, results pending.**
Expert time redirected from transcription and formatting to judgement · internal tooling
maintenance reduced from manual debugging cycles · **procedure knowledge captured as skills rather
than left in individual heads** — the library is an institutional asset that outlives staff turnover
· *method: baseline-and-compare across a defined pilot task set.* Results `[[MEASURE: …]]`.
✅ *Verifiable today:* three reference workflows verified end-to-end against deterministic oracles by
an automated fixture validator, backed by 42 test suites covering the agent loop, path containment,
retrieval and end-to-end flow behaviour.

**Tier 3 — Wider. Directional only, and visibly marked as such.**
Extension to further document classes is a matter of adding skills to a runtime that already
composes them · a plant that already owns GPU-capable hardware needs no new cloud spend to adopt it
· because the library is open, **another plant's skill for the same procedure can be reused rather
than rewritten** — stated as a design property, not as a forecast.
*Marked **directional** on the slide so it cannot be read as a promise.*

- **Dominant visual:** **None, or the three-tier structure itself.** A number-free impact slide with
  a clear hierarchy is stronger than a slide of invented percentages. If a chart appears at all it
  belongs **only** in Tier 2 and only once measured figures exist. **Do not illustrate this slide.**
- **❌ Do NOT put here:** invented statistics, user counts, adoption forecasts, cost savings,
  "national productivity", partnership or endorsement claims, any implication of government
  adoption, or unmeasured environmental claims.

---

### Slide 6 — RESEARCH AND REFERENCES

*Template asks: details/links of the reference and research work.*

- **Purpose:** Establish the work is grounded in verified components **and sits in a real research
  conversation** — this is a technical audience, and citing the open problem is what makes the
  differentiation claim credible rather than assertive.
- **Headline:** *"Built on established open components, against a named open problem."*

**Group 1 — Why the vertical is hard.** *(The research conversation. Highest value on this slide.)*
The self-verification asymmetry between coding and enterprise work, and the open question of
whether coding-agent harnesses generalise to business process · the role of **skill and tool
libraries** in agent capability, and the case for domain skills as the transferable mechanism · the
case for **informed abstention** as a structured, auditable capability rather than a failure mode ·
the finding that state-of-the-art models **systematically overcommit** rather than abstain under
uncertainty — the precise failure mode that makes them unsafe in a regulated plant.
⚠️ `[[VERIFY: exact titles, authors, IDs and years — found in research, must be opened and
confirmed personally before citing]]`

**Group 2 — The project itself.** Name, licence, and repository URL. *For a deck whose wedge is
openness, the project's own licence is a primary reference, not a formality.* ⚠️ Confirm the
intended licence before printing it.

**`github.com/BITverse-24/agent`** — public repository. State the two artefacts an evaluator can
verify there, because checkable is what makes a claim credible at this stage:
**① the implementation** — `config/models.json` (the registry), `router/tool-compositor.ts` (the
skill runtime), `harness/path-guard.ts` (containment), `backend/tests/` (42 suites);
**② the technical blog** — installation, technical architecture, benchmarks and roadmap.
*Every "see the technical blog" reference elsewhere in the deck must point at a real, published
section, and any benchmark it cites must be a measurement the team has actually run.*


**Group 3 — Open-weight models.** The vision, reasoning and coding families used, with **licence
noted per family** (⚠️ verify — licences differ).

**Group 4 — Local inference runtimes.** The OpenAI-compatible server implementations the registry
targets — Ollama, LM Studio, llama.cpp / `llama-server`, MLX, vLLM and any other server exposing an
OpenAI-compatible `/v1` API — and the reason that interface was chosen: **portability across
runtimes is what makes model substitution and hardware substitution configuration changes rather
than integration projects.** The application targets `mlx-lm`, `llama-server` and `Ollama` runtimes
through one model interface, with a prompt-schema fallback where a runtime rejects native tool
parameters. *This is the group an evaluator should check most closely — it is the one that makes the
"any device" claim true rather than aspirational.*

**Group 5 — Retrieval and isolation.** The embedded local vector index; OS-level network namespace
isolation; path containment by construction.

**Group 6 — Application platform.** Desktop shell, local persistence, document-generation libraries.

*Plus a separate, clearly labelled line for any external source cited on Slide 2* — those are the
only references an evaluator will hold us to.

- **Dominant visual:** A **five-band reference grid** with hairline rules. No logos, no website
  screenshots, no long raw URLs. Full designation and issuing body for any standard.
- **❌ Do NOT put here:** blog posts, undated forum answers, AI-generated summaries, or **any
  reference the team has not personally opened.** Unverifiable references are worse than few.

---

### Slide 7 — Close *(optional — include only if the format permits)*

- **Purpose:** Ensure the deck leaves behind one sentence, not six.
- **Headline:** *"Code got good because someone wrote skills. Most engineering work hasn't."*
- **Content — three lines, then stop:**
  Coding agents became capable when someone wrote skills for the domain. **Regulated engineering
  work has no such library.** Sovereign Workbench supplies one — open, inspectable, and plant-
  extensible — over a runtime that composes skills from what the environment actually has, running
  entirely inside the customer's perimeter. It runs on hardware the organisation already owns, and
  it is configured to change with the models it depends on.
  *One understated line:* verified end-to-end on three reference workflows, air-gapped, zero
  external requests.
- **Visual:** **None.** A single closing line at large type, or nothing but the three lines and a
  closing rule.
- **❌ No** thank-you slide over a busy background, no summary of everything, no funding ask, no
  partnership language.

---

## H. Template compliance map

| Template slide | Mandated content | Satisfied by |
|---|---|---|
| 1 | Team details | Slide 1 — manual, per template |
| 2 | Idea/solution/prototype · how it addresses the problem · innovation and uniqueness | Slide 2, all seven blocks; uniqueness in Block 7, defended in Blocks 1–3 |
| 3 | Technologies · methodology and implementation process · flow charts / working prototype | Slide 3, Blocks 1–5 |
| 4 | Feasibility · challenges and risks · mitigation strategies | Slide 4, Blocks 1–3 |
| 5 | Impact on target audience · social / economic / environmental benefits | Slide 5, three tiers |
| 6 | Research and references | Slide 6 |
| *(7)* | — | Close — optional, additional |

**Template discipline:** Slide 1 is entered manually and otherwise untouched. No slide discards,
crops, recolours or re-lays-out the template's master, headers, footers or page geometry. Any added
slide inherits the template's own layouts.

**If the format permits more than 5 authored slides**, the highest-value splits are:
(a) give the **positioning map** (Slide 2, Block 1) its own slide — it carries the differentiation
claim and is dense enough to need room; and (b) give the **skill card** (Slide 3, Block 2) a full
slide of its own, since a named, readable, enforceable skill is the single most persuasive artefact
in the deck.

---

## I. Pre-design checklist — resolve before any layout work

- **Hardening — GPU-neutral deployment is a differentiator worth guarding.** Both the single-device
  and distributed paths depend on the registry and the onboarding wizard. *Before the finals:*
  confirm the wizard can bind a second device while a run is in progress, and confirm a model swap
  on a live host is picked up without an application restart. If either fails, it is a
  configuration-layer fix, not a design change — but it is better found now than in front of a panel.

1. ⚠️ **Generalise the two grounding skills.** `grounding/sop114-engine.ts` is hardcoded to one
   standard, which contradicts the entire thesis if an evaluator opens the repo. Either make the
   clause set an input, or state the specialisation honestly on the slide.
2. ⚠️ **Build the `compliance_assessment` skill card as a real, readable artefact.** The thesis
   currently has no demonstrated instance of a skill. This is the single highest-value addition.
3. ⚠️ **Decide the skill format and state it precisely** — declared capability, typed I/O, explicit
   refusal conditions. Do not claim a community; claim extensibility as a design property.
4. ⚠️ **Verify every named competitor** in the positioning map from the vendor's own material.
5. ⚠️ **Open and confirm every research citation** in Group 1 — titles, authors, IDs, years.
6. ⚠️ **Decide the project's own licence** and state it on the references slide.
7. ⚠️ **Decide the retrieval technology.** "ChromaDB" is not true today — `ai/rag/db.ts` uses
   `vectra`. Accept "embedded local vector index (Vectra)" or add ChromaDB.
8. ⚠️ **Confirm platform support** (Linux-namespaced isolation only?) and state it plainly.
9. ⚠️ **Source one citable reference for the problem statement**, or remove the citation.
10. ⚠️ **Capture screenshots from a real run:** the external-request counter, the routing indicator,
    and one full workflow output showing a withheld sign-off with its citation.
11. ⚠️ **Fill or delete every `[[...]]` placeholder.** No placeholder survives into the final deck.
12. ⚠️ **Measure or remove every outcome claim.** An unsourced number disqualifies the deck.
