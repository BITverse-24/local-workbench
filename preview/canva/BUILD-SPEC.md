# SIH2026 — Canva Build Spec
## Sovereign Workbench · Design `DAHWelgTt2s` · "McKinsey + Govt"

Complete, self-contained build instructions. Every number below is either measured
from the template or verified against the codebase. **Build pages 2–5 only.**

---

## 0. Before you start

| | |
|---|---|
| Design | `DAHWelgTt2s` — "SIH2026", 6 pages, 1920 × 1080 |
| Edit | **Pages 2, 3, 4, 5** |
| Leave alone | **Page 1** (title) and **Page 6** (references) |
| Method | **Native Canva shapes and text only. No images, no generated graphics, no icons.** |
| Team name | `unpaid_interns` — replaces "Your Team Name" in the top-left circle on pages 2–5 |
| PS ID | `26117` (page 1 only — leave as is) |

> **Content disclaimer to carry through:** two figures in the mockup on page 3
> (`2.1 mm`, the clause reference) are **illustrative placeholders showing shape
> and emphasis**. Replace with values from a real run before submission.

---

## 1. Template facts (measured, do not re-derive)

| Element | Position (top, left) | Size (w × h) | Type |
|---|---|---|---|
| Title block, page 2 | 0, 28.8 | 1728 × 180 | SHAPE |
| Title block, pages 3–6 | −7.5, 96 | 1728 × 180 | SHAPE |
| Body text, page 2 | 330, 7.6 | 1900.8 × 411 | TEXT |
| Body text, pages 3–5 | 403.8, 105.6 | 1458.8 × 268/201 | TEXT |
| Footer text | 1001, 732 | 504.6 × 57.5 | SHAPE |
| Page number | 1001, 1376 | 448 × 57.5 | SHAPE |
| Team-name circle | 37.7, 49.9 | 201 × 131 | SHAPE |
| SIH logo (top-right) | 0.24, 1540 | 354 × 167 | SHAPE (image fill — **keep**) |

**Content band — build inside this, nothing else:**
```
left 105      right 1564      width 1459
top  200      bottom 980      height 780
```
The logo occupies x 1540–1894, y 0–167. **Keep clear of it.**

**Do not delete:** SIH logo, blue footer bar, page numbers, team circle.
**Replace:** the title SHAPE text, the body TEXT box, "Your Team Name".

---

## 2. Design system

### 2.1 Palette
Derived from the template's own footer blue, which was sampled from the page
thumbnail: **`#0070C0`**.

| Token | Hex | Where used |
|---|---|---|
| `ink` | `#14181D` | Headlines; table header fill |
| `navy` | `#003A70` | Card top-rules, labels, T bar fill, strong blocks |
| `blue` | `#0070C0` | **Template blue** — hairlines, rules, secondary accent |
| `steel` | `#5A6B7B` | Secondary text, light rules |
| `mist` | `#EEF3F7` | Tinted card fill (tier 2, grey cards) |
| `line` | `#D6DEE5` | Hairlines, card borders |
| `flag` | `#A32D26` | Refusal / risk / NOT APPROVED — **maximum once per slide** |
| `paper` | `#FFFFFF` | Ground |

**Colour discipline:** `flag` appears at most once per slide. `navy` and `blue`
are the only brand colours — no new hues. No gradients anywhere.

### 2.2 Typography
One family throughout: **Inter** (or **IBM Plex Sans**). Weights **400 / 600 / 700 only**.
Hierarchy comes from size and weight, never from a second font.

| Element | Size | Weight | Case |
|---|---|---|---|
| Slide headline | 34 | 700 | sentence case |
| Card title | 15 | 700 | sentence case |
| Section label | 12 | 700 | ALL CAPS, +80 tracking |
| Body | 13 | 400 | sentence case |
| Micro / chip | 11 | 400–600 | as needed |
| Table cell | 12 | 400 | sentence case |
| Footer | 10 | 400 | keep template's |

**Never below 10pt.** Sentence case everywhere except the section labels.

### 2.3 Component rules

**Card** — the primary unit. White fill, 1px `line` border, **3px `navy` top rule**.
Padding 14px internal. Card title 15/700 in `ink`, then contents.
*Grey variant:* top rule `steel` instead of `navy`, used for roadmap/limitations.

**Fragment list** — short dash-led lines inside a card. Not sentences.
Prefix: a 7 × 1.5px `navy` rule, 12px indent. Line height 1.35.

**Key–value rows** — for the T breakdown and containment. Label in `navy` 700/11
caps (110px fixed column), value in `steel` 400/11. Hairline between rows.

**Chip** — 1px `line` border, `mist` fill, 10/400 `steel`, 5px 7px padding.
For technologies only. No icons inside.

**Hairline** — 1px `line`. The only divider permitted. No shadows, no double rules.

**T-intro caption** — 11/700 `steel`, ALL CAPS, +80 tracking, centred above the T.

### 2.4 Global prohibitions
No shadows · no gradients · no 3D or perspective · no glow · no rounded corners on
cards · no decorative icons · no clip art · no images of any kind · no emoji ·
no more than one `flag` element per slide · no text below 10pt.

---

## 3. Page 2 — PROPOSED SOLUTION

**Method:** claim stack + hero figure. Four cards left, the T right, a three-claim
strip across the bottom.

### 3.1 Title
Title SHAPE → `PROPOSED SOLUTION`

### 3.2 Delete and rebuild
Delete the body TEXT box entirely. Build the following.

### 3.3 Left column — four cards, stacked
Origin **x 105, y 200**. Width **1079**. Height **183** each, vertical gap **16**.
So: card A (105,200) · card B (105,399) · card C (105,598) · card D (105,797).
Total = 4 × 183 + 3 × 16 = **780**, exactly filling the band.

> **If a card's content overflows**, raise that card's height and reduce the
> others — the stack must end at y 980. Do **not** reduce type below the 2.2 scale,
> and do **not** drop a fragment.

#### Card A — "The gap"
*Rule · 4 fragments*
- Coding agents got good from **skills** — not from smarter models
- Regulated engineering work has the same need, **none of the library**
- Closed platforms ship their own — welded shut, one customer at a time
- The result: work is done manually, or confidential material is pasted into a public tool

#### Card B — "The T — breadth, then one deep stem"
*3 key–value rows*
| Label | Value |
|---|---|
| **Breadth** | Document review · drawing checks · data analysis · scripting |
| **Depth** | **Inspection reports, drawings, approval notes** — judged against internal SOPs |
| **Routed by** | Rule, not model — to the right local model every time |

#### Card C — "The stem is the product"
*Rule · 3 fragments*
- Every conclusion bound to **source · page · governing clause**
- Consequential actions **pause and route** to a human
- **"Insufficient evidence" is a valid output** — a withheld sign-off is a successful run

#### Card D — "Open, and inside the perimeter"
*Rule · 3 fragments*
- **You cannot audit what you cannot read** — a PSU cannot accept a closed tool for pressure-equipment sign-off
- Every endpoint is a registered internal address
- **Zero external requests — demonstrated, not promised**

### 3.4 Right column — the T (the hero figure)
Origin **x 1224, y 210**. Total width **340**. **Must not exceed x 1564.**

```
┌────────────────────────────────┐   NAVY FILL (bar)
│ GENERALIST SKILLS — THE     │   11/700 white, +80 caps, centred
│ BREADTH                     │
│ ┌──────┐┌──────┐┌──────┐   │   chips: 1px rgba(255,255,255,.34) border,
│ │read  ││find  ││compute│  │   transparent fill, white 10/400
│ └──────┘└──────┘└──────┘   │
│ ┌──────┐┌──────┐┌──────┐   │
│ │show  ││prod. ││say   │   │
│ │working││file ││unsure│   │
│ └──────┘└──────┘└──────┘   │
└────────────────────────────────┘
┌────────────────────────────────┐   2px NAVY border, no top border
│ SPECIALIST LIBRARY — THE       │   joins the bar above
│ DEPTH                        │   11/700 navy, +80 caps, centred
│ ① Extract evidence — scans,     │   11.5/400 steel, 28px numeral indent,
│   drawings, tabular data       │   10×10 navy square badge, white numeral
│ ② Retrieve the governing        │
│   clause — local index         │   hairline between rows
│ ③ Compare — value against       │
│   the limit                    │
│ ④ Decide — supported ·         │
│   conditional · not approved   │
│ ⑤ REFUSE if the evidence       │   ← flag red text + flag red badge.
│   is incomplete                │     THE one flag on this slide.
└────────────────────────────────┘
        All the depth sits in one place.      10.5 italic steel, centred
```
**Bar:** navy `#003A70` fill, full 340 width, height **150**.
**Stem:** full 340 width, height **330**, directly beneath the bar.
Total 480, from y 210 to y 690 — inside the band, clear of the footer.

The stem must be **visibly deeper than the bar is tall** — 330 against 150 — because
that asymmetry *is* the argument. Connect bar to stem with no gap: shared edge, the
stem's 2px border has no top border so the two read as one T.

### 3.5 Bottom strip — three claims
Origin **x 105, y 850**. Width 1459, height 90. A 2px `ink` rule across the top.
Three equal columns, each: **label 9.5/700 navy ALL CAPS +80** then **text 11/400 steel**.

| Label | Text |
|---|---|
| UNIQUENESS | An open, plant-extensible skill library for regulated engineering work |
| ENFORCED, NOT REQUESTED | Skills forbid a conclusion lacking a clause — in code, not prose |
| STATUS | 3 reference workflows verified end-to-end · 42 test suites |

### 3.6 What must NOT be on this page
Model names · technology lists · screenshots · the word "platform" · feature grids ·
arrow spaghetti · the reference workflows · any table.

---

## 4. Page 3 — TECHNICAL APPROACH

**Method:** figure-led split. **The one deliberate break in the frame** — the
mockup takes the right two-thirds. This page proves the thing exists.

### 4.1 Title
Title SHAPE → `TECHNICAL APPROACH`

### 4.2 Left column — four cards, stacked
Origin **x 105, y 200**. Width **600**. Height **181** each, gap **12**.
Total 4 × 181 + 3 × 12 = **760**, ending at y 960 — inside the band.
*This column is the tightest on the page. If a card overflows, shorten its text
before touching the height or the type size.*

#### Card 1 — "The stack" — **chips only, no prose**
Chips, 10/400, wrapping within 600 − 28 padding:
`Electron` · `React` · `TypeScript` · `supervised agent loop` · `native tool calling` ·
`open-weight models` · `local runtimes` · `config-bound registry` · `vector retrieval` ·
`SQLite · run-scoped` · `Word · Excel · PDF` · `network-namespace sandbox`
Render the first three (`Electron` `React` `TypeScript`) in `navy` 600 to mark the shell.

#### Card 2 — "The skill runtime" — 4 fragments
- A skill = **fixed schema · executable procedure · stated refusal conditions**
- The runtime **composes skills from the environment** — never offers what is absent
- OpenAI-compatible interface ⇒ **model swap is configuration, not a project**
- Routing is **deterministic, not a model** — the route decides which model sees sensitive data

#### Card 3 — "One skill, as implemented" — 3 fragments
- **Compliance audit** — measures, retrieves the clause, compares to the limit
- **Withholds sign-off when a gap is open**
- Cannot conclude without a retrieved clause — **enforced in code, not prose**

#### Card 4 — "Containment — three layers" — 3 key–value rows
| Label | Value |
|---|---|
| By construction | Internal endpoints only, no telemetry |
| By containment | OS network namespace · **Linux-specific** |
| By evidence | **Packet capture outside the app** — the only layer not self-reported |

### 4.3 Right — the product mockup (the hero figure)
Origin **x 745, y 200**. Width **819**. Height **560**.
**Built entirely from native rectangles and text. No image.**

```
┌────────────────────────────────────────────────────────┐ INK #14181D fill
│ Sovereign Workbench          ● Air-gapped · zero egress │ white 11/700 + 9.5/600
├────────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────────┐ │ NAVY fill
│ │ ROUTED TO  compliance · vision    by rule · 2 docs │ │ white 9.5 caps + 12.5/700
│ └────────────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────────────┐ │
│ │ PLAN      Extract findings across both reports,    │ │ row label 9/700 navy caps
│ │           retrieve the clause, synthesise          │ │ 66px col; hairline between
│ ├────────────────────────────────────────────────────┤ │
│ │ EXTRACT   6 pages · 1 handwritten annotation kept │ │
│ │           as evidence                              │ │
│ ├────────────────────────────────────────────────────┤ │
│ │ RETRIEVE  Clause found in the local index —        │ │
│ │           no external lookup                       │ │
│ └────────────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────────────┐ │ 2px FLAG border
│ │ DECISION PACKET                                    │ │
│ │ Measured wall thickness      2.1 mm                 │ │ ← PLACEHOLDER VALUE
│ │ Against allowable           below limit            │ │ ← FLAG text
│ │ Open field item             1 unresolved            │ │
│ │ ─────────────────────────────────────────────────  │ │ 2px flag rule
│ │ STATUS                             NOT APPROVED     │ │ 14/700 flag — biggest text
│ └────────────────────────────────────────────────────┘ │   in the figure
└────────────────────────────────────────────────────────┘
```
**Key–value rows inside the packet:** label `steel` 11 left, value `ink` 600 right.
**`NOT APPROVED` is the single most important element on this page** — it should be
the largest text in the mockup and the first thing the eye lands on after the headline.
A small green dot `#5FC08A` sits beside the air-gap seal.

### 4.4 Agent-loop strip, beneath the mockup
Origin **x 745, y 790**. Five boxes, each `steel` 10.5/600 white fill, 9px 11px padding,
joined by 2px `steel` 18px connectors:

`classify` → `plan` → **`precondition gate`** → `act` → `observe`

The **gate box is `navy` fill** — it is the governance control, and must read as
the thing the flow must pass through. Beneath, 10/400 `steel`, centred:
`↺ observe feeds back to act — self-correction on real results`

### 4.5 What must NOT be on this page
Source file paths · class names · version numbers · database schema · click-by-click
demo instructions · tables · screenshots.

---

## 5. Page 4 — FEASIBILITY AND VIABILITY

**Method:** table-anchored. The risk table is the anchor; everything else supports it.
**The column header is the argument — a judge reads it once, then scans that column.**

### 5.1 Title
Title SHAPE → `FEASIBILITY AND VIABILITY`

### 5.2 Top-left — deployment card
Origin **x 105, y 200**. Width **700**, height **150**. *3 fragments*
- **Single device** for a pilot · **distributed** across whatever mixed hardware the organisation owns
- Every workspace operation is **path-contained**; consequential actions need explicit human authorisation
- Open source, zero licence — **the agent proposes, the operator disposes**

### 5.3 Top-right — the three-field join
Origin **x 840, y 195**. Width **720**.

```
┌────────┐┌────────┐┌────────┐┌────────┐   four 66×38 boxes, ink fill,
│workstn ││ server ││Mac mini││ laptop │   white 9.5/400 centred
└────────┘└────────┘└────────┘└────────┘
                    │ 1px steel, 11px
          ┌───────────────────────┐        navy fill, white 11/700:
          │  Sovereign Workbench  │        "Sovereign Workbench"
          └───────────────────────┘
                    │
      ┌─────────┐┌──────┐┌──────────────┐   three outlined boxes,
      │  host   ││ port ││  model name  │   1.5px NAVY border,
      └─────────┘└──────┘└──────────────┘   9/700 navy ALL CAPS
```
Below, 9.5/400 `steel`, centred, max width 640:
`any OpenAI-compatible /v1 API — Ollama · LM Studio · llama.cpp · MLX · vLLM`

### 5.4 The risk table — the anchor
Origin **x 105, y 390**. Width **1459**. Caption above, 9.5/700 `navy` ALL CAPS +80:
`RISKS, AND WHAT IS ALREADY BUILT AGAINST THEM`

**Header row — reversed, 8px vertical padding:**
| Cell | Fill | Text |
|---|---|---|
| Risk (38% width) | `ink` | white 9/700 ALL CAPS |
| Mitigation | **`navy`** | white 9/700 ALL CAPS — **"Mitigation — implemented, in the repository"** |

**5 body rows.** Cell padding 7px vertical. Cell text 10.5/400 `steel`, first column
`ink` 600. Hairline `line` below each row. Zebra: even rows on `mist`.

| Risk | Mitigation — implemented, in the repository |
|---|---|
| Model quality below threshold on available hardware | Task classes scoped per deployment; a stronger model bound via the registry, no code change |
| Model host unreachable mid-run | Run halts with a visible reason — **no external fallback exists by design** |
| Isolation not enforced off Linux | Namespace isolation is Linux-specific and stated as such; the fallback is workspace-locked and time-bounded |
| Model-authored code affecting the host | Read-only inputs, run-scoped writable output, wall-clock timeout, capped output |
| Evaluation-day network or hardware failure | Reference workflows run against pre-validated inputs with deterministic oracles |

### 5.5 Bottom — two grey cards
Origin **y 760**, height **195**. Card 1 **x 105 w 715**, card 2 **x 840 w 715**.
Both use the **grey card** variant (steel top rule).

**Card 1 — "What we are building next"** · 4 fragments
- Grounding skills **generalised** — any clause set, not one hardcoded
- Library extended beyond two skills · isolation parity beyond Linux · more document classes
- Multi-user access · practitioner validation
- **Outcome measurement — method defined, results pending**

**Card 2 — "Limitations"** · 5 fragments
- Single-user · English-language
- Linux-namespaced isolation, **weaker elsewhere**
- **Library ships with two specialised skills** — other document classes not yet built
- Coverage limited to what is indexed · no production security hardening
- Reference workflows are **demonstrations, not a statistical benchmark**

### 5.6 What must NOT be on this page
Machine specs from internal planning docs · invented cost savings · hidden limitations ·
rupee figures without a source · any mitigation phrased as a future intention.

---

## 6. Page 5 — IMPACT AND BENEFITS

**Method:** weighted tiers, **no figure at all**. The unequal weight tells the judge
which claims are evidenced and which are pending *before they read a word*.

### 6.1 Title
Title SHAPE → `IMPACT AND BENEFITS`

### 6.2 Three tier cards
Origin **x 105, y 210**. Width **1459**. Heights **260 / 230 / 130**, gaps **16**.

#### Tier 1 — "Structural" — **NAVY FILL** · the heavy one
- Header: `01` in `rgba(255,255,255,.6)` 11/700 · title `STRUCTURAL` 12.5/700 white
  ALL CAPS +80 · qualifier `demonstrable today — requires no number` 9.5 in
  `rgba(255,255,255,.7)`
- Four bullets, 12/400 `rgba(255,255,255,.88)`, key phrases in **white 600**:
  - A class of work becomes AI-assisted that **policy previously excluded entirely**
  - Deliverables carry their **evidence trail into the approval process**, not a chat window
  - Unresolved field items are **surfaced and routed**, not smoothed over
  - The organisation **keeps its documents, indexes and outputs**

#### Tier 2 — "Organisational" — **MIST FILL**
- Header `02` steel · `ORGANISATIONAL` 11/700 navy · `measurable — method defined, results pending`
- Three bullets, 12/400 `steel`:
  - Expert time redirected from **transcription to judgement**
  - Internal tooling maintenance reduced from manual debugging cycles
  - **Procedure knowledge captured as skills** — an asset that outlives staff turnover
- Footnote, 10.5/400 `steel`, hairline above, 8px padding:
  `Method: baseline-and-compare across a defined pilot task set.  Results pending — not yet measured.`
  → the words **Results pending** in `flag`. *(This is the one flag on this page.)*

#### Tier 3 — "Wider" — **OUTLINE ONLY**, border `line`, no fill
- Header `03` `steel` · `WIDER` 11/700 `steel` · `directional only — not a forecast`
- Two bullets side by side, 11/400 `steel`:
  - Further document classes = adding skills to a runtime that already composes them
  - Because the library is open, **another plant's skill can be reused, not rewritten**

### 6.3 What must NOT be on this page
Invented statistics · user counts · adoption forecasts · cost savings · "national
productivity" · partnership or endorsement claims · any implication of government
adoption · unmeasured environmental claims · **any chart or illustration**.

---

## 7. Final checklist before submitting

- [ ] Team circle on pages 2–5 reads `unpaid_interns`
- [ ] SIH logo, blue footer bar and page numbers intact on every page
- [ ] Pages 1 and 6 untouched
- [ ] No image used anywhere — all native shapes and text
- [ ] No shadow, gradient, 3D, glow, or rounded card corner anywhere
- [ ] No text below 10pt
- [ ] `flag` red appears **at most once per slide**
- [ ] Mockup values on page 3 replaced with real run values, **or** knowingly left as illustrative
- [ ] Open licence confirmed before printing on page 6 (if you do populate it)
- [ ] Read the deck cold, out of order, on a laptop — slides 2 and 3 must stand alone

---

## 8. Fact base — every claim verified against the repository

| Claim | Evidence |
|---|---|
| 4 model roles, OpenAI-compatible | `config/models.json` |
| Ollama · llama-server · MLX runtimes | `shared/contracts.ts` |
| Native tool calling + schema fallback | `gateway/model-gateway.ts` |
| Skills composed from environment | `router/tool-compositor.ts` → `composeTools()` |
| 6 specialist capabilities | `tools/specialist-tools.ts` |
| Path containment | `harness/path-guard.ts` |
| Linux namespace isolation (`--unshare-net`) | `harness/tools/run-command.ts` |
| External-request counter | `model-gateway.ts` |
| `NOT APPROVED` output | `run/manager.ts`, `grounding/spec-compliance.ts` |
| Host/port/model onboarding | `ipc/onboarding-handlers.ts` (`/v1/models` → `/models`) |
| 42 test suites, 3 e2e | `backend/tests/` |
| 12 machine-checkable oracles | `demo/flow_{a,b,c}/*.json` |
| Offline fixture validator | `demo/validate_fixtures.py` |
| Local vector index | `ai/rag/` — **Vectra, not ChromaDB** (`chromadb` is not a dependency) |
