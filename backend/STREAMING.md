# Run output and waiting states

The gateway reads model output during a request. RunManager sends progress through the existing `RunEvent` IPC channel. The renderer uses those events to show the current activity. The execution contract, approval gate, tool dispatch, result store, and artifact checks still control the run.

## Output channels

- Plain specialist drafts can show a live text preview of up to 800 characters in the waiting card. This preview is labelled as a draft in progress. It is separate from the validated final answer.
- Plain answer text uses `assistant_message_chunk`. The renderer groups updates within 50 ms. It drains pending text before a reset or final response.
- Provider reasoning fields and inline `<think>` blocks stay separate from answer text. Reasoning activity changes the waiting label. A reasoning-only response cannot complete a task.
- Native tool argument fragments stay in the gateway until the response is complete. Their character counts can update the waiting view. Tool execution still starts only after parsing and the existing checks.
- Specialist JSON output and the JSON tool fallback use streaming for progress. They do not send partial JSON to the answer bubble. Full source strings remain intact, including literal model delimiters in code.

## Progress events

`ModelGateway.onProgress` publishes `model_progress` events. Each request has an ID, model ID, purpose, optional parent tool call ID, status, channel, and received character count. An event can contain a bounded plain draft preview. It contains no private reasoning, partial JSON, or tool arguments. The character count is not a token count or a completion percentage.

The statuses are `waiting`, `receiving`, `received`, and `failed`. `received` means that the HTTP response arrived. It does not mean that the task or artifact passed validation. Updates are limited to one per 160 ms during generation. Request start, first output, and response end are sent immediately.

The renderer keeps up to eight current request snapshots. It replaces each snapshot by request ID. It excludes these snapshots from saved message activity and the transcript. RunManager stops progress publication after the run becomes terminal.

## Task checkpoints and partial answers

The existing `RunEvent` channel also carries `task_progress`. Its activity ID separates concurrent stages. The stage names cover source inspection, repair/draft generation, correction, pre/post-execution review, source coverage review, and saved-result checks. A checkpoint contains `active`, `completed`, or `blocked`, an optional target, parent tool/activity IDs, and optional assessed/total check counts. Nested corrections do not count their awaiting parent as another parallel task. A checkpoint carries no model response fragments. Parser errors use a fixed status reason; runtime errors retain their actual error message.

Check counts change only after complete review responses pass the existing parser and their indexes match the expected checks. Counts are assessments, not passes. A finished review does not grant acceptance. Existing prompts, request bodies, inference counts, output limits, review recovery, and completion rules remain unchanged. Progress observers cannot change an operation's result or error.

The waiting view chooses an explicit task stage before a tool label or model-channel fallback. Provider reasoning is secondary activity when a stage or tool is known. A compact summary shows up to three known rows in each of Confirmed, Now, and Still to check. Parallel stages remain separate; a nested tool, stage, and model request are not counted as three tasks. Approval pauses animation and the Now section. Late checkpoints after a terminal state are ignored.

For new partial runs, fixed Markdown templates add a summary to the existing saved assistant answer. Saved-file claims require registered files still present within the run's output directory. Exit-code claims require typed stored execution evidence. Completed workspace writes and deletions come from the existing operation ledger. Review checkpoints, missing requested deliverables, and failed or unverified mandatory checks describe remaining work. An older response-acceptance check does not override the saved response itself. Execution success never means full behavior acceptance. Diagnosis and observed output remain under Details. If the summary pushes the answer past the existing 32,768-character limit, the details are shortened with an explicit notice. Existing saved answers are not rewritten.

Task snapshots are replaced by activity ID in the renderer and retained in the activity view. RunManager keeps them only for the active run and clears them at the terminal state. The saved answer provides the partial summary after a history reload; no new table or history endpoint is required.

## Waiting view

`RunWaitingIndicator` shows the current tool or generation state, a code/document/text skeleton, the latest tool result, and an activity disclosure. It has no elapsed clock or estimated percentage. Approval stops skeleton animation. Reduced-motion settings disable waiting animations. The skeleton closes when plain text is already streaming.

The activity disclosure retains tool inputs and outputs for inspection. Visible model commentary is labelled as activity notes. It is not labelled as private reasoning. Plan items are not marked complete from an unrelated tool count.

## Transport limits

The stream reader handles split UTF-8 data, SSE events, tool argument fragments, provider usage, and the final finish reason. It retains the response deadline while reading the body. A lost connection or unfinished stream is a failure. A normal JSON response from a server that ignores streaming remains valid, but has no live token progress.

No extra model call is used to generate waiting text or summarize private reasoning. Model reasoning settings remain under the existing gateway configuration.
