import type { TaskProgressEvent } from "./contracts.js";

/** A retry updates the same visible stage; separate file operations stay separate. */
export function taskProgressKey(event: Pick<TaskProgressEvent, 'runId' | 'stage' | 'target' | 'parentCallId'>): string {
  return JSON.stringify([event.runId, event.stage, event.target ?? null, event.target ? null : event.parentCallId ?? null]);
}

/** Fixed presentation text. A finished review is not a passed acceptance check. */
export const TASK_STAGE_LABELS: Record<TaskProgressEvent["stage"], { active: string; completed: string; remaining: string; kind: "code" | "document" | "text" }> = {
  source_text: { active: "Reading source text", completed: "Source text read", remaining: "Source text", kind: "document" },
  visual_inspection: { active: "Inspecting drawing/pages", completed: "Visual inspection finished", remaining: "Visual inspection", kind: "document" },
  requirements: { active: "Checking requirements", completed: "Requirements recorded", remaining: "Requirements", kind: "text" },
  input_preparation: { active: "Reading inputs", completed: "Inputs prepared", remaining: "Input preparation", kind: "document" },
  artifact_generation: { active: "Creating outputs", completed: "Outputs created", remaining: "Outputs", kind: "document" },
  delivery: { active: "Preparing delivery", completed: "Delivery ready", remaining: "Delivery", kind: "document" },
  source_inspection: { active: "Reviewing source behavior", completed: "Source inspection finished", remaining: "Source inspection", kind: "code" },
  repair_generation: { active: "Preparing the repair", completed: "Repair response received", remaining: "Complete repair response", kind: "code" },
  draft_generation: { active: "Preparing the draft", completed: "Draft response received", remaining: "Complete draft response", kind: "document" },
  pre_execution_review: { active: "Checking the proposed repair", completed: "Pre-execution review finished", remaining: "Proposed repair review", kind: "code" },
  post_execution_review: { active: "Checking the executed repair", completed: "Behavior review finished", remaining: "Complete behavior coverage", kind: "code" },
  source_coverage_review: { active: "Reviewing draft coverage", completed: "Draft coverage review finished", remaining: "Draft coverage", kind: "document" },
  correction: { active: "Addressing the review findings", completed: "Correction response received", remaining: "Review findings", kind: "text" },
  result_verification: { active: "Checking the saved results", completed: "Result checks finished", remaining: "Result verification", kind: "text" },
};

export function assessedCheckLabel(event: Pick<TaskProgressEvent, "assessedChecks" | "totalChecks" | "passedChecks" | "failedChecks">): string | undefined {
  const { assessedChecks: assessed, totalChecks: total } = event;
  if (assessed === undefined || total === undefined || !Number.isInteger(assessed) || !Number.isInteger(total) || assessed < 0 || total < 1 || assessed > total) return undefined;
  if (Number.isInteger(event.passedChecks) && Number.isInteger(event.failedChecks) &&
      event.passedChecks! >= 0 && event.failedChecks! >= 0 && event.passedChecks! + event.failedChecks! === assessed) {
    if (event.failedChecks) return `${assessed} of ${total} reviewed · ${event.failedChecks} need correction`;
    if (assessed === total) return `${event.passedChecks} of ${total} passed in this review`;
  }
  return `${assessed} of ${total} checks assessed`;
}
