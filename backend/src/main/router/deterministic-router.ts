import type { ModelId, TaskType } from "../../shared/contracts.js";
import { classifyIntent } from "./intent-classifier.js";

export interface RouteDecision {
  taskType: TaskType;
  modelId: ModelId;
  reason: string;
}

export function routeTask(
  userText: string,
  attachment?: { mediaType: string; filename?: string } | Array<{ mediaType: string; filename?: string }>,
  isWorkspaceActive?: boolean,
): RouteDecision {
  const attachments = Array.isArray(attachment) ? attachment : attachment ? [attachment] : undefined;
  const singleAttachment = Array.isArray(attachment) ? attachment[0] : attachment;
  const decision = classifyIntent({
    userText,
    attachment: singleAttachment,
    attachments,
    isWorkspaceActive,
  });
  return {
    taskType: decision.taskType,
    modelId: decision.modelId,
    reason: decision.reason,
  };
}

export function routeSubtask(taskType: TaskType): RouteDecision {
  switch (taskType) {
    case "code":
      return { taskType: "code", modelId: "primary-model", reason: "code subtask execution" };
    case "draft":
    default:
      return { taskType: "draft", modelId: "primary-model", reason: "draft subtask execution" };
  }
}
