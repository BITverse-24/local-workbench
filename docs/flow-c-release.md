# Flow C replacement release

The old prompts supplied the findings in all three scenarios. Those recordings do not establish independent inspection or comparison. Treat them as invalid evidence for those claims.

The replacement fixtures are synthetic. C-1 and C-3 contain a rating in an embedded image. The text reader cannot supply that rating. C-2 remains a register review with a fixed review date.

## Checks before recording

Run:

```sh
npm run typecheck
npm test
python3 scripts/validate-demo-fixtures.py --flow-c
npm run demo:flow-c:release
```

The full fixture validator also checks other flows. Its existing Flow A setup-header failure is separate from the Flow C gate. Do not change or ignore a Flow C failure to obtain a pass.

The release command runs the three modes in fresh chats, then changes source values, spec limits, and register dates. It also checks unreadable evidence and missing Vision. Expected results stay under `tests/fixtures/demo/oracles/`; they are not copied into the application workspace or attachments.

Every attempt has a separate directory under `tests/.runtime/flow-c-release/`. It contains the runtime bundle hash, prompts, source hashes, model configuration, events, source views, extracted evidence, retrieved criteria, saved outputs, and evaluation results. Keep failed attempts. A partial positive case fails the gate. Negative cases must stop without claiming a complete review.

## Recording sequence

1. Use the same app build and model configuration that passed the full gate. Keep the gate result with the recording.
2. Show the synthetic source and the applicable standard. Show the neutral prompt from the scenario file. Do not enter observations or expected decisions into the request.
3. Run C-1 in Chat. Show the separate text-reading and visual-inspection steps. Show the findings and both observation and standard citations.
4. Run C-2 in Work. Open the saved Word note and show its valve rows, review date, decisions, missing evidence, and standard citations.
5. Run C-3 in Agent with only its supplied workspace selected. Show visual inspection, each branch decision, citations, and the unchanged source file.
6. Show one changed-input run and its changed result. Report any limit or uncertainty that appears.

Describe the result as an assisted review of synthetic inputs. Page coverage confirms which source views were processed. It does not prove that a model found every detail. Do not record a successful replacement while the release gate fails. Publication is a separate action.

## Page selection and recovery

Visual review uses source text and actual source images. Large pages receive an overview and overlapping close views. PDFs render at 150 DPI. Each transmitted view has a bounded size and a saved digest.

The app requests a page range when the file exceeds the page or run budget. It shows excluded pages in the evidence. A single page that cannot fit the detail budget needs a smaller source or region. Changing a source invalidates its selection. Cancellation clears the pending selection. Restart requires an explicit resume and a new pending selection; it does not replay work.

Missing Vision, invalid responses, unreadable evidence, conflicting readings, missing views, and changed source bytes prevent a complete visual review. Fix the cause and run the full gate again. Do not supply the expected answer to the model as a repair.
