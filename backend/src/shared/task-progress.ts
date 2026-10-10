import type { TaskProgressEvent } from "./contracts.js";

/** Fixed presentation text. A finished review is not a passed acceptance check. */
export const TASK_STAGE_LABELS: Record<TaskProgressEvent["stage"], { active: string; completed: string; remaining: string; kind: "code" | "document" | "text" }> = {
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

export function assessedCheckLabel(event: Pick<TaskProgressEvent, "assessedChecks" | "totalChecks">): string | undefined {
  const { assessedChecks: assessed, totalChecks: total } = event;
  if (assessed === undefined || total === undefined || !Number.isInteger(assessed) || !Number.isInteger(total) || assessed < 0 || total < 1 || assessed > total) return undefined;
  return `${assessed} of ${total} checks assessed`;
}
