import { setTimeout } from "node:timers/promises";

export function throwIfInterrupted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Execution interrupted by operator");
}
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfInterrupted(signal);
  await setTimeout(ms, undefined, { signal });
}
