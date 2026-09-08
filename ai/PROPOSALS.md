# PROPOSALS — ai/ (source-of-truth registry)

## 1. Update `developmentModelRegistry` slugs (OpenRouter removals)

* **Target:** `ai/model-registry.ts:10` (`developmentModelRegistry`, 3 entries)
* **Issue:** All three `model` slugs were removed from OpenRouter and now return
  `404 No endpoints found` on `POST /chat/completions`:
  * `qwen/qwen2.5-vl-3b-instruct` — absent from live `GET /models`
  * `qwen/qwen3-4b` — absent (no 4B Qwen3 on OpenRouter; smallest is 8B)
  * `qwen/qwen2.5-coder-7b-instruct` — absent (only `32b` 2.5-coder remains)
* **Evidence:** Live `https://openrouter.ai/api/v1/models` fetched 2026-09-08;
  exact-slug search returned ABSENT for all three. Runtime copy
  `backend/config/models.json` already updated to the replacements below.
* **Suggested change:** Mirror the runtime copy:
  * `vision-qwen25vl` → `qwen/qwen3-vl-32b-instruct`
  * `draft-qwen3` → `qwen/qwen3-8b`
  * `code-qwen25coder` → `qwen/qwen3-coder`
* **Reason:** Keeps the source of truth consistent with the working dev config;
  same Qwen family, cheapest living tiers with the required modalities
  (vision entries verified `text+image` input).
* **Impact:** Prompt freeze notes referencing Qwen2.5-VL-3B / Qwen3-4B /
  Qwen2.5-Coder-7B (`TASKS.md` 5b/6b/8a, rehearsal docs) should be re-checked
  against the new slugs; costs drop vs 72B alternatives.

## 2. Add `maxOutputTokens` to registry entries + `maxTokens` to requests

* **Target:** `ai/model-registry.ts` (entry type + `developmentModelRegistry`),
  `ai/contracts.md` (ModelRequest / registry shape)
* **Issue:** Neither the registry type nor any request carries an output-token
  cap, and the gateway never sent `max_tokens`. OpenRouter then defaults the
  cap to the model's full window and pre-checks affordability, so even small
  calls fail with `402 ... You requested up to 32768 tokens, but you can only
  afford 15719` on low-credit keys.
* **Evidence:** Live 402 body on `qwen/qwen3-vl-32b-instruct`; gateway code sent
  no `max_tokens` (`backend/src/main/gateway/model-gateway.ts` before fix).
* **Suggested change:** Mirror the runtime copy (`backend/config/models.json`,
  `backend/src/shared/contracts.ts`, `backend/src/main/gateway/registry.ts`
  zod schema):
  * optional `maxOutputTokens` on registry entries:
    `vision-qwen25vl` 4096, `draft-qwen3` 8192, `code-qwen25coder` 8192
  * optional per-request `maxTokens` override; gateway sends
    `max_tokens = request.maxTokens ?? model.maxOutputTokens ?? 2048`
  * per-call overrides in `RunManager`: chat 1024, vision 4096,
    draft-result 8192, code-result 8192, code-summary 1024
  * 402 now surfaces as `insufficient OpenRouter credits for model ...`
* **Reason:** Caps output spend per call shape; chat/summary stop reserving
  32k-token maxima they never use.
* **Impact:** Very large outputs (draft body up to 40k chars, vision
  sourceText up to 50k) can truncate against the caps and fail strict
  validation — acceptable for the locked demo flows; raise caps if
  truncation appears. Large PDF/image inputs still bill input tokens, so
  free-tier keys may need credits regardless.

## 3. Gate `code` routing on attachment presence

* **Target:** `ai/` router spec (`deterministic-router` behavior)
* **Issue:** Any text matching `\b(csv|calculation|script|code|execute|
  execution|data transformation)\b` routed to the locked code flow even with
  no attachment, where `RunManager.execute` can only throw
  `an attachment is required for the locked flow`. E.g. "write me a small
  script" always failed.
* **Evidence:** `backend/src/main/run/manager.ts:191-194` fallthrough;
  `backend/src/main/router/deterministic-router.ts` before fix.
* **Suggested change:** Mirror the runtime router: return the `code` route
  only when an attachment is present; otherwise fall through to `draft`
  (chat), so attachment-less script/code asks get a chat answer.
* **Reason:** Flow B fundamentally needs a CSV (reads it, builds `inputFile`,
  verifies a locked execution output); routing there without one is a
  guaranteed failure.
* **Impact:** "CSV intent" phrases without an attached file now chat instead
  of erroring; attach-then-ask flow unchanged.

## 4. Backend now embeds the ai/ prompts verbatim — keep them in lockstep

* **Target:** `ai/ocr-vision-prompt.md`, `ai/approval-note-drafting-prompt.md`,
  `ai/coding-prompt.md` (no change requested; process note)
* **Issue (was):** `RunManager` sent placeholder one-liners and raw user text
  instead of the ai/ prompts; the draft call never included findings, chunks,
  or template requirements, so grounded citations were impossible.
* **Evidence:** `backend/src/main/run/manager.ts` before fix; byte-compare of
  built `prompts.js` against the ai/ ```text blocks now reports IDENTICAL
  (vision system/user, draft system, code system, draft template fill).
* **Suggested change:** None to the prompt text. Going forward, any edit to
  the three ai/ prompt files must be mirrored into
  `backend/src/main/run/prompts.ts` (header comments cite the sources) or
  `backend/tests/prompts.test.ts` ("ai/ prompt wiring") will fail on its
  lockstep markers.
* **Reason:** The backend is now the consumer the ai/ prompts were written
  for; drift reintroduces ungrounded drafts and weak code output.
* **Impact:** Prompt tuning happens in ai/ first, then a mechanical mirror —
  single direction, no forks.
