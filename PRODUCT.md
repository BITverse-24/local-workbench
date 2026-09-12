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
3. **Three visibly different agentic flows** (see `DEMO.md`) covering scanned evidence, code repair, and engineering-drawing compliance — each with a real deliverable and a continuous sovereignty proof.

## 6. Scope

### In scope (build this)
- Model registry: config file (task type → model endpoint), 3 models total, one per dedicated LAN box
- Router: automatic task classification (file type + lightweight intent check), not manual selection
- Agent orchestrator: plan → tool call → observe → repeat, with every step streamed to the UI as a visible transcript
- Tools: file read/write, OCR/vision call, local SOP criteria checks, `.docx`/`.xlsx` generation, sandboxed Python execution (no network), and drawing/compliance analysis
- Sovereignty dashboard: live connection monitor + always-visible "0 external requests" badge, with a demo-able block event
- Electron desktop shell: chat pane, live agent-step transcript, artifact preview pane
- Local rule citations surfaced beside every grounded decision (e.g. "grounded in SOP-114 §3.2")

### Out of scope (explicitly do not build)
- General handwriting OCR — Flow A demonstrates a fixed handwritten annotation, but does not claim robust handwriting coverage
- PowerPoint generation — bonus-only if time remains after Flow A and B are solid
- Multi-user auth, roles, enterprise deployment/ops tooling
- Large/general-purpose knowledge base — only the fixed local SOP/specification assets are in the demo bundle
- More than one sandboxed language (Python only)
- A model registry that's *actually* infinitely pluggable — it must *look* config-driven and extensible in the pitch; don't over-engineer the plugin mechanism itself
- Any live/improvised generative step during the finals demo — flagship flows run on pre-tested, fixed sample inputs only

## 7. Primary user flows

### Flow A — Scanned inspection bundle → approval note (flagship)
The orchestrator invokes the vision extraction tool (`vision-qwen25vl`) across two scanned reports to extract typed and handwritten evidence, queries local SOP-114 criteria via RAG, and drafts a cited assessment with the drafting model (`draft-qwen3`). The final `.docx` contains findings, anomalies, corrective actions, and a conditional recommendation.

### Flow B — Internal tool bug fix → sandbox verification
The code model repairs a deliberately broken vendor-log parser, runs it against a malformed CSV in the network-disabled sandbox, observes the real traceback, self-corrects, and produces a verified script plus output file.

### Flow C — Engineering drawing → compliance finding
The orchestrator invokes the visual drawing tool to extract component tags and dimensions from an engineering drawing, the reasoning model compares values against governing specifications dynamically via local RAG, and the workbench produces a concise cited corrective-action note without claiming approval.

All three flows run continuously against the visible sovereignty panel, which must show zero external requests and a recorded blocked attempt.

## 8. System components (product-level contracts)

| Component | Responsibility | Not responsible for |
|---|---|---|
| **Model Registry** | Config mapping task type → model endpoint (host:port) | Model training, quantization tooling |
| **Router** | Classify incoming task, pick a registry entry, emit the routing event the UI badges on | Generating any content itself |
| **Agent Orchestrator** | Run the plan→act→observe loop, call tools, stream each step | Model serving, sandboxing internals |
| **Tools** (file I/O, OCR, SOP checks, docx/xlsx gen, sandbox exec, drawing analysis) | One well-defined job each, callable by the orchestrator with a fixed schema | Deciding *when* they're called (that's the orchestrator) |
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
| i7 16GB (#3) | Orchestrator, local criteria, sandbox host, Electron backend |
| i5 11th-gen 16GB | Network-monitor collector |

Sovereignty dashboard's allowlist = exactly these five LAN IPs. Anything else contacted = visible failure state.

## 10. Definition of done (finals)

Maps 1:1 to the PS's "Expected Solution":

- [ ] Model auto-selection visibly demonstrated across vision, drafting, and code paths
- [ ] Flow A: scanned report bundle → extracted typed/handwritten findings → cited `.docx` approval note
- [ ] Flow B: broken internal utility repaired, executed, observed, and self-corrected in the sandbox
- [ ] Flow C: engineering drawing values compared against SOP limits with step-by-step reasoning
- [ ] Multimodal (scanned PDF and engineering drawing) understanding demonstrated
- [ ] Live proof of zero external calls for the full session, including a demonstrated block event
- [ ] Local SOP/specification citations visible beside Flow A and Flow C conclusions

## 11. Non-goals (say this explicitly if asked)

This is a hackathon MVP proving a deployment *pattern*, not a hardened production system. Security of the sandbox, breadth of the local rule set, and breadth of supported models are intentionally minimal — the architecture is designed so each can be extended later without a redesign, which is the claim being made, not a claim that it's already been done.

## 12. Glossary

- **Router**: the component that automatically picks which model handles a task.
- **Model Registry**: the config file listing available models and what they're for.
- **Agent Loop**: the plan → tool-call → observe → repeat cycle the orchestrator runs.
- **Sovereignty Badge**: the always-visible UI element proving zero external egress.
- **Flagship Flow**: Flow A (inspection bundle → approval note) — the primary demo narrative.
- **Task Type**: the classification the router assigns to an incoming request (e.g. `vision`, `draft`, `code`).
