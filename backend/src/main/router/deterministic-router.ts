import type { ModelId, TaskType } from "../../shared/contracts.js";
import { classifyIntent } from "./intent-classifier.js";

export interface RouteDecision {
  taskType: TaskType;
  modelId: ModelId;
  reason: string;
}

export function routeTask(
  userText: string,
  attachment?: { mediaType: string },
  isWorkspaceActive?: boolean,
): RouteDecision {
  const decision = classifyIntent({ userText, attachment, isWorkspaceActive });
  return {
    taskType: decision.taskType,
    modelId: decision.modelId,
    reason: decision.reason,
  };
}

export function routeSubtask(taskType: TaskType): RouteDecision {
  switch (taskType) {
    case "code":
      return { taskType: "code", modelId: "code-qwen25coder", reason: "code subtask execution" };
    case "draft":
    default:
      return { taskType: "draft", modelId: "draft-qwen3", reason: "draft subtask execution" };
  }
}
