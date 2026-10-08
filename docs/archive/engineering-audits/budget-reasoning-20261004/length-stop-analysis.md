# Length-stop analysis

Flow B had 3 length stops across 25 valid trials. The cross-workflow check had 5 further stops across 12 runs. In each case below, the response reached its output cap. The partial tool call had zero argument characters. The dispatcher did not run it.

| Run | Stage | Cap | Prompt tokens | Completion / reasoning tokens | Partial tool call | Result |
|---|---|---:|---:|---:|---|---|
| Flow B A0-02 working_1 | continuation / action proposal (stage inferred from prior tool sequence) | 1024 | 2798 | 1023 / 686 | write_file (0 argument chars) | Run partial; no completed mutation from this response |
| Flow B A0-03 working_2 | continuation / action proposal (stage inferred from prior tool sequence) | 1024 | 3491 | 1023 / 668 | write_file (0 argument chars) | Run partial; no completed mutation from this response |
| Flow B A4-02 working_4 | continuation / action proposal (stage inferred from prior tool sequence) | 4096 | 3956 | 4095 / 4095 | none | Run partial; no completed mutation from this response |
| flow-a A0 working_2 | continuation / next action proposal | 1024 | 6197 | 1023 / 503 | generate_deliverable (0 argument chars) | Run partial; proposed call was not executed |
| flow-a A1 working_2 | continuation / next action proposal | 1280 | 6228 | 1279 / 484 | generate_deliverable (0 argument chars) | Run partial; proposed call was not executed |
| financial A3 working_2 | continuation / next action proposal | 2048 | 6177 | 2047 / 964 | execute_python (0 argument chars) | Run partial; proposed call was not executed |
| financial A0 working_2 | continuation / next action proposal | 1024 | 6172 | 1023 / 449 | execute_python (0 argument chars) | Run partial; proposed call was not executed |
| financial A1 working_2 | continuation / next action proposal | 1280 | 6178 | 1279 / 460 | execute_python (0 argument chars) | Run partial; proposed call was not executed |

The clearest Flow B pattern is A0: two of five runs stopped at the action cap. The other three profiles A1–A3 had no Flow B length stops in five trials each. A4 had one stop in five trials, during its final answer stage after earlier tools had run. This small sample does not show that larger caps always improve completion. A4 took longer and still stopped once.

The cross-workflow check adds a second limit. Flow A stopped at A0 and A1 while preparing a deliverable. Financial reconciliation stopped at A0, A1, and A3 after reading both files and before Python execution. These are one-run observations per profile and workflow.

No partial call with zero argument characters was dispatched. The observed failures are truncation / completion failures, not executed malformed tool calls.
