import type { AttachmentReference, ModelId, TaskType } from "../../shared/contracts.js";
import { resolveSemanticIntent, type SemanticIntent } from "./contextual-router.js";

export interface DriverRoutingDecision {
  taskType: TaskType;
  modelId: ModelId;
  reason: string;
}

/**
 * Driver Router:
 * Selects which specialized model DRIVES the agent loop for the task.
 * Note: In async agent workflows, `resolveSemanticIntent` is preferred as it
 * evaluates full multi-turn conversation history and workspace context.
 */
export function pickDriverModel(
  userText: string,
  attachments: AttachmentReference[] = [],
  hasWorkspace = false,
): DriverRoutingDecision {
  const lower = userText.toLowerCase();

  const isDraftingDoc = /\b(?:draft|drafting|approval\s*note|memo|executive\s*summary|deliverable|docx|word\s*doc|compliance\s*report)\b/i.test(lower);

  const isImageOrDoc = attachments.some(
    (a) =>
      a.mediaType?.startsWith("image/") ||
      a.mediaType === "application/pdf" ||
      /\.(?:png|jpe?g|webp|pdf|svg)$/i.test(a.filename ?? ""),
  );

  const hasCodeAttachment = attachments.some(
    (a) =>
      /\.(?:py|js|ts|jsx|tsx|json|sh|bash|css|html)$/i.test(a.filename ?? "") ||
      a.mediaType === "text/x-python" ||
      a.mediaType === "application/javascript" ||
      a.mediaType === "text/javascript" ||
      a.mediaType === "application/typescript",
  );

  const hasDataAttachment = attachments.some(
    (a) => a.mediaType === "text/csv" || a.filename?.endsWith(".csv"),
  );

  // Document drafting / synthesis (even with PDF/report attachments): draft model drives
  if (isDraftingDoc) {
    return {
      taskType: "draft",
      modelId: "draft-qwen3",
      reason: "document synthesis and drafting workload",
    };
  }

  // Pure vision / document inspection
  if (!hasWorkspace && isImageOrDoc && !hasCodeAttachment) {
    return {
      taskType: "vision",
      modelId: "vision-qwen25vl",
      reason: "visual document inspection",
    };
  }

  // Active workspace: default to code model unless explicit document drafting
  if (hasWorkspace) {
    if (isDraftingDoc) {
      return {
        taskType: "draft",
        modelId: "draft-qwen3",
        reason: "workspace document drafting and compliance",
      };
    }
    return {
      taskType: "code",
      modelId: "code-qwen25coder",
      reason: "workspace code engineering and file operations",
    };
  }

  // Script repair or data calculation
  if (hasCodeAttachment || hasDataAttachment) {
    return {
      taskType: "code",
      modelId: "code-qwen25coder",
      reason: "code repair and execution workload",
    };
  }

  // Code keywords in query without workspace
  const hasCodeKeywords = /\b(code|coding|function|script|route|middleware|api|app|server|backend|frontend|express|react|node|python|endpoint|bug|crash|error|traceback|fix|test|build|compile|refactor|class|method|module|library|install|package|npm|pip|scaffold|implement|develop|rate\s*limiter|auth)\b/i.test(lower);
  if (hasCodeKeywords) {
    return {
      taskType: "code",
      modelId: "code-qwen25coder",
      reason: "code engineering request",
    };
  }

  // Default driver (reasoning & drafting generalist)
  return {
    taskType: "draft",
    modelId: "draft-qwen3",
    reason: "analytical reasoning and technical drafting",
  };
}
