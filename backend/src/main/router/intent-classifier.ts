import type { ModelId, TaskType } from "../../shared/contracts.js";

export type ActionTarget = "harness" | "data" | "vision" | "chat";

export interface IntentDecision {
  taskType: TaskType;
  modelId: ModelId;
  actionTarget: ActionTarget;
  reason: string;
  isWorkspaceAction: boolean;
}

export interface ClassifyIntentInput {
  userText: string;
  attachment?: { mediaType: string; filename?: string };
  isWorkspaceActive?: boolean;
}

const FILE_ACTION_VERBS = /\b(create|write|save|make|add|generate|edit|modify|update|touch|delete|remove|append)\b/i;
const DIRECTORY_OR_FILE_NOUNS = /\b(file|files|txt file|folder|directory|dir|codebase|repo|workspace)\b/i;
const FILE_EXTENSION_PATTERN = /\b\w+\.(txt|js|ts|jsx|tsx|json|md|py|csv|html|css|yaml|yml|sh|env|sql|xml)\b/i;
const DIRECTORY_CONTEXT_PHRASES = /\b(in (the|this|my) (directory|folder|dir|workspace|project|repo|root))\b/i;

const COMMAND_ACTION_VERBS = /\b(run|execute|test|build|compile|install|start|deploy)\b/i;
const COMMAND_TARGET_NOUNS = /\b(command|cmd|terminal|shell|test suite|npm|pnpm|yarn|pip|git|pytest|vitest)\b/i;

const EXPLORATION_PHRASES = /\b(list files|show files|browse directory|search in (codebase|files|project)|find in files)\b/i;

const DATA_ANALYSIS_KEYWORDS = /\b(csv|calculation|calculate|dataset|rows|columns|data transformation|out-of-range|summary statistics|aggregat(e|ion)|sum|average|mean|median)\b/i;

/**
 * Intelligent, 0ms, non-LLM Intent Classifier.
 *
 * Evaluates environment state (active workspace), attached media (PDF/images/CSV),
 * and linguistic intent patterns to select the exact execution target:
 * - "harness": Workspace harness loop with real filesystem & command tools.
 * - "data": Sandboxed Python data runner (CSV or tabular data).
 * - "vision": Multi-modal document/image analysis.
 * - "chat": Conversational assistant with markdown formatting.
 */
export function classifyIntent(input: ClassifyIntentInput): IntentDecision {
  const { userText, attachment, isWorkspaceActive = false } = input;
  const lower = userText.toLowerCase();

  // 1. Vision Intent: Scanned reports, PDFs, images
  if (attachment && (attachment.mediaType === "application/pdf" || attachment.mediaType.startsWith("image/"))) {
    return {
      taskType: "vision",
      modelId: "vision-qwen25vl",
      actionTarget: "vision",
      reason: "scanned report",
      isWorkspaceAction: false,
    };
  }

  // 2. Data Intent: CSV attachment or explicit CSV/data processing with attachment
  if (
    attachment?.mediaType === "text/csv" ||
    (attachment && DATA_ANALYSIS_KEYWORDS.test(lower))
  ) {
    return {
      taskType: "code",
      modelId: "code-qwen25coder",
      actionTarget: "data",
      reason: "CSV/code intent",
      isWorkspaceAction: false,
    };
  }

  // 3. Workspace Intent: Explicit file operations, terminal commands, or project navigation
  const hasExplicitFileOperation =
    (FILE_ACTION_VERBS.test(lower) && (DIRECTORY_OR_FILE_NOUNS.test(lower) || FILE_EXTENSION_PATTERN.test(lower) || DIRECTORY_CONTEXT_PHRASES.test(lower))) ||
    DIRECTORY_CONTEXT_PHRASES.test(lower) ||
    FILE_EXTENSION_PATTERN.test(lower);

  const hasCommandAction =
    COMMAND_ACTION_VERBS.test(lower) && (COMMAND_TARGET_NOUNS.test(lower) || DIRECTORY_CONTEXT_PHRASES.test(lower));

  const hasExplorationAction = EXPLORATION_PHRASES.test(lower);

  if (hasExplicitFileOperation || hasCommandAction || hasExplorationAction) {
    return {
      taskType: "code",
      modelId: "code-qwen25coder",
      actionTarget: "harness",
      reason: hasExplicitFileOperation
        ? "workspace file modification"
        : hasCommandAction
        ? "workspace command execution"
        : "workspace exploration",
      isWorkspaceAction: true,
    };
  }

  // If a workspace is active and user asks project-internal questions
  if (isWorkspaceActive && /\b(codebase|files|function|class|bug|error|refactor|fix|how does|where is)\b/i.test(lower)) {
    return {
      taskType: "code",
      modelId: "code-qwen25coder",
      actionTarget: "harness",
      reason: "active workspace code inquiry",
      isWorkspaceAction: true,
    };
  }

  // 4. Default: Conversational drafting
  return {
    taskType: "draft",
    modelId: "draft-qwen3",
    actionTarget: "chat",
    reason: "fallback drafting",
    isWorkspaceAction: false,
  };
}
