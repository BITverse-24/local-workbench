# Offline AI mock responses

These files are deterministic, provider-free `ModelResponse` fixtures for the
AI gateway and orchestrator tests. They use the locked inputs and expected
values from `demo-fixtures/`; no API keys, network URLs, or provider payloads
are included.

Each JSON file is a complete response envelope with stable fixture IDs. The
backend should still validate the envelope and `result` at runtime; the
negative fixtures are intentionally untrusted model output.

| File | Expected validator outcome | Purpose |
| --- | --- | --- |
| `successful-ocr.json` | accepts with `LOCKED_FLOW_A_REQUIRED_FINDINGS` | Three evidence-backed findings and page references for E-201 |
| `invalid-ocr-output.json` | rejects | Finding references a page ID that is not present |
| `successful-drafting.json` | accepts with the locked retrieval chunks | Four sections and supported `SOP-114 §3.2` citation |
| `unsupported-citation-draft.json` | rejects | Citation is not present in retrieved chunks |
| `missing-sections-draft.json` | rejects | Required grounding section is missing |
| `successful-code-generation.json` | accepts with `LOCKED_FLOW_B_CODE_RULES` | Safe Python for the fixed 240-row CSV |
| `malformed-code-response.json` | rejects | Missing `source` and contains an unexpected field |
| `no-matching-knowledge-source.json` | accepts with an empty retrieval result | Explicit no-source notice with no citations |

The draft fixtures are validated with the OCR result as `sourceText`, findings,
and page references, plus the retrieved chunks from the locked Flow A retrieval
oracle. The no-source fixture is validated with `retrievedChunks: []`.

