# Local Workbench fixed demo assets

This directory is the immutable input and oracle bundle for the three demonstration flows.

## Contents

- `flow_a/`: scanned inspection bundle, handwriting/anomaly oracle, SOP
  grounding, approval-note oracle, and air-gap verification.
- `flow_b/`: broken vendor-log parser, malformed CSV, repair trace, verified
  output, plus the original reactor-temperature regression fixture.
- `flow_c/`: labeled pump-skid drawing, piping SOP, compliance oracle,
  corrective-action note, and air-gap verification.
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
citations, air-gap proofs, golden Python execution, and manifest hashes.
