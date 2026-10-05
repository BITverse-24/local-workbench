# Flow A, B and C: verified CLI results

Verified on 5 October 2026 with LM Studio and `qwen2.5-coder-7b-instruct-mlx`. The final batch passed all 18 runs: six normal-language prompt variants per flow. The normal `npm run demo` command then passed all three flows. All 21 runs passed on the first attempt, with no tool errors or retries. Each executed run remains completed in SQLite after worker shutdown.

The 18-run average, including worker start and knowledge-base setup, was **23.6 seconds**. The slowest flow took **39.6 seconds**. All three flow averages are below 70 seconds. Every run is below the 90-second cutoff.

| Flow | Runs | Mean response | Mean with setup | Maximum with setup | Mean output tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 6 | 38.9s | 39.3s | 39.6s | 670 |
| B | 6 | 13.2s | 13.5s | 16.7s | 257 |
| C | 6 | 17.7s | 18.1s | 22.0s | 296 |

The separate CLI demo averaged 22.7s with setup. Across all 21 final runs, the average was 23.5s.

Each flow used two model calls: one intent interpretation and one work turn. No reasoning tokens were generated. The model stays selected for the whole run. The saved application settings and the CLI registry both select the requested model.

Tool selection uses the model's semantic interpretation and the current capabilities and evidence state. Short execution rules stay with the selected tools on every turn. There are no keyword intent overrides in the active execution path. Runtime code has no demo identifiers, fixed findings, fixture measurements, or preset compliance decisions.

The changes reduce repeated reads, repeated exports and duplicate final generation. Short native document sources and real retrieved clauses are supplied once. Code repairs use model-written exact edits, preserve the original interface, run the saved source on real data, and return its actual output. Digital drawing labels retain their source layout. Errors remain errors; no fake result replaces a failed model or tool.

The selected model uses an 8,192-token context, temperature 0 and a 1,024-token work-turn output cap. Intent output is capped at 768 tokens. Its tool transport uses compact JSON because the native tool format was unreliable with this endpoint. At the stated 22 tokens/second, 1,024 output tokens take about 47 seconds before other work.

The evaluator checks:

- Flow A: both reports and every source page; actual wall ranges, minimum limits and pitting depth; both inspector instructions; gasket findings; a cited conditional clearance decision for each equipment item; the exported Word file and final chat.
- Flow B: the actual exported Python source and its original CLI interface; successful app execution; independent results on the supplied CSV; another dataset with equality, missing and invalid numeric values.
- Flow C: the actual valve tag and rating; the discharge size; correct governing sections and corrective actions; real knowledge retrieval; no invented scale requirement or valve rating assigned to the pump.

Timing starts before attachment registration for response latency. The second timer also includes worker start and knowledge-base ingestion. Both stop at the final response. CLI confirmations are approved at once; human wait time is not measured. The benchmark cancels an unfinished run at 90 seconds. Each trial has a fresh run directory, chat and database; no output is reused.

This campaign uses PDF text layers and SVG text labels. It does not test OCR for image-only scans.

Run one trial per flow:

```sh
npm run demo
```

Run six prompt variants per flow:

```sh
npm run benchmark:demo
```

Type checking and the full application build passed. The 15 new regression checks passed. The full test suite has 604 passes, 58 failures and 6 skips. The unchanged baseline had 64 failures. Every remaining failing test also failed in that baseline; no new failing test was found.

[Full results, all prompts, outputs and telemetry](/Users/krishay/projects/agent/tests/.runtime/latency/verified-acceptance/results.json). [Normal CLI demo results](/Users/krishay/projects/agent/tests/.runtime/latency/cli-demo/results.json). [Test comparison](/Users/krishay/projects/agent/tests/.runtime/latency/verified-acceptance/verification/test-comparison.json). [Persisted run states](/Users/krishay/projects/agent/tests/.runtime/latency/verified-acceptance/verification/persisted-states.json).

Sample outputs:
- [Word approval note](/Users/krishay/projects/agent/tests/.runtime/latency/verified-acceptance/A-1/data/runs/daf8f5b8-343b-4e22-95ec-f5f6e27edbde/output/approval_note.docx)
- [Repaired Python source](/Users/krishay/projects/agent/tests/.runtime/latency/verified-acceptance/B-1/data/runs/78a849e5-287b-4353-977a-935e5ebc8ebf/output/fixed-vendor-log-parser.py)
- [Drawing review and checks](/Users/krishay/projects/agent/tests/.runtime/latency/verified-acceptance/C-1/evaluation.json)
