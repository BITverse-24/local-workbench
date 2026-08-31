# PRODUCT.md — Sovereign Workbench

## 1. One-liner

A self-hosted, air-gapped, multi-model agentic AI desktop app for industrial/PSU/defence knowledge work — the only one that **proves** model auto-routing and zero external egress live, instead of just claiming them.

## 2. Problem

Refineries, PSUs, and defence-linked manufacturing generate routine knowledge work (approval notes, engineering calcs, scanned inspection reports, internal code, correspondence) that can't touch cloud AI because the underlying data is confidential. Result: either manual work, or staff quietly pasting confidential material into public tools anyway. Open-weight models are now good enough to close this gap, but no deployable, agent-capable, multi-model, air-gapped product exists that industrial users can actually work with.

## 3. Vision

An assistant that behaves like Codex/Claude for internal industrial work — plans, uses tools, produces real deliverables (Word/Excel/code) — but runs entirely on hardware the organization owns, routes each task to whichever open-weight model is actually suited to it, and can *show*, live, that no data ever leaves the premises.

## 4. Primary persona (for demo)

**Plant engineer / approvals officer**: receives a scanned inspection report, needs to draft a formal approval note grounded in the org's SOPs, without retyping everything or sending the scan anywhere external.

Secondary persona: **internal tooling developer** who wants a coding assistant that can execute and verify code without a cloud API.

## 5. The USPs (in priority order)

These are the things a competing "local RAG chatbot" will *not* have. Everything else in this doc exists to make these credible.

1. **Verifiable model auto-routing.** The system classifies each incoming task and automatically dispatches it to a different model suited to that task type (vision/OCR, general drafting, code) — and *shows this happening* via a live routing badge in the UI. Not a user-facing dropdown. Not one model doing everything with different prompts.
2. **Live sovereignty proof.** A permanently visible panel shows real network activity (or the deliberate absence of it) for the entire session — an allowlist of the team's own LAN boxes, a running counter of external requests (must stay at zero), and a demo-able "blocked" event if an outbound call is attempted. This directly answers the PS requirement that the sovereignty claim be *proven*, not stated.
3. **One flawless end-to-end agentic flow** (see Flow A below) that ties routing, OCR, RAG grounding, and a real deliverable file together in a single narrative — this is the *proof point* for the USPs above, not itself the differentiator.

## 6. Scope

### In scope (build this)
- Model registry: config file (task type → model endpoint), 3 models total, one per dedicated LAN box
- Router: automatic task classification (file type + lightweight intent check), not manual selection
- Agent orchestrator: plan → tool call → observe → repeat, with every step streamed to the UI as a visible transcript
- Tools: file read/write, OCR/vision call, `.docx`/`.xlsx` generation, sandboxed Python execution (no network), local vector search (RAG) over a small curated document set (10–30 docs)
- Sovereignty dashboard: live connection monitor + always-visible "0 external requests" badge, with a demo-able block event
- Electron desktop shell: chat pane, live agent-step transcript, artifact preview pane
- RAG citations surfaced in generated documents (e.g. "grounded in SOP-114 §3.2")

### Out of scope (explicitly do not build)
- General/robust handwriting OCR — demo on clean/typed scans only; handwriting is roadmap
- PowerPoint generation — bonus-only if time remains after Flow A and B are solid
- Multi-user auth, roles, enterprise deployment/ops tooling
- Large/general-purpose knowledge base — curated demo corpus only
- More than one sandboxed language (Python only)
- A model registry that's *actually* infinitely pluggable — it must *look* config-driven and extensible in the pitch; don't over-engineer the plugin mechanism itself
- Any live/improvised generative step during the finals demo — flagship flows run on pre-tested, fixed sample inputs only

## 7. Primary user flows

### Flow A — Inspection report → approval note (flagship)
1. User drops a scanned inspection report (image/PDF) into the app.
2. Router detects a scanned-document task → routes to the vision/OCR model. Badge updates.
3. OCR/vision model extracts text and key findings (structured output).
4. Agent queries the local RAG index for the matching SOP/approval-note template.
5. Router switches to the general drafting model. Badge updates.
6. Agent drafts the approval note, citing the retrieved SOP section.
7. Tool call generates a `.docx` file; it renders in the artifact preview pane.

### Flow B — Data/coding task
1. User asks for a script-based task (e.g. "flag out-of-range readings in this CSV, generate a summary").
2. Router detects a coding task → routes to the code model. Badge updates.
3. Agent writes the script, executes it in the sandboxed container (no network), captures stdout/stderr and exit code.
4. Result (and optionally a generated `.xlsx`) appears in the artifact pane.

Both flows run continuously against the visible sovereignty panel, which must show zero external requests throughout.

## 8. System components (product-level contracts)

| Component | Responsibility | Not responsible for |
|---|---|---|
| **Model Registry** | Config mapping task type → model endpoint (host:port) | Model training, quantization tooling |
| **Router** | Classify incoming task, pick a registry entry, emit the routing event the UI badges on | Generating any content itself |
| **Agent Orchestrator** | Run the plan→act→observe loop, call tools, stream each step | Model serving, sandboxing internals |
| **Tools** (file I/O, OCR, docx/xlsx gen, sandbox exec, RAG search) | One well-defined job each, callable by the orchestrator with a fixed schema | Deciding *when* they're called (that's the orchestrator) |
| **Sovereignty Dashboard** | Poll and display real connection state, maintain the allowlist, log/flag anything outside it | Actually being a firewall (pair with a real iptables/OS-level rule) |
| **Artifact Preview Pane** | Render/download generated files | Editing generated files in-app (out of scope) |
| **Desktop Shell (Electron)** | Host the renderer, forward orchestrator events over IPC | Any model or business logic — kept thin |

## 9. Deployment topology (finals hardware)

No dedicated GPUs — one model per machine over LAN, orchestrator kept model-free for responsiveness.

| Machine | Role |
|---|---|
| M4 Mac Mini 16GB | Vision/OCR model |
| i7 16GB (#1) | General drafting/reasoning model |
| i7 16GB (#2) | Coding model |
| i7 16GB (#3) | Orchestrator, RAG index, sandbox host, Electron backend |
| i5 11th-gen 16GB | Embedding model + network-monitor collector |

Sovereignty dashboard's allowlist = exactly these five LAN IPs. Anything else contacted = visible failure state.

## 10. Definition of done (finals)

Maps 1:1 to the PS's "Expected Solution":

- [ ] Model auto-selection visibly demonstrated across ≥2 task types (Flow A + Flow B)
- [ ] End-to-end agentic task: scanned report → extracted findings → drafted `.docx` approval note
- [ ] Coding task run and verified inside the sandbox
- [ ] Multimodal (image/scanned-doc) understanding demonstrated
- [ ] Live proof of zero external calls for the full session, including a demonstrated block event
- [ ] RAG citation visible in the generated approval note

## 11. Non-goals (say this explicitly if asked)

This is a hackathon MVP proving a deployment *pattern*, not a hardened production system. Security of the sandbox, scale of the RAG corpus, and breadth of supported models are intentionally minimal — the architecture is designed so each can be extended later without a redesign, which is the claim being made, not a claim that it's already been done.

## 12. Glossary

- **Router**: the component that automatically picks which model handles a task.
- **Model Registry**: the config file listing available models and what they're for.
- **Agent Loop**: the plan → tool-call → observe → repeat cycle the orchestrator runs.
- **Sovereignty Badge**: the always-visible UI element proving zero external egress.
- **Flagship Flow**: Flow A (inspection report → approval note) — the primary demo narrative.
- **Task Type**: the classification the router assigns to an incoming request (e.g. `vision`, `draft`, `code`).