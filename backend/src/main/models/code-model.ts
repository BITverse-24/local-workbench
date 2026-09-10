import { randomUUID } from "node:crypto";
import type { ModelClient } from "./ports.js";
import type {
  AIResult,
  CodeDraftResult,
  CodeModelRequest,
  CodeSummarizeRequest,
  CodeSummaryResult,
  ModelResponse,
} from "../../shared/contracts.js";
import { validateCode, validateCodeSummary } from "../validators/responses.js";

/** Typed code-model boundary. HTTP/provider details stay inside ModelClient. */
export class CodeModel {
  constructor(private readonly client: ModelClient) {}

  async generate(request: CodeModelRequest): Promise<AIResult<CodeDraftResult>> {
    const response = await this.client.complete(request);
    if (!response.ok) return response;
    const result = validateCode((response.value as ModelResponse).result);
    if (result.ok) return result;

    // Small coding models commonly add a CLI wrapper or a second file on the
    // first pass. Give the same provider one explicit, bounded correction
    // opportunity, while still validating the corrected result identically.
    const retry = await this.client.complete({
      ...request,
      requestId: randomUUID(),
      userPrompt: `${request.userPrompt}\n\n[VALIDATION FEEDBACK]\nThe previous draft was rejected: ${result.error.message}. Return a corrected JSON object. Do not import sys or use command-line arguments. Use the supplied logical input filename directly. Outputs may be empty for print-only analysis; otherwise declare every output file.\n[/VALIDATION FEEDBACK]`,
    });
    if (!retry.ok) return retry;
    const corrected = validateCode((retry.value as ModelResponse).result);
    return corrected.ok ? corrected : { ok: false, error: corrected.error };
  }

  async summarize(request: CodeSummarizeRequest): Promise<AIResult<CodeSummaryResult>> {
    const response = await this.client.complete(request);
    if (!response.ok) return response;
    const result = validateCodeSummary((response.value as ModelResponse).result);
    if (result.ok) return result;

    const retry = await this.client.complete({
      ...request,
      requestId: randomUUID(),
      userPrompt: `${request.userPrompt}\n\n[VALIDATION FEEDBACK]\nThe previous summary was rejected: ${result.error.message}. Return exactly one JSON object with both string field \"summary\" and boolean field \"verified\". Set verified to true only because the supplied execution result has already passed backend checks.\n[/VALIDATION FEEDBACK]`,
    });
    if (!retry.ok) return retry;
    const corrected = validateCodeSummary((retry.value as ModelResponse).result);
    return corrected.ok ? corrected : { ok: false, error: corrected.error };
  }
}
