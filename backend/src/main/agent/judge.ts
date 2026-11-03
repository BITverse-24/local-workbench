import type { InferenceRole } from "../gateway/telemetry.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { createHash } from "node:crypto";

export interface Judge<I, V> {
  name: InferenceRole;
  /** Deterministic pre-check; undefined means model inference is required. */
  decide(input: I): V | undefined;
  /** Digest of normalized input for caching. */
  cacheKey(input: I): string;
  /** Model fallback when deterministic check cannot decide. */
  ask(input: I, ctx: ToolExecutionContext): Promise<V>;
}

export function hashInput(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function runJudge<I, V>(
  judge: Judge<I, V>,
  input: I,
  ctx: ToolExecutionContext
): Promise<V> {
  // 1. Deterministic fast path
  const deterministic = judge.decide(input);
  if (deterministic !== undefined) {
    return deterministic;
  }

  // 2. Check result store cache if available
  const key = judge.cacheKey(input);
  if (ctx.resultStore) {
    try {
      const cached = ctx.resultStore.listResults({
        limit: 50,
        origin: "model_derived"
      }).find(r => r.producer.tool === `judge_${judge.name}` && r.producer.callId === key);
      if (cached) {
        const payloadText = ctx.resultStore.readResultPayload(cached.resultId);
        const data = JSON.parse(payloadText);
        if (data && data.verdict !== undefined) {
          return data.verdict as V;
        }
      }
    } catch {
      // Ignore cache read failures
    }
  }

  // 3. Fallback to model inference
  const verdict = await judge.ask(input, ctx);

  // 4. Save to cache in result store
  if (ctx.resultStore) {
    try {
      ctx.resultStore.registerResult({
        type: "structured",
        status: "complete",
        origin: "model_derived",
        producer: { tool: `judge_${judge.name}`, callId: key },
        summary: `Cached verdict for ${judge.name}`,
        payload: { key, verdict },
        sources: []
      });
    } catch {
      // Ignore cache write failures
    }
  }

  return verdict;
}
