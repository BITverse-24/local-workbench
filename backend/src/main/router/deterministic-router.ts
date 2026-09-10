import type { ModelId, TaskType } from "../../shared/contracts.js";
export interface RouteDecision { taskType: TaskType; modelId: ModelId; reason: string; }
export function routeTask(userText: string, attachment?: { mediaType: string }): RouteDecision {
  const lower = userText.toLowerCase();
  if (attachment && (attachment.mediaType === "application/pdf" || attachment.mediaType.startsWith("image/")))
    return { taskType: "vision", modelId: "vision-qwen25vl", reason: "scanned report" };

  // A CSV is data input, even when the request is phrased as a summary or
  // question rather than an explicit coding instruction. Keeping it on the
  // code/data route is important: the draft flow only receives user text and
  // would otherwise call the model without the attachment context.
  if (
    attachment?.mediaType === "text/csv" ||
    (attachment && /\b(csv|calculation|script|code|execute|execution|data transformation)\b/.test(lower))
  )
    return { taskType: "code", modelId: "code-qwen25coder", reason: "CSV/code intent" };

  return { taskType: "draft", modelId: "draft-qwen3", reason: "fallback drafting" };
}
