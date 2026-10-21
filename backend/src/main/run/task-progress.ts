import { randomUUID } from "node:crypto";
import type { TaskProgressEvent } from "../../shared/contracts.js";

export interface TaskProgressContext {
  runId: string;
  emitProgress?: (event: TaskProgressEvent) => void;
  isCancelled?: () => boolean;
  target?: string;
  parentCallId?: string;
  parentActivityId?: string;
}

function startActivity(context: TaskProgressContext, stage: TaskProgressEvent["stage"]) {
  const event: TaskProgressEvent = { type: "task_progress", runId: context.runId, activityId: randomUUID(), stage,
    status: "active", target: typeof context.target === "string" ? context.target.slice(0, 240) : undefined,
    parentCallId: typeof context.parentCallId === "string" ? context.parentCallId : undefined,
    parentActivityId: context.parentActivityId };
  const publish = () => {
    try { if (!context.isCancelled?.()) context.emitProgress?.({ ...event }); } catch { /* Observers cannot affect execution. */ }
  };
  publish();
  return {
    id: event.activityId,
    assess: (assessed: number, total: number, passed?: number, failed?: number) => {
      if (!Number.isInteger(assessed) || !Number.isInteger(total) || assessed < 0 || total < 1 || assessed > total) return;
      if (passed !== undefined && (!Number.isInteger(passed) || passed < 0 || passed > assessed)) return;
      if (failed !== undefined && (!Number.isInteger(failed) || failed < 0 || failed > assessed)) return;
      if (passed !== undefined && failed !== undefined && passed + failed !== assessed) return;
      if (event.assessedChecks === assessed && event.totalChecks === total && event.passedChecks === passed && event.failedChecks === failed) return;
      event.assessedChecks = assessed; event.totalChecks = total;
      event.passedChecks = passed; event.failedChecks = failed; publish();
    },
    block: (reason: string) => { event.status = "blocked"; event.reason = reason.slice(0, 500); },
    finish: () => { if (event.status === "active") event.status = "completed"; publish(); },
  };
}
type Activity = ReturnType<typeof startActivity>;
const errorReason = (error: unknown) => error instanceof Error
  ? error instanceof SyntaxError || error.name === "ZodError" ? "The response could not be parsed and validated." : error.message
  : "The operation did not finish.";

/** Observation only: callback errors and cancellation never change the work result. */
export async function withTaskProgress<T>(context: TaskProgressContext, stage: TaskProgressEvent["stage"],
  work: (activity: Activity) => Promise<T>): Promise<T> {
  const activity = startActivity(context, stage);
  try {
    const result = await work(activity);
    activity.finish();
    return result;
  } catch (error) {
    activity.block(errorReason(error));
    activity.finish();
    throw error;
  }
}

export function withTaskProgressSync<T>(context: TaskProgressContext, stage: TaskProgressEvent["stage"], work: (activity: Activity) => T): T {
  const activity = startActivity(context, stage);
  try {
    const result = work(activity); activity.finish(); return result;
  } catch (error) {
    activity.block(errorReason(error)); activity.finish(); throw error;
  }
}
