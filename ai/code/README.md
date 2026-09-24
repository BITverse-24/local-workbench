# ai/code — Flow B Python generation (active)

Purpose: the one active AI boundary. The model writes a single safe,
deterministic Python script for the current Flow B CSV task, using the
attached input and run-scoped output filenames supplied by the backend, and
later summarizes real sandbox execution output. This is the only AI contract
with live acceptance tests.

## Files

- `contract.ts` — `CodeModelRequest` / `CodeSummarizeRequest` /
  `CodeModelResponse`, `CodeDraftResult`, `PythonExecutionResult`,
  `CodeSummaryResult`.
- `prompts/coding-prompt.md` — the fixed Flow B prompt. The backend keeps a
  mirrored string (`CODE_SYSTEM_PROMPT`, owned by another lane); this file
  is the prompt source of truth for prompt-diff review.

## Expected identity and health

- Stable identity `code-qwen25coder` (see `../shared/types.ts`).
- Deployment: the model behind this identity runs through an
  OpenAI-compatible local service such as Ollama or llama-server reporting health at
  `GET <baseUrl>/models`; routing stays behind the stable ID so provider swaps
  need no contract change.

- Provider startup, weights, GPU startup, and supervision are outside this
  contract. The backend's typed `CodeModel` owns the runtime boundary while
  `ModelClient` owns transport/provider details.

## Request/response boundary

- Draft request: `task` + `inputFile` (`InputFileReference`, logical
  filenames only) + `allowedLanguage: "python"` + `executionRules`.
- Draft response: exactly `task.py` source plus `expectedResult`,
  `inputFiles`, `outputFiles`, `allowedImports`. Imports limited to `csv`
  and `datetime`; no network, shell, subprocess, dynamic code, environment
  access, or extra files; counts are calculated from the attached CSV, never
  hard-coded.
- Summarize request (`phase: "summarize"`, `responseFormat: "code-summary"`):
  the backend sends back the real `PythonExecutionResult`; the model returns
  a `CodeSummaryResult` (`summary`, `verified`) describing only what
  actually executed.

## Configuration

Timeout and provider routing come from `config/models.json` via the backend.
Locked Flow B rules for offline tests live in `../validation.ts`
(`LOCKED_FLOW_B_CODE_RULES`): 240 rows, 7 out-of-range (5 high, 2 low).

## Error behavior

Shape problems surface as `ValidationFailure` (`invalid-value` for
unapproved imports, paths, hard-coded counts, unsafe patterns);
transport problems as `AIError` (`unsafe_generated_code` for hostile
source). The backend re-validates, executes in the sandbox, and compares
actual output — the model's `expectedResult` is a description, not proof.

## Deployment assumptions

Stateless generation step. Sandbox policy (mounts, network isolation,
timeout, exit-code checks) is owned by the backend and never described by
the model beyond the fixed filenames.
