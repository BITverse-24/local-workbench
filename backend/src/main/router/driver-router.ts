import type { AttachmentReference, ModelId, TaskType } from "../../shared/contracts.js";

export interface DriverRoutingDecision {
  taskType: TaskType;
  modelId: ModelId;
  reason: string;
}

/**
 * Driver Router:
 * Selects which specialized model DRIVES the agent loop for the task.
 * Note: The driver can delegate to other specialists at any point via tools.
 *
 * Rules:
 * 1. If code scripts or CSV logs are attached with fix/crash/run intent -> code model drives
 * 2. If user is modifying/inspecting an active workspace with code keywords -> code model drives
 * 3. Otherwise (document synthesis, analytical compliance, drafting, pure chat) -> draft model drives
 */
export function pickDriverModel(
  userText: string,
  attachments: AttachmentReference[] = [],
  hasWorkspace = false,
): DriverRoutingDecision {
  const lower = userText.toLowerCase();

  const hasCodeAttachment = attachments.some(
    (a) =>
      a.filename?.endsWith(".py") ||
      a.filename?.endsWith(".js") ||
      a.filename?.endsWith(".ts") ||
      a.mediaType === "text/x-python" ||
      a.mediaType === "application/x-python-code",
  );

  const hasDataAttachment = attachments.some(
    (a) => a.mediaType === "text/csv" || a.filename?.endsWith(".csv"),
  );

  const hasCodeKeywords = /\b(code|function|script|bug|crash|error|traceback|fix|test|build|compile|refactor)\b/i.test(lower);

  // Case 1: Script repair or data calculation
  if (hasCodeAttachment || (hasDataAttachment && hasCodeKeywords)) {
    return {
      taskType: "code",
      modelId: "code-qwen25coder",
      reason: "code repair and execution workload",
    };
  }

  // Case 2: Explicit workspace code development
  if (hasWorkspace && hasCodeKeywords) {
    return {
      taskType: "code",
      modelId: "code-qwen25coder",
      reason: "workspace code engineering",
    };
  }

  // Case 3: Default driver (reasoning & drafting generalist)
  return {
    taskType: "draft",
    modelId: "draft-qwen3",
    reason: "analytical reasoning and technical drafting",
  };
}
