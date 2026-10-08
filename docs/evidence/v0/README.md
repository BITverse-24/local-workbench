# V0 certification evidence

This folder holds the evidence needed to review the V0 claim. It keeps the full nine-task certification, the final code confirmation, the genuine successful A/B/C CLI recordings, the earlier partial A run, the visual smoke, the source snapshot, and the check logs.

The certified pre-cleanup source was commit `0d5c23423c9b31494e18520b9816c368ff3df523`. Its source archive SHA-256 is `945b8cb141246ba995ac016d9fafca97733118548ff7644b84925c010dcc3c4c`. The certified worker SHA-256 is `afacf6c8d7a314ada8ae3594d70df842403430417fcc6660c44d454eb285d1f0`. The final packaged shell has a separate inventory and SHA-256 in `check-logs/release-final-package-audit.json`.

- `reviewed-shipping-baseline.json` records the reviewed 7/9 result and per-task scores.
- `campaigns/` holds the nine-task campaign and final three-code confirmation.
- `recorded-runs/` holds the run records for the first A/B/C recording and the later successful A run.
- `recordings/` holds the original asciicast files, plain transcripts, and recording metadata.
- `vision/` holds the 3/3 visual fallback smoke evidence.
- `certified-runtime-manifest.json` and `certified-source-snapshot.tar.gz` identify the certified source and worker.
- `check-logs/` holds the V0 core, wider legacy, typecheck, build, package, package-inventory audit, Electron compatibility, DMG integrity, and vision logs. `release-final-app-smoke.json` records the packaged Chat and Agent checks.

The earlier A recording is retained as PARTIAL. A/B/C success was selected across two recordings. The evidence does not claim one 3/3 execution or universal reliability.
