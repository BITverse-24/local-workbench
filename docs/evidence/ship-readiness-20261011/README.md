# Ship readiness evidence — 2026-10-11

Candidate: `7ec4fd7811d49c053d7d8d25543672c990bc08ad`.

Decision: **Hold**. See [the report](/Users/krishay/projects/agent/docs/reports/ship-readiness-2026-10-11.md).

| Evidence | Purpose |
| --- | --- |
| `full-tests.log`, `typecheck.log`, `behavioral-typecheck.log`, `build.log` | Fresh ordinary checks; 974 passes and six opt-in skips |
| `package.log`, `package-smoke.log`, `package-integrity.json`, `packaged-sqlite.json` | Current unsigned Mac arm64 package, readers, native dependencies, database and archive inventory |
| `installer.log`, `installer-verify.log` | Unsigned DMG build and checksum |
| `canonical-nine.json`, `canonical-provenance.json`, `canonical.log`, `canonical-audit-summary.json` | Fresh nine-case campaign and saved-output review |
| `live-smoke-results.json`, `live-smoke.log`, `draft-and-cancellation-audit.json` | Agent write, table-free DOCX and active Chat cancellation |
| `vision.json`, `vision.log` | Fresh visual fallback smoke checks |
| `opt-in-tests.log`, `extra-checks.json` | Explicit live-fixture failures, kept separate from product defects |
| `command-probe.json`, `command-probe.ts` | Real temporary-file workspace escape, local TCP access and hidden alias writes |
| `source-cache-probe.json`, `source-cache-probe.ts` | Deterministic cache data-flow probe with a mock visual extractor; unprofiled capability defaults |
| `approval-render.json`, `approval-render.html`, `approval-render-probe.tsx` | Actual React component rendered with a Python fallback action |
| `historical-evidence-integrity.json` | 26 historical source and output digests rechecked |
| `summary.json` | Machine-readable audit result |

The command probe uses only files it creates under a temporary directory and a loopback server it owns. The cache probe replaces the visual extractor only in its own process. The approval probe uses React static rendering. None of these probes is a manual desktop check.

Raw live run files remain at:

- `/Users/krishay/projects/agent/tests/.runtime/v0/2026-10-11T05-41-14-118Z`
- `/Users/krishay/projects/agent/tests/.runtime/ship-audit/live-2026-10-11T05-49-21-611Z`
- `/Users/krishay/projects/agent/tests/.runtime/vision-v0/2026-10-11T05-50-46-708Z`

Generated package and DMG:

- `/tmp/workbench-ship-package/mac-arm64/Sovereign Workbench.app`
- `/tmp/workbench-ship-installer/Sovereign Workbench-Mac-0.1.0-Installer.dmg`

The live runner records and accepts Python fallback approvals in its test profiles. These approvals do not establish an OS sandbox. Do not run separate live campaigns in parallel; their processes do not share one inference scheduler.

## Reproduce the focused probes

Run from the repository root with installed dependencies. Create `tests/.runtime/ship-audit` if it does not exist. These probes deliberately test rejected boundaries using temporary files; a true escape result is a failure of the product boundary.

```sh
./node_modules/.bin/esbuild docs/evidence/ship-readiness-20261011/command-probe.ts --bundle --platform=node --format=cjs --packages=external --outfile=tests/.runtime/ship-audit/command-probe.cjs
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/.runtime/ship-audit/command-probe.cjs

./node_modules/.bin/esbuild docs/evidence/ship-readiness-20261011/source-cache-probe.ts --bundle --platform=node --format=cjs --packages=external --outfile=tests/.runtime/ship-audit/source-cache-probe.cjs
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/.runtime/ship-audit/source-cache-probe.cjs

./node_modules/.bin/esbuild docs/evidence/ship-readiness-20261011/approval-render-probe.tsx --bundle --platform=node --format=cjs --packages=external --jsx=automatic --outfile=tests/.runtime/ship-audit/approval-render-probe.cjs
node tests/.runtime/ship-audit/approval-render-probe.cjs
```

The copied probe sources have the same directory depth as the tested originals, so their repository-relative imports remain valid. Probe output files use `/tmp`; preserve any earlier evidence before repeating them.
