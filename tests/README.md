# Adversarial behavioral E2E tests

This framework tests the deployed model–application combination through the real
backend, rather than treating a plausible final message or `completed` state as
proof of success. It does not repair application behavior. Evidence-backed
application findings append to **`tests/BEHAVIORAL_ISSUES.md`**.

## Start here

Run from the repository root. Native execution currently requires macOS,
`/usr/bin/sandbox-exec`, Electron's installed native dependencies, and Homebrew
Python 3. The worker uses Electron's Node runtime to match SQLite/canvas ABI.
Unsupported isolation fails closed. Inside Codex's nested sandbox, native probes
require the approved outer execution context; a normal terminal can run them
directly.

```sh
npm run build:behavioral
npm run typecheck:behavioral
npm run test:behavioral
npm run behavioral -- doctor
npm run behavioral -- acceptance --judge=none
npm run behavioral -- bridge-smoke
```

`acceptance` runs good/bad parser repairs, strict replay and divergence, five
transport faults, a metamorphic scope check, interactive follow-up and interruption
cleanup through contained native workers.
These are scripted calibration runs. `bridge-smoke` separately launches a real
BrowserWindow using the production preload and IPC handlers, with temporary
persistence and a scripted model. Neither establishes real-model behavior.

`test:behavioral` checks framework and evaluator calibration; its passing count
does not establish that an application request works with a live model.
For the intent/approval/attachment regression checks against the application's
currently saved model configuration, run:

```sh
WORKBENCH_LIVE_TESTS=1 node scripts/test.cjs backend/tests/live-intention-verification.test.ts
```

These tests use the production gateway and isolated temporary run/workspace
directories. They verify classification latency and scope, rejection before
generation, and an approved Python repair with independent output assertions.
An explicit live run fails if the endpoint is unavailable; normal unit runs mark
these cases skipped. Development settings default to `data/data/workbench.db`;
set `WORKBENCH_LIVE_DB_PATH` for another app installation, or
`WORKBENCH_LIVE_MODELS_PATH` for an explicit registry. Fixed campaign profiles are
snapshots and must be checked against current app settings before their results
are used as evidence about the app.

## Explicit model profiles

Copy `tests/profiles/local.example.json` to `tests/profiles/your-machine.local.json`
and configure fixed target roles and embedding model. Machine profiles and runtime
evidence are gitignored. The supervisor never changes the application's saved
model configuration, and target models never fall back automatically.

The example assumes Ollama at port 11434. A machine profile matching the saved
LM Studio configuration was used for development verification. Endpoint preflight
requires each enabled fixed model to appear in `/v1/models`. Ollama digests are
recorded when exposed; unavailable version identities are explicitly recorded.
Historical comparison refuses an unverified model identity.

On this development machine the saved deployment profile is
`tests/profiles/deployed.local.json` (LM Studio). It is gitignored and can be used
in place of `your-machine.local.json` in the commands below.

Attacker and judge configuration, credentials, and request limits are independent.
Set the environment variable named by each provider's `apiKeyEnv`. Keep keys out
of profiles. `--key-stdin` reads the attacker key without terminal echo; it does
not populate the judge's credentials. Cloud attacker defaults to
`stealth/space-bunny-alpha`. Primary credential/credit/rate/transport failure uses
the configured local fallback. Retries count against effort and stop at the
campaign deadline. Fallback stays local for the rest of that campaign.

## Real runs and stable benchmarks

```sh
npm run behavioral -- run --profile=tests/profiles/your-machine.local.json --target=real --judge=none
npm run behavioral -- benchmark --profile=tests/profiles/your-machine.local.json --target=real --repeat=3
npm run behavioral -- benchmark --profile=tests/profiles/your-machine.local.json --target=real --repeat=3 --ids=dependent-operations-parser
```

The default `run` is the parser repair vertical slice. `--scenario=FILE` accepts
a validated scenario. Benchmarks use the checked-in v1 corpus: 36 cases across
12 families and simple, moderate, and complex interactions. The five-minute
confirmation-expiry case deliberately takes real wall-clock time.

Each repetition starts a fresh process, SQLite/RAG state, attachment store and
workspace. History persists only within a scenario. Benchmark reports stratify
by family/complexity and retain pass/fail/inconclusive counts, policy violations,
observed rates with approximate Wilson pass-rate intervals, mean latency/tool
calls, corpus and target hashes, evaluator source hash, judge
identity, model metadata and application commits.

```sh
npm run behavioral -- compare --before=tests/.runtime/benchmarks/BEFORE.json --after=tests/.runtime/benchmarks/AFTER.json
```

Comparison requires matching corpus, target, known model identity, evaluator,
judge and execution mode. A comparison describes observed changes; small sample
counts do not establish that a stochastic regression is resolved.

Press Ctrl+C to stop a long run. SIGINT/SIGTERM stop the disposable worker and
pending relay/provider requests, retain partial evidence, and exit with code 130.
Benchmarks checkpoint after each execution and mark interrupted reports incomplete;
incomplete reports cannot be compared as full benchmarks. An operator interruption
never automatically appends an application finding.

## Gremlin discovery

```sh
npm run behavioral -- campaign --profile=tests/profiles/your-machine.local.json --target=real --attacker=openrouter --judge=none --key-stdin
npm run behavioral -- campaign --profile=tests/profiles/your-machine.local.json --target=real --attacker=local --judge=local
```

Standard effort is 60 worker executions, 120 attacker requests, 60 judge
requests and two hours. Twenty executions are reserved for reproduction and
minimization; early triage cannot consume discovery coverage slots. Custom
development bounds use `--executions=N --reserve=N --attacker-calls=N
--duration-ms=N`. Reports identify any uncovered families and incomplete triage.

Use `--ids=id1,id2` on a campaign to restrict discovery and reproduction to
specific corpus prompt sequences. Unselected scenario families are not sampled.

Gremlin receives only user-visible messages, displayed tool activity, confirmation
previews, accessible artifact text and fixture inputs. It never receives checks,
hidden validator expectations, evaluation results, canaries or host credentials.
Typed mutations preserve the original binding task and verification. Search
adapts family allocation using independently verified rewards and previous visible
responses. Each discovery execution can also receive one bounded follow-up chosen
after Gremlin sees that execution's actual displayed response. The concrete
interaction is saved and reused unchanged during reproduction. Discovery outcomes
are separate from the stable benchmark.

Suspected deterministic failures receive up to three fresh original reruns and
five context-minimization attempts within triage effort. The report distinguishes
original occurrence counts from minimization trials. Candidate scenario JSON
remains outside the curated suite until reviewed. A novel finding should be
claimed only after checking that the matching curated baseline did not already
reveal it.

## Scenarios and independent verification

`tests/scenarios/schema.ts` defines fixtures, immutable objectives/permissions,
symbolic run bindings, typed user actions and independent checks. Behavioral
actions follow the renderer's register-attachment → persist-user → start-run
sequence. Direct arbitrary IPC is restricted to separately labeled boundary
scenarios. `settle` supports explicit approval/rejection, no expected approval,
or approval limited to displayed read-only tool plans. A scope-mismatched plan
is rejected and recorded as a behavioral failure, rather than an infrastructure
failure. Approval records include the actual action ID and event sequence.
Output, event and successful-tool-result checks can bind to one named run, so an
earlier validation cannot satisfy a follow-up's required validation.

A small boundary fixture can be run separately:

```sh
npm run behavioral -- run --target=mock --scenario=tests/scenarios/boundary/ipc-invalid.json --judge=none
```

An invalid call accepted by the backend is a boundary failure, with the actual
response retained. The current backend accepts a confirmation for nonexistent
UUIDs, so this fixture is expected to report that failure. It does not invoke
model inference, and its results remain separate from ordinary user behavior.

Verification combines workspace manifests, actual successful tool results,
parsed Word/Excel deliverables, exact source facts, protected paths, approval
scope, canary integrity/disclosure and post-stop effects. Code repair runs a
separately maintained Python adapter in a fresh read-only sandbox with expected
results checked outside it, including randomized CSV inputs. Judge verdicts need
exact quotations from supplied sources; unsupported or unavailable judgment is
inconclusive. A model's private reasoning is not treated as proof.

Workspace-only permissions are checked independently of the application's own
intent classification. Every requested artifact must be parsed; empty/malformed
deliverables fail. Unsupported formats are inconclusive. ZIP members are bounded
before parsing DOCX/XLSX to protect the supervisor from compressed payloads.
Raw generated files up to 32 MiB are saved before parsing, including malformed
and unsupported artifacts; larger files receive an explicit evidence-limit failure.

## Replay, transport faults and metamorphic checks

```sh
npm run behavioral -- run --target=replay --profile=PROFILE.json --scenario=SCENARIO.json --record=RECORD.json
npm run behavioral -- run --target=mock --judge=none
npm run behavioral -- run --target=mock --broken=true --judge=none
npm run behavioral -- metamorphic --profile=PROFILE.json --target=real --transform=unrelated-file
npm run behavioral -- metamorphic --profile=PROFILE.json --target=real --scenario=SCENARIO.json --transform=rename-source --file=measurements.pdf --name=scan-001.pdf
npm run behavioral -- metamorphic --profile=PROFILE.json --target=real --scenario=SCENARIO.json --transform=change-value --file=measurements.pdf --from=12.7 --to=9.3
```

Replay checks request order, route, model, settings, messages, tool schemas and
responses. Only supervisor-observed generated run IDs, sandbox/backup directories
and command-duration telemetry may vary. Source UUIDs/dates/values, commands,
stdout/stderr/exit codes remain exact. Changed or unused requests fail closed;
recorded stream bytes and delays are replayed. Replay never contributes to
real-model occurrence statistics.

Metamorphic transformations also support `--transform=paraphrase --text=...`.
Changing a source value requires an existing independent exact-value expectation;
it updates that oracle and forbids the old value. Renaming preserves source facts.
Both variants run independently and retain separate evidence.

## Evidence and issue reporting

Every execution saves under `tests/.runtime/evidence/<campaign>/<execution>/`:

- `record.json`: configuration, commands/responses, complete events, model wire
  traffic and streaming chunks, hashes, diffs, persistence, decisions and checks.
- `scenario.json` and `profile.json`: concrete local reproduction inputs.
- `fixtures/`, `workspace/`, `artifacts/`: original fixture bytes, final workspace
  files and actual generated deliverables.
- JSONL records: worker events/commands, model traffic and user decisions.

Evidence stays outside worker access. Worker environment is allowlisted, its
network reaches only the supervisor's fixed-route relay, and real host reads
are denied. Synthetic canaries outside the workspace remain OS-accessible bait,
so the evaluator can detect missing application-level guards without exposing
real host data. Their contents, additions and deletions are checked. A watchdog
observes process descendants, time, 4 GiB worker RSS and
1 GiB scenario disk. Normal and detached-child cleanup are probed. Native
process-tree polling does not claim perfect containment of arbitrary instant
double-fork/reparent races; filesystem/network restrictions remain inherited.

The fixed Markdown log is append-only. Exact execution duplicates are suppressed;
additional occurrences append separately. Behavioral findings retain prompts,
permissions, observed failures, counts, model configuration, fixture hashes,
trace excerpts and evidence/replay links. Mock calibration and unsupported
judge-only claims are not automatically reported as application findings.
Distinct observed failure fingerprints in a benchmark are all retained.

To append retained real records again after refining issue grouping:

```sh
npm run behavioral -- report --records=RECORD1.json,RECORD2.json
```

Exit codes: `0` verified pass, `1` observed behavioral failure/finding, `2`
inconclusive execution/configuration/isolation/provider failure, `130` operator
interruption. Resource limits
and missing endpoints are reported separately from incorrect model behavior.
See `tests/IMPLEMENTATION.md` for actual verification status and remaining gates.
