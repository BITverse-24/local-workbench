# V0 shipping status — 8 October 2026

V0 reached the Qwen2.5 Coder 7B gate in [FRAMEWORK.md](../FRAMEWORK.md): **7/9 PASS**, at least **2/3 in each capability family**, and **zero detected harness failures**. These results do not establish universal reliability.

Family results: grounded documents **2/3 PASS**, code modification **2/3 PASS**, and grounded inspection **3/3 PASS**.

The certified setup uses Qwen2.5 Coder 7B, Standard/default generation, temperature 0, and a 1536-token working allowance. Qwen3-VL 4B is the visual fallback. Qwen3.5 was not evaluated.

## Certification results

| Task | Result | Terminal state | Seconds | Model calls | Output tokens | Finish | Tool path |
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

Calls include interpretation and review. They exclude embeddings. Tokens are provider output tokens across calls. `extract`, `retrieve`, and `generate` refer to `extract_document`, `retrieve_knowledge`, and `generate_deliverable`.

The code paraphrase returns wrong counts for the supplied input and fails independent-input checks. The model moved the count update into the wrong branch and missed the boundary case. This is a real behavior failure. The training review gives the right eligibility decisions but omits an attendance-retention action, changes source identifier case, and omits the review date. That result is PARTIAL. Minor draft issues include repeated headings and a shifted table row. They do not change the major findings.

The full nine-task certification and final three-code confirmation used different workers. Code changes between these campaigns were limited to code repair. The document and inspection paths did not change. Evidence records this as an affected-suite certification.

## Recorded demo and latency exception

The certified runtime has genuine successful A, B, and C CLI recordings. The successes span two recordings; they are not one 3/3 run.

| Flow | Result | Seconds | Model calls | Output tokens | Tool path |
|---|---|---:|---:|---:|---|
| A, additional normal run | PASS | 202.6 | 10 | 3451 | extract ×2 → retrieve → generate |
| B, normal run | PASS | 94.9 | 6 | 1559 | execute_python |
| C, normal run | PASS | 137.5 | 7 | 2480 | extract → retrieve |

The successful Flow A run took **203 seconds**. This exceeds the framework's normal 120-second target. V0 accepts this as a documented exception for complex grounded document work. The earlier A recording took 192 seconds and was PARTIAL because it omitted the gasket finding and replacement action. Both recordings are retained.

The nine-task campaign also recorded document runs at 229.6 and 257.5 seconds and a normal inspection run at 137.5 seconds. These results are above the normal 120-second target and remain visible in the table; this release does not claim that all workflows meet the target.

The final A DOCX opened and was readable in Pages. It has a repeated title and weak placement of some follow-up notes. The final artifact was not manually edited. Flow C identified the core drawing findings and actions, with some unnecessary uncertainty in its final wording.

## Visual fallback and software checks

The Qwen3-VL fallback passed **3/3** visual smoke checks for a raster image, an image-only PDF, and an SVG drawing without useful text labels. The tests used `extract_document` and the vision model. Each had one successful inference and a `stop` finish reason. The initial JSON object format was rejected; the existing JSON-schema retry succeeded.

The V0 core suite passed **164/164 checks** across ten test files. Typecheck, production build, and package build passed. The wider legacy suite had **618 pass, 72 fail, and 6 skipped**. Those failures matched the earlier failure set in this work. They are outside the V0-critical suite; they are not reported as passing.

## Frozen runtime and retained evidence

The certified pre-cleanup source commit is `0d5c23423c9b31494e18520b9816c368ff3df523`; its retained source archive SHA-256 is `945b8cb141246ba995ac016d9fafca97733118548ff7644b84925c010dcc3c4c`. The worker SHA-256 is `afacf6c8d7a314ada8ae3594d70df842403430417fcc6660c44d454eb285d1f0`. The certified runtime manifest, campaign summaries, selected run records, recordings, smoke results, and check logs are in [docs/evidence/v0](evidence/v0/README.md).

The distributable is built from `frontend/dist`, `electron/dist-electron`, the model registry, schema, and production dependencies. It excludes `.env`, `.git`, project source, benchmark data, databases, telemetry, and user files. The model weights are not included. The package targets macOS arm64.

The packaged app uses any model configuration saved in its local database. During this release check, an earlier saved alias (`qwen2.5-coder:7b`) did not match the loaded LM Studio model ID. The local profile was updated to the loaded Qwen2.5 Coder ID before the app smoke test. The V0 example configuration and [README setup steps](../README.md) show the exact reference model IDs.

## Release verification

Version metadata is `0.1.0` in `VERSION` and `package.json`; the release snapshot is tagged `v0.1.0`. Typecheck, production build, the 164-check V0 core suite, and the macOS arm64 installer build passed. Their logs are in `check-logs/`.

The final packaged app launched from the release output and reported Qwen2.5 Coder available from the local endpoint. Chat returned `READY` in 3.5 seconds. Agent smoke checks were mixed: one run did not call a tool; a fresh run called `read_file` on a connected temporary workspace, then returned text that did not match the file. The UI marked the run as passed. This is recorded in [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md).

The final DMG passed `hdiutil verify`. Its package inventory contains no `.env`, `.git`, database, log, benchmark output, telemetry file, project or dependency test fixture, personal path string, secret-like assignment, or repository update metadata. It includes the application, production dependencies, model registry, and schema. The DMG SHA-256 and inventory are recorded in the [package audit](evidence/v0/check-logs/release-final-package-audit.json).

No changes were made to prompts, routing, recovery logic, tool contracts, evaluation semantics, or generation settings during release cleanup. The certified worker hash remained unchanged. Electron 30.5.1 was end-of-life, so the packaged shell uses Electron 44.7.0 and electron-builder 26.17.0. The removed `clipboard.writeBuffer` call was replaced with Electron's supported clipboard API to preserve file-copy behavior. `better-sqlite3` was updated to 13.0.3 because its prior native code did not build against Electron 44. The 164 core checks pass with these package changes. The app still has no valid Developer ID signing identity, so the DMG is unsigned and not notarized. The production dependency audit has two moderate UUID findings and no high or critical findings; see [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md).
