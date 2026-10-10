# Final FRAMEWORK.md verification

Date: 2026-10-11. The minimum V0 gates pass on this Apple M4 with 16 GiB RAM and the configured Qwen2.5 Coder 7B model. The runtime is frozen for this verification. This result is limited to the tested local configuration.

| Gate | Result |
| --- | --- |
| Full regression suite | 922 passed, 0 failed, 6 existing opt-in live tests skipped |
| App and behavioral typechecks | Pass |
| Build and unsigned macOS arm64 package | Pass |
| Packaged independent PDF, DOCX and XLSX readers; native canvas | Pass |
| Nine-case reference-model evaluation | 8 Pass, 1 Partial, 0 Fail, 0 Harness Failure |
| Per family | Documents 2/3; code 3/3; inspection 3/3 |
| Recovery limit | At most 2 attempts |
| Latency | All 9 under 78 seconds; p50 59.4s, p95 77.9s |
| Visual fallback | 3/3 Pass with actual configured fallback calls |
| Genuine Flow A/B/C records | Captured events, model logs, sources, persisted results and output artifacts |

The saved output audit confirms the automatic grades. Evaluation Pass and production Completed are separate. All six Work runs stayed Partial because required checks were missing or unverified. The three Chat inspection runs completed. No audited run falsely declared complete Work. This observation does not prove universal semantic correctness.

## Final cohort

One complete campaign: `tests/.runtime/v0/2026-10-10T20-47-42-153Z`. These grades do not combine successful samples from different campaigns.

| Task | Audit | Seconds | Recovery attempts | Production state |
| --- | --- | ---: | ---: | --- |
| document-normal | PASS | 49.5 | 0 | partial |
| document-paraphrase | PASS | 77.9 | 2 | partial |
| document-unrelated | PARTIAL | 59.4 | 2 | partial |
| code-normal | PASS | 62.0 | 0 | partial |
| code-paraphrase | PASS | 61.1 | 0 | partial |
| code-unrelated | PASS | 70.7 | 2 | partial |
| inspection-normal | PASS | 23.8 | 0 | completed |
| inspection-paraphrase | PASS | 16.7 | 0 | completed |
| inspection-unrelated | PASS | 14.3 | 0 | completed |

The training note is useful but inconsistent: it says no action is needed for Lark, then requires retention of the attendance sheet. It also cites the records section for the eligibility rule. It remains Partial. Case changes in a staff heading are recorded as a minor diagnostic issue, not the reason for the manual Partial grade.

The repaired parsers pass real supplied and independent CSV probes. The probes establish blank-value handling and the inclusive boundary. They do not establish behavior for every malformed header or missing column. The word counter passes repeated-word, case and punctuation probes.

## Evidence and recordings

- [Manual source/output audit](manual-review.json) includes source and artifact digests, durable states, modes and model-call counts.
- [Automatic nine-case record](canonical-nine.json) retains all original requirement results.
- [Visual output audit](vision-review.json) checks actual colors, counts and spatial arrangement.
- [Captured Flow A/B/C record viewer](recorded-demos.html) shows real submitted requests, outputs and run events.
- [Recording manifest](recorded-demos.json) links real sources, artifacts and model logs. These are backend execution recordings, not screen videos.
- The logs in this folder contain the full tests, typechecks, build, package, packaged readers, canonical campaign and visual checks.

The original baseline and previous failed campaigns remain preserved. The final source patch, untracked files and runtime evidence are saved separately in `/Users/krishay/.codex/backups/local-workbench-three-mode-20261010-200451`. Restore instructions are in `framework-final-RESTORE.txt`.

## Fixes verified

- Dispatch and tool policy apply the saved mode before workspace access. Chat uses one generation call for ordinary text. Work cannot obtain a persistent workspace harness. Agent needs its bound workspace.
- Source IDs, aliases, containment, digests and independent readers preserve truthful input and output references.
- The Python scratch folder is separate from published outputs. Read-only inputs cannot block a same-name repaired-source export. Saved and executed source digests match.
- Repair edits retain the original numeric boundary, ordered comparison and unmarked update behavior. The model receives the actual current source after a failed repair.
- Work keeps tool failures visible. A later text claim cannot turn failed computation into success. Unverified semantic reviews keep Partial and cannot trigger repairs without valid source/output quotes.
- Digital sources and their annotations retain subject ownership. Image-only PDFs use vision even when the parser creates page headers.
- Queue fairness, one active run per chat, cancellation, process-tree termination, restart authority and background event ownership have regression coverage.

Legacy end-to-end fixtures now submit explicit modes, use chat-owned attachments, and exercise the actual gateway interface. Provider responses are mocked in unit tests; file readers, persistence, policy and Python execution remain real. Old assertions that expected Chat to compute or write files were replaced with the required mode boundaries. These fixtures are not used as live model-quality evidence.

## Limits

A manual UI pass is recorded in [manual UI checks](manual-ui-checks.md). Chat, Work, queued cancellation, chat switching and restart restore worked. Agent became available in a temporary workspace, but the model proposed an unrelated DOCX action twice; the approval gate blocked both plans. The active transport Stop control and Python fallback approval modal remain unchecked. The package is unsigned; signing, notarization and Windows/Linux certification were not done. During the first restart attempt, macOS also opened a process without the temporary profile and touched the default database. It received no prompt; no conversation content was inspected, and the database's prior state cannot be established.

Python used the approved fallback where OS isolation was unavailable. Test-operator approvals are recorded against actual source and input digests. This fallback does not enforce filesystem or network isolation.

The prior matched Chat measurements remain in `../three-modes/`. They use a small idle/busy sample and do not measure true cold model loading or renderer paint time. Numerical speed gates remain open. Qwen3.5 certification is not required for the V0 reference-model gate and was not run.

## Reproduce

```sh
npm run typecheck
npm run typecheck:behavioral
npm test
npm run certify:v0
node scripts/certify-vision-v0.cjs
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:dir -- --mac --arm64
node scripts/check-mode-package.cjs
```

Run live model campaigns in sequence. Independent test processes do not share the application scheduler. Audit saved outputs after a new stochastic campaign; do not assume that every later run will match this result.
