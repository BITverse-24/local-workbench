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


## E.3 Judging conditions — and what they change

**The facts:** the deck is reviewed **online, on a judge's own device, without a presenter**, inside a
field of **~500 submissions per problem statement**.

These two facts change the deck more than any content decision below. A live pitch is a
performance; this is a **document**. Everything in Section G follows from that.

**What it changes:**

| Judging condition | Consequence for the deck |
|---|---|
| No presenter to explain | **Every slide must be self-contained.** A judge who lands on slide 4 and reads only it must still get a complete argument. No "as shown earlier", no "as we discussed", no build-up that only makes sense in sequence. |
| Reviewed alone, at their own pace | **Density is now an advantage, not a risk.** The ~40-word-per-block limit set for projection is too strict here. A judge reading on their own screen will *reward* detail — what disqualifies them is thinness, not density. Raise the per-block budget and use the space. |
| ~500 submissions in the queue | **The first five seconds of each slide decide whether it gets read.** A single scannable claim must be visible without effort. Judges are optimising for signal, not reading everything — we must survive the skim *and* reward the close read. |
| No live demo | **A designed product visual replaces the demo, and it must be excellent.** A raw screenshot at small scale reads as an unfinished prototype; a well-designed mockup of the same interface reads as a considered product. See "The visual system", below. |
| Depth lives in the technical blog | The blog is now **the answer to depth, not a substitute for a live demo.** It must be linked, findable, and written so a judge can open it cold and be impressed within two minutes. |
| Judge may only read some of the deck | **The slides they are most likely to read are slide 2 and slide 3.** These two must carry the thesis, the differentiation, and the evidence. Nothing essential may live only on slides 5–7. |

**The three concrete changes this produces:**

1. **Every headline must stand alone as a claim.** A judge skimming fifteen headlines in isolation
   should reconstruct the entire argument. Our headlines are written this way already — that is why
   the closing line is *"The model was never the hard part"* and not *"Summary."*

2. **The T-diagram and the skill demonstration move onto slide 2 and 3** — the two slides a judge is
   guaranteed to read. Nothing that carries the argument may be deferred to slide 5.

3. **The deck must be self-sufficient on evidence.** Assume the judge never opens the blog and
   never sees a demo. The blog *raises* the ceiling; it must not *carry* the floor.

**And the consequence that argues for restraint:** with 500 submissions, the winning mistake is
*confusing*, not *incomplete*. A judge who finishes a slide and understands it will go back to the
blog. A judge who finishes a slide and is unsure what we meant will not. **Clarity beats completeness
at every junction.**


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

> **These rules assume the deck is read on the judge's own device, not projected in a live room.**
> See Section E.3. The limits below are therefore deliberately more permissive than a conference
> deck would be.

- **One takeaway headline per slide**, top-left, stating the *conclusion* — not the topic. Not
  "Technical Approach" but "Skills are code, not prompts — and they are what makes this reliable."
  **Each headline must stand alone**, because a judge may read the deck out of order or skim only
  the headlines.
- **Fixed grid:** headline band (top ~12%) → labelled content blocks (left/main) → **one**
  dominant visual (right or full-width beneath) → footer (slide number + short project lockup).
- **One dominant visual per slide.** Supporting tables and small diagrams are permitted; two
  competing focal points are not.
- **Body text budget: ~90 words per block, ~220 per slide.** Generous by live-presentation
  standards, because the reader controls their own pace. Blocks are labelled, and each is readable
  on its own — a judge who reads only the block about risks must get a complete thought.
- **Hierarchy must survive a skim.** Within each slide, the reader should encounter claim →
  support → evidence in that order, and the first line of every block must be the claim.
- **Banned:** gradients, glow, glassmorphism, neon, 3D objects, robot/brain imagery, icon confetti,
  rounded-card mosaics, stock photography, and the phrases "AI-powered", "seamless", "next-gen".
- **Build every diagram from native Canva shapes and connectors** so it stays editable.
- **Blocks are labelled, not decorated:** a small caps label, then content.

### The visual system — no screenshots, one designed product view

**The decision:** the deck contains **no raw screenshots.** A screenshot at the size a slide can
carry shows a dense application chrome, half-legible, and reads as a working prototype rather than a
finished product. Against ~500 submissions that is a real cost. Instead the deck uses **one
purpose-designed product view** — a mockup drawn specifically for the slide — used once, at large
size, where it does real work.

**Why a designed mockup is the stronger choice, not the compromise:**

- It can be **composed for legibility at slide scale**, showing only the two or three elements the
  point depends on, rather than an entire window shrunk to fit.
- It can **show a moment that is genuinely true but hard to catch live** — a mid-run state, with the
  routing indicator, the tool transcript and a withheld sign-off visible together.
- It renders at any size without pixelation, and sits inside the template's visual language instead
  of contradicting it.
- **It is honest, provided one rule is respected** *(below). A mockup is a designed representation
  of a real interface; a fake screenshot — a doctored or fabricated screen — is not, and would be
  the single most damaging thing we could put in the deck if an evaluator looked closely.

**The one rule that keeps this honest — and it is non-negotiable:**
> Every element shown in the mockup must **actually exist and actually work** in the built
> application. Nothing may be invented for the slide: no fictional metric, no fabricated latency
> number, no control that does not exist, no status that the product cannot produce. If a value
> appears, it is a value the real run produced.

**What the product view shows — chosen because it is the whole thesis in one frame:**

A single application window, simplified, containing exactly three things:

1. **The routing indicator** — which model is handling this request, and why. *(This is the T's
   horizontal bar, made visible: a deterministic router dispatching to a real specialist.)*
2. **The agent transcript** — a plan, a tool call, and the result it returned. *(This is agency,
   shown rather than asserted.)*
3. **The output, carrying a citation and a withheld sign-off** — a measured value against its limit,
   the governing clause referenced, and the decision state reading **not approved**. *(This is the
   vertical stem, and it is the single most persuasive element available to us.)*

**Why those three and nothing else.** A judge skimming sees a routing decision, evidence being
gathered, and a system declining to approve something. That is the entire argument, in one image,
readable in three seconds. Every additional element is a distraction competing with those three.

**Design constraints — this must look like the template, not like a screenshot pasted into it:**

- Rebuilt as **native Canva shapes and text**, inside the deck's own type scale, colour and grid. It
  is a *figure in the deck's language*, not an image dropped on top of one.
- **Deliberately stylised and simplified** — fewer panels, fewer controls, more whitespace, larger
  type than the real interface. It should read as an honest diagram of the product, not as a
  half-legible reproduction of it.
- **No window chrome, no OS title bar, no browser or window buttons.** No drop shadows, no rounded
  "device" frame, no perspective tilt, no device bezel. A flat panel with a hairline border, or no
  border at all.
- **Real values only.** Where a number appears, it is a number the system actually produced on a
  real run. Every other field is either a genuine label from the interface or deliberately empty.
- **The "not approved" state must be visually unmistakable** — it is the payload of the entire
  image, and it must be the first thing the eye lands on after the headline.


### The layout system — how every slide is built

**The problem this solves.** With ~500 submissions, most decks fail on craft rather than content:
the same centred-title-plus-bullets arrangement, the same three rounded cards, the same clip-art
icons. A judge sees the template, not the author. **Distinctiveness here comes from a consistent
structural system that is visibly deliberate — not from decoration, which is the first thing to
look cheap.**

**The single idea that makes the deck read as designed:** every slide is **one claim, evidenced in
a fixed arrangement** — a headline that is a conclusion, a left column of labelled blocks that open
with their own claim, and one figure that does the explaining. The judge learns the pattern on
slide 2 and it keeps working. **Repetition of a structure is what signals authorship**, and it buys
the tired judge speed.

#### The frame — identical on all six authored slides

```
┌────────────────────────────────────────────────────────────────┐
│  HEADLINE BAND                            one conclusion only  │  ~12%
│  ─────────────────────────────────────────────────────────────  │
│ ┌──────────────────────┐  ┌─────────────────────────────────┐  │
│ │ LABELLED BLOCKS      │  │                                 │  │
│ │                      │  │      FIGURE                     │  │  ~68%
│ │ LABEL → claim first  │  │   one, doing the explaining     │  │
│ │ then support         │  │                                 │  │
│ │                      │  │                                 │  │
│ │ 55–60% width         │  │      40–45% width               │  │
│ └──────────────────────┘  └─────────────────────────────────┘  │
│  RULE ────────────────────────────────────────────────────────  │
│  project lockup                                    slide number │  ~4%
└────────────────────────────────────────────────────────────────┘
```

Slides 2, 3 and 4 use this frame exactly. **Slide 3 breaks it deliberately** (the mockup takes
two-thirds and displaces the text column) — one break in a consistent system reads as emphasis;
three would read as inconsistency.

#### Block anatomy — the unit that carries the argument

```
LABEL IN CAPS, SMALL, SECONDARY COLOUR
  The claim, in one line. This is the skim path — the tired
  judge reads only these lines and still gets the argument.
  Supporting evidence underneath, at body size, never above.
```

**Rules that make this work:**
- **The first line is always the claim.** Never context, never a definition, never a lead-in.
- **Labels are actions or nouns, not topics.** `THE GAP` · `WHAT WE BUILT` · `WHY OPEN` · `RISKS` —
  never `PROBLEM STATEMENT` or `SOLUTION OVERVIEW`.
- **One accent per slide maximum**, marking the single most important element. If two things are
  accented, neither is.
- **No bullets inside blocks.** Blocks are prose, three to five lines, with **·** as an inline
  separator. Bullets fragment a claim into fragments; prose keeps it arguable.
- **Bold carries the claim words, not emphasis-for-its-own-sake.** Two or three bold spans per
  block, at the words a skimmer must catch. Bold everywhere is bold nowhere.

#### Typography — the scale, and why it is the same everywhere

| Element | Size | Weight | Note |
|---|---|---|---|
| Headline | 28–32pt | 600 | One line where possible; two at most |
| Block label | 9–10pt | 600 | Caps, letterspaced, secondary colour |
| Block claim | 12–13pt | 600 | The skim path |
| Block support | 10–11pt | 400 | Never below 10pt — it will be read on a laptop |
| Figure text | 9–11pt | 400–600 | Small labels carry more credibility than large ones |
| Footer | 8pt | 400 | Lockup and slide number only |

**One type family throughout.** Hierarchy from size and weight, never from a second font.
**Never below 9pt** — a judge on a laptop at arm's length cannot read smaller, and unreadable
detail reads as sloppiness rather than density.

#### Colour — used for meaning, never for decoration

Inherit the SIH template's palette and do not introduce a new hue. **Three jobs only:**
- **Primary** — headlines, claims, key labels.
- **Secondary** — support text, labels, figure annotations.
- **One status accent** — a single element per slide where the deck is making a point that matters
  (the *not approved* status; the "unshareable" cell in a comparison; the current limit in a risk
  table).

**The rule that keeps this disciplined:** if a colour is not encoding status, hierarchy, or category,
it does not appear. A deck that uses colour decoratively is the second-most-common failure of the
submissions it is competing against.

#### Figures — the standard every figure must meet

- **Carries information.** Every element encodes something. If a figure could be reused unchanged on
  someone else's project, it is not finished.
- **Native Canva shapes and connectors**, built inside the template's type and grid, so it looks
  authored rather than pasted.
- **Restrained:** hairline rules, no drop shadows, no gradients, no 3D, no perspective tilt, no
  device bezel, no window chrome.
- **One focal point per slide.** A slide with two figures has none.
- **Text inside figures is real text, at figure scale** — not an image of text.

#### The three things that make this deck stand out from the field

Most submissions will centre a title and use three rounded cards. This deck should not. The three
differentiators, used consistently:

1. **The headline is a claim, on every slide.** A judge skimming fifteen headlines reconstructs
   the argument. Almost no competitor will do this, because it is harder to write.
2. **A visible left-edge accent rule on every block.** Cheap to build, reads instantly as a
   system, and costs nothing. Consistency is what is noticed, not any individual element.
3. **Real figures — the T, the mockup, the three-field join.** The T is a shape nobody else will
   draw, because nobody else will have arrived at the T. The mockup shows a real product. The
   three-field join makes a technical claim visible in a way prose cannot.

#### Two structural habits that signal a serious submission

- **The slide number and a short project lockup on every slide**, in the same position, same size.
  Amateur decks omit these; a judge notices the omission rather than the presence, which is why
  they must be right.
- **Whitespace at the bottom of every slide.** Content should not fill the frame edge to edge. The
  margin is what makes the rest look considered — a full slide always reads as crowded, however
  good the content is.


---

### The density rule — enforced, not advised

Every slide's copy is now **fixed and final** in Section G, marked *"this is the complete text; do not
add to it."* The word counts were measured, and the budget is **320 words per slide**:

| Slide | On-slide words | Budget |
|---|---|---|
| 2 — Solution | ~338 | 345 |
| 3 — Technical Approach | **~416** | **430 — deliberate exception** |
| 4 — Feasibility | ~323 | 340 |
| 5 — Impact | ~207 | 320 |
| 6 — References | ~251 | 320 |
| 7 — Close | ~59 | 320 |

**Slide 3 is over the standard budget on purpose.** It is the technical slide, the SIH template
names *technologies to be used* as a required element, and a technically confident judge who cannot
name the stack will not trust the argument above it. The stack and the trust boundary are stated at
the same altitude — *what it is built from, and where the privileged boundary sits* — without
descending into component-level detail, which is the blog's job. The skim path still works: the
headline and the first line of each block carry the slide on their own.

**Why the budget exists.** An earlier draft of this document ran to **1,146 words on slide 2 alone**
and ~1,000 on slides 3 and 4. That is not a slide — it is a source document compressed onto five
pages, and it fails in two opposite ways at once. A tired judge abandons it. An energetic judge
cannot find the claim inside the wall either, because with no hierarchy everything is equally
important and therefore equally invisible. **Density is only useful when it is *shaped*.**

**The rule that makes it work:** every block opens with its claim in the first line, then supports
it. The judge who reads only the block-opening lines gets the entire argument — that is the skim
path, and it is the one that decides the outcome.


---

### Slide 1 — Title & Team *(template: manual entry — do not automate)*

- **Content:** Project title, team name, three members with roles, institute.
- **Layout:** Use the template's existing title layout **unmodified**. Text entry only — no added
  shapes, no logo treatment, no colour beyond the template's own.

---

### Slide 2 — PROPOSED SOLUTION

*Template asks: idea/solution/prototype · how it addresses the problem · innovation and uniqueness.*

- **Layout method: claim stack with a hero figure** (see Section L). Six blocks of descending
  weight on the left; the T occupies the right column at full height, vertically centred against the
  column.
- **Purpose:** Carry the whole argument — field, mechanism, insight, T, product, uniqueness — in one
  slide. This is the slide a judge is guaranteed to read, and the only one that carries the thesis.
- **Headline:** *"Coding agents got good because someone wrote skills. Nobody has written them for
  regulated engineering work."*

**On-slide copy — final, ~340 words. This is the complete text; do not add to it.**

> **The gap.** Coding agents did not get good because models got smarter. They got good because
> someone wrote **skills** — reusable procedures encoding what an expert actually does. Regulated
> engineering work has the same need and none of the library. Closed platforms ship their own,
> welded shut, for a customer they already have.
>
> **What we built.** A **T-shaped workbench**: a generalist floor that is dependable across document
> review, drawing checks, data analysis and scripting — no refusal, no hallucination, each request
> routed by rule to the right local model — dropping into one deep stem: **inspection reports,
> drawings, vendor data and approval notes, judged against internal SOPs and standards.**
>
> **The stem is the product.** Every conclusion is bound to its source document, page and retrieved
> governing clause. Consequential actions pass a precondition check that pauses and routes.
> **"Insufficient evidence" is a valid output** — a withheld sign-off is a successful run.
>
> **Why open.** A PSU cannot accept a closed tool it cannot inspect for a process touching
> pressure-equipment sign-off. Open source makes the sovereignty claim credible — **you cannot audit
> what you cannot read** — and lets the plant extend it with its own procedures.
>
> **Runs inside the perimeter.** Every endpoint is a registered internal address and no cloud service
> exists in the configuration, so there is nothing to leak to; model-authored code runs sandboxed.
> **Zero external requests is a property we demonstrate, not a promise we make.**
>
> **Uniqueness.** An open, plant-extensible skill library for regulated engineering work · skills
> that enforce rules in code rather than request them in prose · containment the customer verifies
> independently, with packet capture held outside the application.
>
> **Status.** Three reference workflows verified end-to-end against machine-checkable oracles, with
> 42 test suites. Installation, architecture and benchmarks: technical blog and public repository.
>
> **In one line.** *Coding agents got good because someone wrote skills. Regulated engineering work
> has the same need and none of the library — so we are writing it, and it runs inside the
> customer's perimeter.*

- **Dominant visual:** **The T**, drawn as a structure, not a letter. A wide horizontal band —
  *modest but solid* — dropping into a single deep vertical stem. **Label the bar with generalist
  skills** (read the document · find the reference · compute the check · show the working · say when
  unsure) and **the stem with the specialist library** (extract evidence · retrieve the governing
  clause · compare against limits · decide · **refuse if incomplete**). The asymmetry is the message;
  the labels are what make the bar read as *good* rather than shallow. Native shapes, no icons.
- **The positioning map is cut from this slide.** It was the fourth thing competing for attention and
  the least load-bearing — the "closed platforms ship their own, welded shut" line carries the same
  claim in twenty words. It moves to the appendix or the blog, where a curious judge can find it.
- **❌ Do NOT put here:** model names, technology lists, screenshots, the word "platform", a feature
  grid, arrow spaghetti, the reference workflows, or any table.
- **Why it exists:** It is the argument, and it is the image — the T — that a judge describes to
  their colleagues afterwards.


### Slide 3 — TECHNICAL APPROACH

*Template asks: technologies to be used · methodology and implementation process · flow charts /
images / working prototype.*

- **Layout method: figure-led split** (see Section L). The one deliberate break in the frame —
  the mockup takes two-thirds, the text column is compressed to the left third, and the agent-loop
  process strip runs beneath both. **If the mockup is cut, restore the standard frame.**
- **Purpose:** Show the stack, the mechanism, and the proof — at a level that lets a judge assess
  technical credibility without opening the repository, while leaving the mechanism detail to the
  blog.
- **Headline:** *"Skills are code, not prompts — and that is what makes this reliable."*

**On-slide copy — final, ~430 words. Higher than the 320 budget, deliberately: this is the technical
slide, the template names technology as a required element, and an exhausted reader who skims gets
the headline and the first line of each block regardless.**

> **The stack.** *Desktop shell* — Electron, React, TypeScript, Vite. *Orchestration* — a supervised
> agent loop with native tool calling (`tool_choice: auto`) and a confirmation gate before any
> consequential action. *Models* — open-weight vision, reasoning and coding families served by
> OpenAI-compatible local runtimes, bound by a config registry rather than code. *Retrieval* — an
> embedded local vector index over the organisation's own standards. *Persistence and artefacts* —
> SQLite with run-scoped directories, generating Word, Excel, PDF and code. *Sandbox* — OS network
> namespace isolation with read-only inputs and run-scoped writable output. *Verification* — an
> automated fixture validator and a 42-suite test run.
>
> **The skill runtime.** A skill is a **declared capability with a fixed schema** — typed inputs and
> outputs, an executable procedure, and explicit conditions under which it must refuse. The runtime
> **composes the available skills from the actual environment**, so the agent is never offered a
> capability that is not there. The interface is OpenAI-compatible by choice: **swapping a model or
> a runtime is a configuration change, not an integration project.**
>
> **One skill, as implemented today.** *Compliance audit* — takes a drawing or document set plus the
> governing standard; extracts measurements; retrieves the governing clause; states each value
> **against the limit it was compared to**; and **withholds sign-off when a verification gap is
> open.** It cannot emit a recommendation without a retrieved clause behind it — **enforced in code,
> not requested in prose.** Output carries an explicit status: supported, conditional, or **not
> approved.**
>
> **Routing, by rule.** Request type is classified deterministically from content, attachments and
> runtime context; the decision is recorded and displayed. **Deliberately not a model:** the route
> determines which model touches sensitive data, so it should be readable by someone who does not
> trust the vendor.
>
> **Containment, in three layers.** *By construction* — every endpoint is a registered internal
> address; no cloud SDK, no telemetry. *By containment* — model-authored code runs under an OS
> network namespace with read-only inputs and a wall-clock timeout. *(Linux-specific; stated
> plainly.)* *By independent evidence* — packet capture **outside the application**, showing zero
> external requests and a deliberately blocked attempt. **Only the third layer is not self-reported.**
> If a model host is unreachable the system halts visibly — **it never falls back to an external
> provider.**
>
> **Evidence.** Three reference workflows — document review, tool maintenance, drawing compliance —
> each verified end-to-end against machine-checkable oracles.

- **Dominant visual — and this is the one image that must be excellent:** **the product mockup from
  the visual system above, at roughly two-thirds of the slide, on the right.** It is the only element
  in the deck that shows the product rather than argues about it, and against ~500 submissions read
  on a judge's own laptop it will be the thing that distinguishes this deck from every other one in
  the queue. It shows the routing indicator, the agent transcript, and an output carrying a citation
  and a **not approved** sign-off — the whole thesis in one frame, readable in three seconds.
  **Build it last, and get it reviewed by someone who has not seen the deck.** If it cannot be made
  genuinely good, cut it: a mediocre mockup is worse than none.
  Everything else is subordinate — the blocks above as compact labelled text in the left column, and
  the agent loop (classify → plan → precondition check → act → observe → conclude) as a small
  process strip beneath the mockup, with the precondition node drawn as a gate and the loop-back
  from *Observe* to *Act* shown explicitly, because self-correction is invisible in a linear list.
- **The three-workflow triptych is cut from this slide.** Its content survives as the one-line
  *Evidence* block above; the full triptych moves to the technical blog.
- **❌ Do NOT put here:** source file paths, class names, framework version numbers, database schema,
  click-by-click demo instructions, tables of any kind, or raw screenshots.
- **Why it exists:** It answers attacks 6, 7, 8, 9, 10 and 17 simultaneously, and it is where "we
  built this properly" becomes visible rather than asserted.

- **System architecture — the layer below, stated at the same altitude as the stack.** *(This is
  what a technically confident judge needs in order to trust the stack line: not components, but
  the trust boundary and the direction of every privileged call.)* **Electron main is the only
  process that touches models, files, or the network.** The renderer is untrusted presentation,
  holding a narrow typed IPC surface and receiving no filesystem handle, model address, or tool
  capability. Inside main: the run lifecycle and agent loop; the model gateway and registry; the tool
  dispatcher; the workspace harness with path containment on every file operation; the local
  retrieval index; and a run-scoped artefact store, SQLite in WAL mode. **Every arrow crossing into
  the renderer is a labelled, typed call** — which is the property that makes "the app cannot exfiltrate"
  an architectural claim rather than a promise.


### Slide 4 — FEASIBILITY AND VIABILITY

*Template asks: feasibility of the idea · potential challenges and risks · strategies for
overcoming them.*

- **Layout method: table-anchored** (see Section L). The risk table sits centre-stage at full
  width; deployment sits above it, and 'what we're building next' plus limitations sit below in
  lighter weight, separated by whitespace rather than a rule.
- **Purpose:** Convert uncertainty into rigour. This is the slide a sceptical judge looks for, and
  the one that decides whether the rest of the deck is believed.
- **Headline:** *"It runs on hardware the organisation already owns — and here is exactly what
  could still go wrong."*

**On-slide copy — final, ~290 words. This is the complete text; do not add to it.**

> **Deployment — two shapes, one configuration.** *Single device:* all roles on one GPU machine, the
> recommended pilot. *Distributed:* roles spread across whatever mixed hardware the organisation
> already owns. **The join is three fields — host, port, model name.** No adapter, no integration
> project, no lock-in, because the contract is **any OpenAI-compatible `/v1` API** — Ollama, LM
> Studio, llama.cpp, MLX, vLLM. A pilot on one laptop can later spread across a fleet, or swap a
> slow model for a fast one, **by editing a connection, not a codebase.** Open source, zero licence,
> run on owned hardware. **Every workspace operation is path-contained, and consequential actions
> require explicit human authorisation** — the agent proposes, the operator disposes.
>
> **Risks, and what is already built against them.**
>
> | Risk | Mitigation — implemented, in the repository |
> |---|---|
> | Model quality below threshold on available hardware | Task classes scoped per deployment; a stronger model bound via the registry, no code change |
> | Model host unreachable mid-run | Run halts with a visible reason — **no external fallback exists by design** |
> | Isolation not enforced off Linux | Namespace isolation is Linux-specific and stated as such; the fallback is workspace-locked and time-bounded |
> | Model-authored code affecting the host | Read-only inputs, run-scoped output, wall-clock timeout, capped output |
> | Evaluation-day failure | Reference workflows run against pre-validated inputs with deterministic oracles |
>
> **What we are building next.** Generalising the grounding skills so any clause set loads rather
> than one being hardcoded · extending the library beyond the two reference skills · isolation
> parity beyond Linux · more document classes · multi-user access, which real deployment requires and
> which is out of scope today · practitioner validation · **outcome measurement, where the method is
> defined and results are pending.**
>
> **Limitations.** Single-user · English-language · Linux-namespaced isolation, weaker elsewhere ·
> **the library ships with two specialised skills — breadth across other document classes is not yet
> built** · coverage limited to what is indexed · no production security hardening · the reference
> workflows are rehearsed demonstrations, **not a statistical benchmark.**

- **Dominant visual:** The **risk table** — it is the substance of the slide, and a table is correct
  here because risk and mitigation is a genuine one-to-one pairing. The **three-field join** appears
  as a small diagram inside the deployment block: a stack of heterogeneous boxes labelled only by
  *what they are* (workstation, server, Mac mini, laptop — deliberately unlabelled by model, because
  the point is that the hardware is irrelevant), bound to the workbench by three connectors reading
  **host · port · model name**. The "what's next" block sits last, in the lightest weight on the
  slide — it is a plan, and it should read as subordinate to what exists.
- **❌ Do NOT put here:** machine specs from internal planning documents, invented cost savings,
  hidden limitations, rupee figures without a source, or a mitigation phrased as a future intention.
- **Why it exists:** It answers attacks 4, 9, 11, 13 and 15, and candour here converts directly into
  credibility. **Every mitigation in that table is already implemented** — that is the line worth
  making, and it is auditable at the public repository.


### Slide 5 — IMPACT AND BENEFITS

*Template asks: potential impact on the target audience · benefits (social, economic, environmental,
etc.).*

- **Layout method: weighted tiers, no figure** (see Section L). Three full-width bands at
  deliberately unequal weight — Structural roughly twice the height of the other two, Wider lightest
  and labelled *directional*.
- **Purpose:** Show consequence honestly, making measurement discipline part of the claim.
- **Headline:** *"The impact is not faster typing — it is work that could not previously be done
  with AI at all."*

**On-slide copy — final, ~200 words. This is the complete text; do not add to it.**

> **Structural — true today, and requiring no number.**
> A class of work becomes AI-assisted that policy previously excluded entirely. Deliverables carry
> their evidence trail into the approval process rather than into a chat window. Unresolved field
> items are surfaced and routed rather than smoothed over. **The organisation keeps its documents,
> indexes and outputs** rather than transferring them to a third party.
>
> **Organisational — measurable; method defined, results pending.**
> Expert time redirected from transcription and formatting to judgement. Internal tooling
> maintenance reduced from manual debugging cycles. **Procedure knowledge captured as skills rather
> than left in individual heads** — an institutional asset that outlives staff turnover.
> *Method: baseline-and-compare across a defined pilot task set.* Results `[[MEASURE: …]]`.
> *Verifiable today:* three reference workflows verified end-to-end against deterministic oracles,
> with 42 test suites covering the agent loop, path containment, retrieval and end-to-end flows.
>
> **Wider — directional only.**
> Extending to further document classes is a matter of adding skills to a runtime that already
> composes them. A plant that already owns GPU-capable hardware needs no new cloud spend. Because
> the library is open, **another plant's skill for the same procedure can be reused rather than
> rewritten** — a design property, not a forecast.

- **Dominant visual:** **None, or the three-tier structure itself.** A number-free impact slide with
  a clear hierarchy is stronger than a slide of invented percentages. If a chart appears at all it
  belongs **only** in the Organisational tier and only once measured figures exist. **Do not
  illustrate this slide.** Weight the three tiers unequally so the reader always knows which is which:
  Structural full contrast, Organisational medium, Wider light and visibly marked *directional*.
- **❌ Do NOT put here:** invented statistics, user counts, adoption forecasts, cost savings,
  "national productivity", partnership or endorsement claims, any implication of government
  adoption, or unmeasured environmental claims.
- **Why it exists:** It answers the funding question without overclaiming, and the visible
  separation of tiers is itself a credibility signal.


### Slide 6 — RESEARCH AND REFERENCES

*Template asks: details/links of the reference and research work.*

- **Layout method: grid** (see Section L). Five labelled cells laid two-up then three-up, hairline
  rules only, no fills or icons, with the repository link set at its most legible.
- **Purpose:** Establish that the work is grounded in verified components **and sits in a real
  research conversation** — for a technical panel, citing the open problem is what makes the
  differentiation claim credible rather than assertive.
- **Headline:** *"Built on established open components, against a named open problem."*

**On-slide copy — final, ~230 words. This is the complete text; do not add to it.**

> **Why this vertical is hard.** The self-verification asymmetry between coding and enterprise work,
> and the open question of whether coding-agent harnesses generalise to business process · the role
> of **skill and tool libraries** in agent capability · **informed abstention** as a structured,
> auditable capability rather than a failure mode · and the finding that state-of-the-art models
> **systematically overcommit rather than abstain** under uncertainty — the precise failure mode
> that makes them unsafe in a regulated plant.
> `[[VERIFY: exact titles, authors, IDs and years — each reference must be personally opened before
> it is cited]]`
>
> **The project — `github.com/BITverse-24/agent`** · *public repository.* Two things an evaluator
> can verify there, because checkable is what makes a claim credible at this stage:
> **① the implementation** — `config/models.json` (the registry), `router/tool-compositor.ts` (the
> skill runtime), `harness/path-guard.ts` (containment), `backend/tests/` (42 suites);
> **② the technical blog** — installation, technical architecture, benchmarks and roadmap.
> *For a project whose wedge is openness, the licence is a primary reference, not a formality.*
> ⚠️ Confirm the intended licence before printing it.
>
> **Open-weight models.** The vision, reasoning and coding families used, with **licence noted per
> family** ⚠️ verify — licences differ between families.
>
> **Local inference runtimes.** Ollama, LM Studio, llama.cpp, MLX, vLLM and any server exposing an
> OpenAI-compatible `/v1` API. **Portability across runtimes is what makes model *and* hardware
> substitution configuration changes rather than integration projects.**
>
> **Retrieval and isolation.** The embedded local vector index; OS-level network namespace isolation;
> path containment by construction. **Application platform:** desktop shell, local persistence,
> document-generation libraries.

- **Dominant visual:** A **reference grid** in five labelled groups with hairline rules, laid out
  two-up or three-up so it fills the slide rather than running as a single column. No logos, no
  website screenshots, no long raw URLs — a citation is a name, a designation and a link, and for
  any standard the full designation and issuing body. Set the repository link visibly: it is the one
  element on this slide a judge is most likely to actually click.
- **❌ Do NOT put here:** blog posts, undated forum answers, AI-generated summaries, or **any
  reference the team has not personally opened.** Unverifiable references are worse than few, and on
  a slide a judge reads alone, a dead or wrong citation is the whole slide failing.
- **Why it exists:** It is where technical credibility is either confirmed or quietly lost, and it is
  the only place the judge can go deeper on their own initiative.


## H. Template compliance map

| Template slide | Mandated content | Satisfied by |
|---|---|---|
| 1 | Team details | Slide 1 — manual, per template |
| 2 | Idea/solution/prototype · how it addresses the problem · innovation and uniqueness | Slide 2, all six blocks; uniqueness in the closing block, defended in the gap and stem blocks |
| 3 | Technologies · methodology and implementation process · flow charts / working prototype | Slide 3 — stack, skill runtime, routing, containment, evidence |
| 4 | Feasibility · challenges and risks · mitigation strategies | Slide 4 — deployment, risk register, roadmap, limitations |
| 5 | Impact on target audience · social / economic / environmental benefits | Slide 5, three tiers |
| 6 | Research and references | Slide 6, five reference groups |

**Template discipline:** Slide 1 is entered manually and otherwise untouched. No slide discards,
crops, recolours or re-lays-out the template's master, headers, footers or page geometry. Any added
slide inherits the template's own layouts.

**If the format permits more than 5 authored slides**, the highest-value splits are:
(a) give the **positioning map** (Slide 2, Block 1) its own slide — it carries the differentiation
claim and is dense enough to need room; and (b) give the **product mockup** (Slide 3) a slide of
its own, so it can be shown at the size where its three elements — routing, transcript, and the
withheld sign-off — are each readable. It is the strongest single image available to the deck, and
it is the first thing that should be sacrificed to the word limit if space is tight.

---

## I. Pre-design checklist — resolve before any layout work

- **Hardening — nothing outstanding here.** GPU-neutral deployment was previously flagged as needing
  confirmation that a model swap applies without a restart. ✅ **Resolved:** endpoint bindings are
  persisted to the settings store (`persistence/settings-store.ts:17-23`) and restored dynamically
  on the next run, so a new device or model takes effect without restarting the application. No
  further work required.

1. ⚠️ **Generalise the two grounding skills.** `grounding/sop114-engine.ts` is hardcoded to one
   standard, which contradicts the entire thesis if an evaluator opens the repo. Either make the
   clause set an input, or state the specialisation honestly on the slide.
2. ⚠️ **Show one specialist skill concretely on Slide 3.** The thesis says domain skills are the
   product, but the deck currently describes the idea of a skill rather than showing one. Use
   `grounding/spec-compliance.ts` as it actually exists: name it, state what it takes in, what it
   produces, and — the part that answers "your skills are just prompts" — the rule that makes it
   *withhold* an approval when verification is incomplete. A judge reading alone has no presenter to
   supply this, so the deck must.
3. ⚠️ **Decide the skill format and state it precisely** — declared capability, typed I/O, explicit
   refusal conditions. Do not claim a community; claim extensibility as a design property.
4. ⚠️ **Verify every named competitor** in the positioning map from the vendor's own material.
5. ⚠️ **Open and confirm every research citation** in Group 1 — titles, authors, IDs, years.
6. ⚠️ **Decide the project's own licence** and state it on the references slide.
7. ⚠️ **Decide the retrieval technology.** "ChromaDB" is not true today — `ai/rag/db.ts` uses
   `vectra`. Accept "embedded local vector index (Vectra)" or add ChromaDB.
8. ⚠️ **Confirm platform support** (Linux-namespaced isolation only?) and state it plainly.
9. ⚠️ **Source one citable reference for the problem statement**, or remove the citation.
10. ⚠️ **Build the product mockup and get it reviewed by someone who has not seen the deck.** This
    is now the highest-leverage design task in the project, and the most likely place to look bad.
    It goes on Slide 3, large. Requirements: built from native Canva shapes in the template's type
    and colour; exactly three elements (routing indicator · agent transcript · output with citation
    and withheld sign-off); **every element must exist and work in the real application**; any value
    shown must come from a real run. No window chrome, no device frame, no shadow, no perspective.
    **If it cannot be made to look genuinely excellent, cut it — a mediocre mockup is worse than
    no mockup.**
12. ⚠️ **Measure or remove every outcome claim.** An unsourced number disqualifies the deck.

### Async-judging checks — do these last, after the content is final

13. ⚠️ **Read the deck cold, out of order, on a laptop.** Open only slides 2 and 3 and check the
    argument survives. Then jump to slide 5 and check it makes sense with no build-up. With ~500
    submissions and no presenter, this test predicts the score better than any other.
14. ⚠️ **Read only the headlines, in sequence, as a skim.** That sequence alone should reconstruct
    the argument. If any headline is a topic rather than a claim, rewrite it.
15. ⚠️ **Confirm slides 2 and 3 are self-sufficient.** They are the two a judge is guaranteed to
    read. Nothing essential may exist only on slides 5–7.
16. ✅ **Technical blog** — complete. Three slides reference it; confirm the link resolves publicly
    and that every benchmark it cites is a real measurement with its hardware and method stated.
    Section K remains the division-of-labour reference if the structure is revisited.
17. ⚠️ **Final visual audit before submission.** No raw screenshots anywhere. One product mockup,
    on one slide, at large size. Every element in it verifiable against the real application. No
    invented metric, latency, or control anywhere in the deck. No colour, font, or shape outside the
    template's own visual language. Read the deck cold and out of order on a laptop — see the
    async-judging checks above.
---

# PART III — THE COMPETITIVE BAR

> **The deck is one of ~500 submissions competing for the same problem statement, read on a judge's
> own device. Design quality is not decoration here — it is a selection criterion.**

**How judging actually works at this scale.** With 500 submissions, no judge reads all of them, and
most do not read any of them closely. The realistic funnel is: a judge opens the deck, spends a few
seconds per slide deciding whether it looks like a serious submission, and reads closely only what
survives that. Design quality therefore does two jobs — it is a genuine criterion, and it is the
mechanism by which a deck earns the attention needed for its argument to be heard at all.

**The two failure modes, and they are not the same risk:**

| Failure | What it looks like | What it costs |
|---|---|---|
| **Ugly** | Default layouts, inconsistent margins, five typefaces, gradients, clip art, a diagram that fights the template | Reads instantly as an amateur entry. Dies in the first five seconds, before the argument is considered. |
| **Dated** | Visually competent but built on 2015 template conventions — drop shadows, heavy rounded cards, centred everything, a title on every slide | Looks like a template that was filled in rather than a document that was designed. Subtle, and harder to recover from. |

**The standard this sets.** Restrained, institutional, information-dense, and typographically
excellent. The reference points are a well-set government technical document and a serious
consulting deliverable — **not** a startup pitch deck, and not a product landing page. Nothing that
would look out of place on a ministry desk should appear, and equally nothing that looks like it was
assembled from a template in ten minutes.

**Non-negotiables, in priority order:**

1. **One type family, two or three weights, one or two sizes per slide.** Hierarchy through size and
   weight, never through colour or decoration.
2. **A real grid.** Consistent margins on every slide, aligned edges, whitespace that is deliberate
   rather than leftover. Alignment is the single most visible sign of care, and its absence is the
   single most visible sign of carelessness.
3. **Restraint in colour.** The template's palette, used for meaning. If a colour does not encode
   status, hierarchy or category, it does not appear.
4. **Diagrams that carry information.** Every element in a figure must encode something. A diagram
   that could be reused unchanged on a different project is not finished.
5. **Consistency across all six authored slides.** The same type scale, the same margins, the same rule
   weights, the same footer. A judge who sees five slides before a small inconsistency begins to
   suspect the rest.
6. **No decorative anything.** No gradient, glow, glass, 3D, neon, illustration, stock photography,
   or icon used as a bullet. If an element could be deleted without losing meaning, delete it.

**And the one thing worth spending the most time on.** The product mockup on Slide 3 is the only
element in the deck that shows the product rather than argues about it, and it is the strongest
image available. It is also the most likely thing to look bad if built carelessly. **Build it
last, at the largest size it can occupy, and have it reviewed by someone who has not seen the deck.**
If it cannot be made genuinely good, cut it — a mediocre mockup costs more than no mockup, because
it advertises a weak product rather than a strong argument.
---

## J. The tired-judge test

> Applied at the end of the build, not now. **This is the test that predicts the score better than
> any other**, because it replicates the actual conditions: submission ~500, judge on their ~100th
> deck of the day, no presenter, own device.

**Two judges, one deck.**

| | The tired judge | The energetic judge |
|---|---|---|
| Reads | Headlines, then the first line of each block. Maybe slides 2 and 3 properly. | Everything, then opens the repo and the blog. |
| Needs | The claim inside three seconds of each slide opening | Depth, mechanisms, file paths, the roadmap |
| Will be hostile to | A wall of text, an unexplained diagram, a claim with nothing under it | A deck that oversells and under-delivers when checked |
| **What must therefore be true** | Every headline is a claim. Every block's first line is its point. Slide 2 carries the thesis alone. Nothing essential lives only on slides 5–7. | Every claim is checkable in the repository. Shipped and next are separated. The blog opens well cold. |

**The five specific things that lose a tired judge, checked one by one:**

1. **A headline that names a topic instead of a claim.** *"Technical Approach"* loses; *"Skills are
   code, not prompts"* holds. All five authored headlines are claims.
2. **A block that opens with context instead of its point.** Every block now opens with the point.
3. **More than one thing competing for attention on a slide.** Fixed — the positioning map was cut
   from slide 2 and the triptych from slide 3. Each slide now has exactly one focal point.
4. **A claim with nothing under it.** Every claim in the deck is either evidenced in the repository
   or explicitly marked as a plan. There is nothing a judge can call hollow.
5. **An unverified citation.** A dead or wrong reference on slide 6 fails the whole slide, and the
   judge who checks one and finds it broken discounts the rest. Every reference must be opened
   first.

**And the one thing that loses the energetic judge, which is the harder one to see:** a deck that
promises more than the repository contains. This is why shipped and next are separated on slide 4,
why no benchmark is claimed that has not been run, and why the mockup's one rule is that every
element in it must actually work. **The energetic judge is the one who opens the link — and they are
the ones worth winning.**

**The final read, in order:** skim the five authored headlines cold. If the argument does not reconstruct,
rewrite headlines. Then read slides 2 and 3 properly. Then read only the block-opening lines of 4
to 6. Then open the repository and the blog as a sceptic. If nothing falls out, the deck is ready.
---

## K. Technical blog specification

**Status: complete.** Three slides reference it, so two things still matter: the link must resolve
publicly, and every benchmark it cites must be a real measurement. The specification below records
the intended structure and the division of labour, for reference and in case it is revisited.

### What the division of labour is

| | The deck | The blog |
|---|---|---|
| Carries | The argument, the thesis, the differentiation, the evidence, the honesty about limits | The **mechanism**: how each part actually works, and why it was built that way |
| Depth | *What it is* and *that it works* | *How it works*, with code, diagrams, decisions and trade-offs |
| Audience | A judge scanning 500 submissions | A judge who has decided we are worth 15 minutes |
| Fails if | It reads like a source document | It reads like a build log |

**The line, stated precisely:** the deck says *skills are declared capabilities with a fixed schema
that the runtime composes from the environment.* The blog shows **the schema, the composition
function, a worked trace, and what happens when the environment changes.** Neither repeats the
other.

### Required structure

**1. What this is — the first screen, no scrolling.**
Two paragraphs and one image. What the project is, the problem it addresses, and why it is
different. **A judge who lands here and does not understand the project in 30 seconds will leave.**
This is the single highest-leverage page in the whole submission, and it is currently missing.

**2. Quick start — installation and first run.**
Prerequisites, the model download and provisioning procedure, starting the runtimes, the onboarding
wizard, and running one reference workflow end to end. **Include the offline provisioning order** —
checksum, transfer, disconnect — because that sequence is the deployment story and most projects
skip it. Screenshot-free is fine here; this page is for people who will actually run it.

**3. Architecture.**
The trust boundary and why it exists. The skill runtime: the capability schema, how the runtime
composes the tool surface from environment state, and the reasoning behind each decision. The
gateway: native tool calling, the fallback path, and why an OpenAI-compatible interface was chosen.
The retrieval path: chunking, embedding, and why a local index rather than a service. Diagrams
carrying real information, not boxes-and-arrows.

**4. The reference workflows.**
All three, in full — inputs, the agent trace, the tool calls, the failure and self-correction where
it occurs, and the outputs. **This is where the triptych cut from slide 3 lives**, and where the
positioning map cut from slide 2 belongs.

**5. Sovereignty and threat model.**
The three containment layers. What the sandbox does and does not guarantee, stated honestly,
including the Linux-only limitation. What an attacker who controlled the model prompt could and
could not reach. How the packet-capture evidence is produced. **This page should be the most
candid in the blog** — a judge looking for overclaiming will test here, and candour is what wins them.

**6. Benchmarks.**
Latency and throughput per task type, extraction accuracy against the reference fixtures, memory
footprint, and the hardware each figure was measured on. **Every number must be a measurement
actually performed, with the method and the machine stated.** If a figure has not been measured, it
does not appear — an empty benchmarks section with a stated method is far better than an
unverifiable table, and a fabricated figure here would discredit the repository entirely.

**7. Roadmap.**
The `🔜 Next` table from Section E.2, in full, with the reasoning for each item and what would count
as done. Honest sequencing beats an ambitious timeline.

**8. Contributing — the extensibility story.**
The skill format, what makes a skill acceptable, and how a plant adds its own against its own SOPs.
**State plainly that no community exists yet.** The claim is that the format is designed for
extension and that the runtime demonstrably composes skills from the environment — which is a
design property we can show, not a forecast about other people.

### Two rules for the blog

- **Every benchmark is a real measurement, with the hardware and method stated.** This is the single
  biggest credibility risk in the submission.
- **The first screen explains the project to a stranger.** A judge arrives cold, with no presenter,
  having already seen a hundred submissions.
---

## L. Per-slide layout methods

**Why each slide gets a different structure.** Seven slides in one frame would be consistent and
forgettable. The system is fixed; the **arrangement within it varies by the job the slide has to
do** — argue, explain, prove, reassure, substantiate, close. A judge who notices each slide is
built to do something different has read a designed document, not a filled template.

| Slide | Method | The structural idea |
|---|---|---|
| 2 — Solution | **Claim stack + hero figure** | Seven blocks descending in weight, T dominant on the right |
| 3 — Technical | **Figure-led split** | Mockup takes two-thirds; the frame breaks deliberately |
| 4 — Feasibility | **Table-anchored** | Risk table is the anchor; everything else supports it |
| 5 — Impact | **Weighted tiers** | Three tiers, unequal weight, no figure |
| 6 — References | **Grid** | Five grouped cells, dense, link set visibly |
| 7 — Close | **Single statement** | One line, centred, nothing else |

### Slide 2 — Claim stack with a hero figure

**The job:** carry the entire argument. The method is **descending weight** — the first block is the
thesis, and each subsequent block is shorter and more concrete, so the eye is guided down the column
and the argument tightens as it goes.

- **Left column (55%)** — six blocks, but *not* equal. **The gap** and **What we built** carry
  roughly equal space; the later blocks (Runs inside the perimeter, Uniqueness, Status) compress to
  three lines each. The compression is the point: it says "these matter less" without saying so.
- **Right column (40%)** — the T, occupying the full column height, vertically centred against the
  block stack rather than aligned to its top. **Centring it against the column, not the slide, is
  what makes it read as a figure rather than a banner.**
- **Why it works:** a judge can stop after block two and still have the thesis, the product, and the
  differentiation. Everything below is confirmation.

### Slide 3 — Figure-led split, and the one deliberate break

**The job:** prove it exists. The method inverts the frame — the **mockup takes two-thirds**, and
the text column is reduced to compact labelled blocks beside it.

- **Right two-thirds** — the mockup, full height, the single largest element in the deck.
- **Left third** — The stack, The skill runtime, Routing, Containment, Evidence. Tighter leading
  than slide 2; this is reference material a judge scans, not prose they read.
- **Bottom strip** — the agent loop as a five-node process, spanning the width beneath both, with the
  precondition node drawn as a gate.
- **Why the frame breaks here and only here:** one break in a consistent system reads as emphasis.
  The mockup is the thing that wins slide 3, and the layout says so before a word is read. **If the
  mockup is ever cut, restore the standard frame** — a broken frame with no figure is just a mistake.

### Slide 4 — Table-anchored

**The job:** convert uncertainty into credibility. The method is **anchor and support** — one
object carries the slide and everything else is subordinate to it.

- **Centre, full width** — the risk table. Five rows, two columns, hairline rules, no fills. It sits
  where the figure normally would, but it is a table: this is the one slide where a table is the
  right form, because risk and mitigation is a genuine one-to-one pairing.
- **Above the table** — Deployment, as a short two-paragraph block. The three-field join appears as
  a small inline diagram within it, not as a separate figure.
- **Below the table** — What we're building next, then Limitations. **Both in lighter weight than
  anything above them**, and separated from the table by whitespace rather than a rule, so the
  reader registers them as commentary, not content.
- **Why it works:** the table's `Mitigation — implemented, in the repository` column header is the
  argument. A judge reads the header once and then scans the right-hand column, seeing five
  implemented controls without reading a word of the left.

### Slide 5 — Weighted tiers, and no figure at all

**The job:** show consequence without overclaiming. The method is **deliberate inequality of
weight**, and the absence of a figure is itself the design decision.

- **Three horizontal bands, stacked, full width** — Structural, Organisational, Wider.
- **The weights differ, and visibly:** Structural at full contrast and roughly twice the height of
  the other two, because it is the only tier requiring no measurement. Organisational at medium
  weight. Wider at light weight, explicitly labelled *directional*.
- **No chart, no figure, no illustration.** A number-free impact slide with a clear hierarchy is
  stronger than a slide of invented percentages — and in a field where most submissions will show a
  bar chart of made-up savings, an honest unillustrated slide is conspicuous.
- **Why it works:** the weight difference is the credibility signal. A judge can see which claims
  are evidenced and which are pending without reading a word.

### Slide 6 — Grid

**The job:** substantiate, and be verifiable. The method is a **five-cell grid**, dense and
deliberately unfussy.

- **Five labelled cells** — Why this vertical is hard · The project · Models · Runtimes · Retrieval
  and platform. Laid **two-up then three-up**, filling the slide rather than running as one column.
- **Hairline rules only.** No fills, no boxes, no icons. This slide should look like a references
  page in a technical report, because that is what it is.
- **The repository link set visibly** — it is the one element on this slide a judge is most likely
  to click, so it gets the most legible treatment on it.
- **Why it works:** density is the point. A sparse references slide signals the work is thin; a
  dense, orderly one signals the opposite, and rewards the judge who reads it.
