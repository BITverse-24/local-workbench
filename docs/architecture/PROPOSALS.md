# PROPOSALS.md

Proposed changes to the architecture docs, arising from the decision to
develop against OpenRouter and switch to the local LAN models only at
packaging time (TASKS.md 2b and 11a, decided 2026-09-04).

**Both proposals below were implemented on 2026-09-04.** They are retained
as a record of the change.

## 1. Allow a development-phase registry in the model-registry contract

Status: implemented 2026-09-04 in `components-and-contracts.md` and
`README.md`.

- **Target:** `docs/architecture/components-and-contracts.md` ("Model registry"
  section) and `docs/architecture/README.md` ("Non-negotiable operational
  rules", rule 2).
- **Issue:** The docs state the registry contains only approved LAN IP
  addresses and ports, and `ModelRuntime = 'mlx-lm' | 'llama-server'`. The team
  now develops against OpenRouter until the local switch, so the development
  registry would formally violate the documented rules.
- **Evidence:** TASKS.md 2b (OpenRouter development entries, key from env) and
  11a (config-only switch back to LAN endpoints before rehearsal); README.md
  rule 2: "The model registry contains only approved LAN IP addresses and
  ports."
- **Suggested change:**
  - In `components-and-contracts.md`, add an optional `apiKeyEnv?: string`
    field to `ModelRegistryEntry` (the name of an environment variable; never a
    key value) and note that a development registry may contain OpenRouter
    entries; the registry shipped in the demo bundle stays LAN-only.
  - In `README.md`, reword rule 2 to: "The registry shipped in the demo bundle
    contains only approved LAN IP addresses and ports. A development registry
    may point at the team's approved OpenRouter account and is never used in
    rehearsals or the finals bundle."
- **Reason:** Keeps the docs truthful during the OpenRouter development phase
  without weakening the finals sovereignty claim.
- **Impact:** None on the gateway implementation — OpenRouter is
  OpenAI-compatible, so the normalized `/v1/chat/completions` contract is
  unchanged. The registry remains config-only; no other external endpoint
  becomes permitted.

## 2. Update the twelve-day plan's AI/ML column

Status: implemented 2026-09-04 in `delivery-and-verification.md`.

- **Target:** `docs/architecture/delivery-and-verification.md` ("Twelve-day
  build plan", Days 1–2 and Days 8–9 rows, Sid column).
- **Issue:** Days 1–2 read "provision local models; benchmark latency", but
  local model provisioning now happens at packaging time; days 1–2 instead
  connect OpenRouter stand-ins.
- **Evidence:** TASKS.md 2b (OpenRouter during development), 11a (local install
  and registry switch), and the re-validation steps added to 5b, 6b, and 8a.
- **Suggested change:**
  - Days 1–2, Sid: "connect OpenRouter stand-ins for the three routes; build
    initial Chroma corpus; begin background downloads of the local model
    weights".
  - Days 8–9, Sid: add "validate frozen prompts against the local models after
    the registry switch".
- **Reason:** The build plan should match the actual build order so its exit
  criteria stay checkable.
- **Impact:** None on exit criteria. Prompt tuning happens twice (once on
  stand-ins, once after the switch); TASKS 5b, 6b, and 8a now carry that
  re-validation explicitly.
