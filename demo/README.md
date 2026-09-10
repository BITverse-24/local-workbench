# Sovereign Workbench fixed demo assets

This directory is the immutable input and oracle bundle for the three SIH
2026 demo flows. The canonical walkthrough is [`DEMO.md`](../DEMO.md).

## Contents

- `flow_a/`: scanned inspection bundle, handwriting/anomaly oracle, SOP
  grounding, approval-note oracle, and sovereignty proof.
- `flow_b/`: broken vendor-log parser, malformed CSV, repair trace, verified
  output, plus the original reactor-temperature regression fixture.
- `flow_c/`: labeled pump-skid drawing, piping SOP, compliance oracle,
  corrective-action note, and sovereignty proof.
- `build_fixtures.py`: deterministic PDF/CSV fixture builder and manifest
  generator.
- `validate_fixtures.py`: offline validator for all three flows.
- `manifest.json`: hashes and locked expectations for every active asset.

Run the preflight test from the repository root:

```text
python3 demo/validate_fixtures.py
```

The validator uses only the Python standard library. It checks CSV counts
and outliers, handwriting evidence, repair iteration, drawing mismatches,
citations, sovereignty proofs, golden Python execution, and manifest hashes.
