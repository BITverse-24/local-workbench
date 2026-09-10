# Offline AI mock responses

These files are deterministic, provider-free fixtures for the offline AI
contract tests. They use the locked inputs and expected values from
`demo/`; no API keys, network URLs, or provider payloads are
included.

Each JSON file is a complete response envelope with stable fixture IDs.
Negative fixtures are intentionally untrusted model output.

| File | Expected validator outcome | Purpose |
| --- | --- | --- |
| `successful-ocr.json` | accepts with `LOCKED_FLOW_A_REQUIRED_FINDINGS` | Three evidence-backed findings and page references for E-201 |
| `invalid-ocr-output.json` | rejects | Finding references a page ID that is not present |
| `successful-code-generation.json` | accepts with `LOCKED_FLOW_B_CODE_RULES` | Safe Python for the fixed 240-row CSV |
| `malformed-code-response.json` | rejects | Missing `source` and contains an unexpected field |

The OCR fixtures are validated with `validateVisionResult`; the code
fixtures with `validateCodeDraftResult` (both in `ai/validation.ts`).
Flow A drafting fixtures were removed with the deferred approval-note flow;
the old draft mocks now live under `docs/archive/rag-legacy/`.
