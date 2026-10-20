# Verification lifecycle

New Work and Agent runs use engine versions `work-v2` and `agent-v2`. Chat keeps `chat-v1`. Existing contracts remain immutable. Additive verification fields use the existing ledger and report JSON storage; no database migration is required.

## Completion and evidence

Each required check needs its own current evidence. A model final answer, command name, printed marker, or loop completion flag cannot establish a test pass. The manager verifies execution requirements, saves the final response, then confirms that response before completion. An unresolved mandatory check produces Partial.

The execution ledger stores verification plans and attempts before dispatch. It stores references to immutable results, tested input digests, repair counts, and stop reasons. The report and snapshot expose this state. The details panel shows attempts, unresolved checks, the stop reason, and the next step.

An explicit test skip in the original user instruction creates a durable waiver. Source text, quoted code, and model output cannot grant this waiver. A waived test check has status `skipped`, never `passed`. It can permit Completed when the other required checks pass. Other mandatory checks cannot use a test waiver.

## Work review and repair

Work first parses saved files and runs typed content checks. It then reviews semantic requirements against the saved output and original sources. It retains accepted passes and grounded failures for the exact request, contract, sources, output, execution, model, and review version.

Malformed, truncated, omitted, or unsupported reviewer output remains unresolved. Work retries the review without generating another artifact or executing unchanged Python. A grounded output or behavior defect enters repair, then verification runs on the corrected revision.

Review requests contain at most eight criteria. The requested output allowance is `max(1536, 512 + 384 × criterion count)`, capped at 4096 tokens and the configured model limit. Truncated batches become smaller. A truncated single criterion can use the remaining output allowance. Complete evidence must fit the model context; source and output review bounds remain 16,000 characters each. Limited source coverage and unsupported features produce a specific blocker.

The existing Work limits remain 24 model calls and two shared recoveries across the run and explicit resumes. Initial review batches are normal work. Repeated reviews and output repairs consume the shared recovery allowance. Accepted criteria and spent attempts survive restart. Python behavior reviews create new results linked to the saved execution; they do not change the original execution record.

## Agent tests

Code, test, and runtime configuration changes require existing tests by default. Documentation and image changes alone do not. The planner reads contained package and test configuration files. It keeps existing package scripts and forwarding launchers. It supports:

- Vitest and Jest JSON reports. Related selection runs first when supported; uncertain mappings use the full affected suite.
- Existing `node:test` suites, with a backend reporter that records test events, file paths, and failure details.
- Configured pytest suites through JUnit XML.
- Existing unittest modules through a discovery wrapper. The wrapper creates no tests.
- Existing custom commands with supported JUnit or TAP output.

The runtime schedules tests after planned writes or an attempted final answer. Commands use the existing exact-command approval and isolation rules. Tests run in the disposable command snapshot. Reports use its scratch area and are saved before cleanup. Test output, coverage, and caches are not published to the workspace. A test command that changes its input source or tests cannot establish a pass.

A pass requires an explicit integer exit code of zero, no timeout, a complete report, at least one executed non-skipped test, no failures or errors, and evidence for changed test files. Later input changes invalidate the pass. Test failures provide actual diagnostics to the repair loop. There are two repair/retest cycles after the initial test cycle. Related selection can fall back once to the full suite for missing coverage or zero selected tests; assertion failures cannot trigger that fallback.

A requested success marker is emitted only after the selected test command succeeds. Its observed execution record is kept separately from the short output preview. The marker cannot replace test evidence.

No usable setup, missing dependencies, unsupported reports, and execution limits produce Partial with saved work and a specific reason. Dependencies are not installed automatically. Command snapshots retain the 10,000-file and 128 MiB limits and existing symlink rules. Large dependency trees can therefore make a detected suite unavailable. Machine reports have a 16 MiB bound; command output retains its existing process buffer limit.

## Restart and release checks

Restart marks interrupted execution Partial and expires approvals. Explicit resume rechecks evidence digests and continues verification when possible. It does not replay uncertain mutations or restore spent recovery attempts. Historical runs keep their recorded acceptance policy; their required validation still needs current evidence.

Run the normal checks:

```sh
npm run typecheck
npm test
npm run build
```

The opt-in release checks use the configured local model and temporary run/workspace storage. They cover document review recovery, Python review recovery without another execution, and Agent repair after a real test failure. Missing model configuration fails these checks explicitly.

```sh
WORKBENCH_LIVE_TESTS=1 npm test -- backend/tests/live-verification-lifecycle.test.ts
```

Set `WORKBENCH_LIVE_MODELS_PATH` to a local model registry, or `WORKBENCH_LIVE_DB_PATH` to the configured app settings database when the development settings database is not used. These checks read model settings without changing them.
