# Release fix evidence — 2026-10-11

See [the closing report](../../reports/release-blocker-fixes-2026-10-11.md). The earlier audit evidence is unchanged.

- `full-tests.log`: final source, 999 passing tests and six opt-in skips.
- `typecheck.log`, `behavioral-typecheck.log`, `build.log`: final source checks.
- `safety-tests.log`, `migration-and-containment-tests.log`, `workspace-binding-tests.log`, `approval-tests.log`: focused authority, transaction and component checks. Actual command tests exercised OS refusal on this host. Mocked publication tests are identified in their source.
- `canonical-nine.json`, `canonical-provenance.json`, `canonical.log`, `canonical-output-audit.json`: one complete nine-case campaign, 8 Pass/1 Partial; final output review. The worker digest matches the final source manifest. `earlier-canonical-*` retains the earlier complete campaign separately.
- `vision.json`, `vision.log`: fresh 3/3 visual smoke.
- `opt-in-live-tests.log`: five passes and the retained quoted-CSV model failure.
- `live-smoke-results.json`, `live-smoke.log`, `live-smoke-audit.json`: final-worker Agent write, general DOCX and active cancellation.
- `package.log`, `package-smoke.log`, `package-integrity.json`, `dmg-verify.log`, `packaged-startup.log`: final package checks. Startup is not a manual UI pass.
- `completion-audit.json`: requirement-by-requirement result; final UI checks remain open.
- `blocked-audit.json`: resolved verification hold and remaining per-run Python approval limit. `historical-mac-lock-audit.json` preserves the earlier Mac-lock record.
- `manual-ui-state.json`, `packaged-ui-final.log`: isolated-profile desktop test records.
- `identifier-rendering-tests.log`: focused rendering checks; the full suite includes all four final tests.
- `baseline-restore.json`: fresh independent source/diff/untracked-file restore; 375 files match the preserved checkout.
- `chat-followup-tests.log`, `write-plan-scope-tests.log`: real Chat evidence path and write-only plan command-scope checks.
- `source-manifest.json`: baseline commit plus hashes for each modified/new production and test file; final worker/backend/DMG hashes.

Raw live records remain in the paths recorded in these JSON files. Tests use separate profiles and run storage. Run live campaigns sequentially because separate processes do not share an inference queue.

Reproduce final package checks from the repository root:

```sh
node scripts/check-mode-package.cjs '/tmp/workbench-fix-final-package/mac-arm64/Sovereign Workbench.app'
node docs/evidence/release-fixes-20261011/package-check.cjs '/tmp/workbench-fix-final-package/mac-arm64/Sovereign Workbench.app'
python3 docs/evidence/release-fixes-20261011/audit-outputs.py tests/.runtime/v0/2026-10-11T06-37-11-335Z
```

Core packaged UI actions were checked. The user confirmed the final mode and underscore display points. Positive uncontained execution passed at the integration level, not through a packaged UI click. The previous Mac lock was resolved. The package is unsigned. Do not use this folder to claim completed manual checks, public signing, or platform certification beyond the tested Mac.
