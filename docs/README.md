# docs/

Source of truth for Sovereign Workbench architecture and demo acceptance.
The wiki (`wiki/`) is the judge-facing narrative; it must never contradict these files.

Read in this order:

1. [`architecture/README.md`](architecture/README.md) — system boundary, module map, operational rules.
2. [`architecture/components-and-contracts.md`](architecture/components-and-contracts.md) — run state machine, model registry, IPC contract, tool schemas.
3. [`architecture/flows-and-data.md`](architecture/flows-and-data.md) — Flow A/B/C sequence diagrams and failure behaviour.
4. [`architecture/deployment-and-sovereignty.md`](architecture/deployment-and-sovereignty.md) — LAN topology, offline provisioning, egress evidence, sandbox isolation.
5. [`architecture/delivery-and-verification.md`](architecture/delivery-and-verification.md) — build phases, preflight commands, acceptance checklist.
6. [`demo-requirements.md`](demo-requirements.md) — demo acceptance bar and fixture preflight.

Canonical inputs live under `demo/flow_a`, `demo/flow_b`, `demo/flow_c` with hashes in
`demo/manifest.json`. Verify with `python3 demo/validate_fixtures.py`.
