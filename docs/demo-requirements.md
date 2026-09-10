# Demo Requirements

The canonical SIH 2026 rehearsal plan is [`DEMO.md`](../DEMO.md). It defines
all three fixed flows, user prompts, visible agent steps, routing changes,
assets, expected outputs, failure behavior, and sovereignty evidence.

## Acceptance bar

- Flow A processes the two-report scanned bundle, preserves the handwritten
  annotation as evidence, applies SOP-114, and produces a cited approval note.
- Flow B repairs the broken vendor-log parser, observes a real sandbox failure,
  self-corrects, and produces a verified output file.
- Flow C identifies both deliberate drawing/specification mismatches, cites
  SOP-220, and produces a corrective-action note without claiming approval.
- All flows use fixed assets under `demo/flow_a`, `demo/flow_b`, and
  `demo/flow_c`.
- All flows visibly show automatic routing, a streamed plan, tool execution,
  and the independent sovereignty monitor with zero external requests plus a
  recorded blocked attempt.

## Fixture preflight

Run:

```text
python3 demo/validate_fixtures.py
```

The validator checks all three flow bundles, deterministic output oracles,
citations, expected failure/repair behavior, sovereignty proof records, and
the manifest hashes.
