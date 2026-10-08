# V0 shipping baseline — 8 October 2026

The reviewed baseline meets the model-quality gate in `FRAMEWORK.md`: **7/9 PASS**, with documents **2/3**, code **2/3**, and inspection **3/3**. No harness failure was detected in these runs. This does not claim that every equivalent prompt succeeds.

The lead is **Qwen2.5 Coder 7B**, using **Standard/default**, temperature 0 and the existing 1536-token working allowance. Qwen3-VL is the existing visual-input fallback. Qwen3.5 9B was not evaluated. Latency is reported without a release cutoff, as requested by the user.

The evidence uses the full nine-task campaign at `tests/.runtime/v0/2026-10-08T13-41-14-397Z`, followed by the unchanged three-code-task rerun at `tests/.runtime/v0/2026-10-08T14-20-19-059Z`. Changes between them affect code repair only. Document and inspection paths remain unchanged. This is an affected-suite certification; all nine did not run on one worker hash. Each campaign has its own provenance file.

| Task | Reviewed result | Terminal state | Seconds | Model calls | Output tokens | Finish reasons | Tool path |
|---|---|---|---:|---:|---:|---|---|
| Document, normal | PASS | completed | 229.6 | 10 | 3664 | stop | extract ×2 → retrieve → generate |
| Document, paraphrase | PASS | completed | 257.5 | 10 | 4197 | stop | extract ×2 → retrieve → generate |
| Document, unrelated training review | PARTIAL | completed | 99.9 | 8 | 1488 | stop | retrieve → generate |
| Code, normal | PASS | completed | 96.1 | 6 | 1559 | stop | execute_python |
| Code, paraphrase | FAIL | completed | 95.3 | 7 | 1645 | stop | execute_python |
| Code, unrelated word counter | PASS | completed | 48.8 | 6 | 734 | stop | execute_python |
| Inspection, normal | PASS | completed | 169.7 | 7 | 2561 | stop | extract → retrieve |
| Inspection, paraphrase | PASS | completed | 151.8 | 8 | 2277 | stop | extract → retrieve |
| Inspection, unrelated parcel review | PASS | completed | 59.5 | 5 | 951 | stop | retrieve |

Calls include interpretation and review calls, but exclude embeddings. Token usage is the provider's total output across those calls. `extract`, `retrieve` and `generate` mean `extract_document`, `retrieve_knowledge` and `generate_deliverable`.

The training review gives the correct eligibility decisions. It omits the attendance-retention action, changes the case of source identifiers, and omits the review date. The missing action is a significant omission, so the result remains PARTIAL.

The parser paraphrase returns `ok=3, malformed=1, high=1` on the supplied input. The source-supported test requires `ok=4, malformed=1, high=2`. It changes the original counting path and does not implement the boundary repair. Both supplied-input and independent-input checks fail. This is a model behavior failure, not a wording or formatting difference. The model-based review missed it. A successful process exit alone does not prove that an arbitrary repair is correct.

Minor document issues include a repeated title and redundant decision text. The inspection paraphrase has one table row with shifted columns; its prose correctly states both important findings and corrections. These issues did not prevent useful task completion. The normal DOCX was opened in Pages and was readable. Final artifacts were not manually edited.

The general changes in this pass are:

- Coverage review now lists exact source evidence and checks whether the draft contains it. A known omission can use the existing bounded correction turn.
- A model-generated checklist cannot create source authority.
- Optional assertions absent from the original request or evidence cannot reject an attached repair or direct another repair. The tool reports skipped checks. A check explicitly supplied by the user remains authoritative.
- Code recovery shares a maximum of two correction turns and uses the latest source and actual execution error.
- The unsafe comparison shortcut was removed. It could reject a valid opposite-branch implementation.
- Attached repair turns can give a brief, source-grounded change summary. Existing behavior reviews must give a nonempty explanation for their status.

No fixture values, business conclusions, filenames or entity rules were added to production code. The targeted production scan found no demo identifiers or expected values. The inverse-branch regression uses an unrelated program. Tests and source evidence contain scenario values; production routing does not use them.

Core integrity and V0 regression checks: **164/164 PASS** across ten test files. Type checking and the frontend/Electron build pass. The macOS app package builds. The full legacy suite remains **618 PASS, 72 FAIL, 6 skipped**. Its failure set matches the pre-existing failure set in this goal. Many failures use old model IDs or old intent/tool contracts. This report does not mark that suite green or treat every old failure as harmless.

Visual-input smoke: **3/3 PASS**, manually checked. The image-only PDF and raster image show the two blue circles and red triangle. The SVG contains geometry without text; extraction correctly identifies two blue circles, the green rectangle and their connections. Each uses the actual Qwen3-VL fallback through `extract_document → ModelGateway.execute(vision)`. Times are **13.5 s, 14.7 s and 13.1 s**, with one successful inference each and `stop` finish reasons. LM Studio rejects the initial response format; the gateway records that error and succeeds with its existing JSON-schema format retry. Evidence: `tests/.runtime/vision-v0/2026-10-08T14-18-47-396Z`.

The runtime is frozen after reaching the required family thresholds. No 18-prompt campaign, profile comparison, routing redesign, P2 work, Laya/Jev work or latency tuning was added. The remaining model-quality failures are retained in the report. First-shot success is not inferred from total model calls; those calls also include review. A separate first-shot rate was not instrumented.

The frozen runtime has genuine successful CLI recordings for normal A, B and C. These are live asciicast recordings and plain transcripts, not GUI videos. The successful runs were selected across two recordings; this is not a claim of one fresh 3/3 run.

| Recorded task | Reviewed result | Terminal state | Seconds | Model calls | Output tokens | Finish reason | Tool path |
|---|---|---|---:|---:|---:|---|---|
| A, additional unchanged run | PASS | completed | 202.6 | 10 | 3451 | stop | extract ×2 → retrieve → generate |
| B, first frozen recording | PASS | completed | 94.9 | 6 | 1559 | stop | execute_python |
| C, first frozen recording | PASS | completed | 137.5 | 7 | 2480 | stop | extract → retrieve |

The first recorded A run was PARTIAL in 192.0 seconds: it omitted the gasket finding and replacement action. That run remains in the evidence. No runtime change was made before the additional A recording. The additional run contains that finding and action. Its DOCX opens and is readable in Pages. Pages reports a missing font, but displays the document. The repeated title and weak placement of follow-up observations remain draft-quality issues. The document was closed without edits. The repaired B artifact passes the supplied-input and independent-input checks. C identifies the core drawing mismatches and actions; it adds unnecessary uncertainty to some source values.

Recordings and full run evidence:

- [First frozen A/B/C transcript](../tests/.runtime/v0-recordings/2026-10-08T14-28-25-239Z/normal-abc.log) and its adjacent `normal-abc.cast` and `recording.json`.
- [Additional A transcript](../tests/.runtime/v0-recordings/2026-10-08T14-38-09-239Z/normal-abc.log) and its adjacent `normal-abc.cast` and `recording.json`. The shared filename is retained; its metadata identifies A only.
- Run data: `tests/.runtime/v0/2026-10-08T14-28-25-329Z` and `tests/.runtime/v0/2026-10-08T14-38-09-321Z`.

The source and package are saved locally:

- [macOS arm64 app ZIP](../release/0.1.0/Sovereign-Workbench-V0-mac-arm64.zip). The developer package is unsigned; it was not published externally.
- [Source snapshot](../release/0.1.0/v0-source-snapshot.tar.gz), including current source, tests, configuration and build scripts. This preserves uncommitted files as well as tracked files.
- [Evidence archive](../release/0.1.0/v0-evidence.tar.gz), including reviewed results, campaign data, visual smoke, recordings and final check logs.
- [Runtime freeze manifest](../release/0.1.0/v0-freeze-manifest.json) and [archive checksums](../release/0.1.0/v0-release-files.json).

Use LM Studio with `qwen2.5-coder-7b-instruct-mlx` as the lead and Standard/default generation. The existing visual fallback is `qwen/qwen3-vl-4b`. Both were served at `http://127.0.0.1:1234/v1` in these checks. Select the Qwen2.5 model in the app if onboarding shows another default. Add the relevant source files and index the relevant knowledge documents before a grounded task. The package does not contain model weights. The source freeze manifest and worker hash were checked after the recordings; runtime files did not change.

