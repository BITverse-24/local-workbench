# Framework implementation and verification

The agreed execution plan is implemented in gated stages. This file tracks actual
verification; unchecked items must not be described as achieved.

- [x] Native isolation probes, worker startup, faithful parser vertical slice
- [x] Independent evaluator calibration and evidence capture
- [x] Versioned 36-scenario corpus across all 12 families (schema verified)
- [x] Adaptive campaigns, effort limits, fallback, reproduction, minimization
- [x] Append-only Markdown issue reporting
- [x] Strict replay, transport faults, metamorphic comparisons
- [x] Actual Electron preload/IPC smoke
- [x] Project typecheck and existing tests
- [x] Three fresh real local-model parser benchmark executions
- [ ] Complete 36-scenario real benchmark (deferred to user)
- [ ] Real Gremlin discovery of a finding missed by the curated baseline
- [x] Requested OpenRouter development model verification

## Environment observations

- macOS arm64; Electron, esbuild, Python and `sandbox-exec` available.
- Native sandbox launch passed outside Codex's nested sandbox.
- Ollama was unavailable, but saved deployment settings identified LM Studio at
  `127.0.0.1:1234`. Its fixed roles were copied to a test-only local profile.
- Real parser benchmark: 0 pass / 3 fail / 0 inconclusive. Each failure was
  checked independently and appended to the issue log; application behavior was
  not repaired. Report: `.runtime/benchmarks/a0672ea1-4caf-4673-a856-42406993b792.json`.
- Native acceptance: all 12 checks passed, including actual within-run follow-up,
  good/bad repairs, strict replay/divergence, faults, a metamorphic variant and
  operator-interruption cleanup with retained inconclusive evidence.
  Report: `.runtime/acceptance.json`.
- Native Electron smoke passed; report: `.runtime/bridge-smoke.json`.
- Project typecheck and 517 existing tests passed. Final focused framework
  typecheck passed and all 45 framework/evaluator tests passed. These include
  three fresh original reruns, five bounded minimization trials, immutable
  source facts/permissions/checks, fallback and reserved triage effort.
- OpenRouter returned valid mutations and interactive follow-up using
  `stealth/space-bunny-alpha`, with zero reported cost on successful development
  requests. Reports are under `.runtime/campaigns/`. Scripted-target calibration
  is explicitly labeled mock; it is not a real-model discovery claim.
- Final native canary design uses synthetic, disposable bait accessible to the
  application OS sandbox while real host reads remain denied. Final native
  probes passed; real-model workspace-isolation outcomes await the user's run.
- The full benchmark was stopped at the user's request after 36 completed
  records. Campaign `1f26c000-6971-4665-865b-e8b6309cefc2` retains a `.stopped.json`
  manifest, partial execution evidence and the interrupted worker's files.
  Those records predate final corpus/evaluator refinements and do not establish
  full-suite results. No benchmark worker remains running.
- The separate invalid-IPC fixture correctly reports a backend acceptance of
  nonexistent confirmation UUIDs as a boundary failure, with no infrastructure
  error. This scripted check is not a stochastic model-behavior finding.
- Corpus refinements enforce source values, units and pages; actual permission
  revocation/cancellation; sequential document pointers for compaction; distinct
  multiple-log reads; and validation bound to the correct follow-up run.
- Model digests are unavailable from this LM Studio endpoint, so historical
  comparison refuses to claim verified model-version compatibility.

## Deferred real acceptance

Framework development is complete. The user explicitly deferred the entire
real-model suite and asked for development to take priority. The remaining
unchecked items above are deployment behavior/novel-discovery verification,
not claims established by scripted calibration or framework unit checks.

```sh
npm run build:behavioral
npm run behavioral -- benchmark --profile=tests/profiles/deployed.local.json --target=real --judge=none --repeat=3
npm run behavioral -- campaign --profile=tests/profiles/deployed.local.json --target=real --attacker=openrouter --judge=none --key-stdin
```
