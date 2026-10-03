import type { CompactionMetadata } from "../../shared/contracts.js";
import { encode } from "gpt-tokenizer";

export type { CompactionMetadata };

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

export function estimateMessageTokens(messages: AgentMessage[]): number {
  let count = 0;
  for (const m of messages) {
    count += 4;
    if (m.content) count += countTokens(m.content);
    if (m.tool_calls) count += countTokens(JSON.stringify(m.tool_calls));
  }
  return count;
}

export function estimateToolTokens(tools: any[]): number {
  if (!tools || tools.length === 0) return 0;
  return countTokens(JSON.stringify(tools));
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  turn?: number;
  toolName?: string;
  source?: string;
  rawContent?: string;
  compaction?: CompactionMetadata;
  resultId?: string;
}

/**
 * Model-facing observation size budgets per tool (P0-01 Specification).
 * Every model-facing tool observation is subject to these unconditional budgets.
 */
export const TOOL_OBSERVATION_BUDGETS: Record<string, number> = {
  read_file: 8000,
  search: 4000,
  list_dir: 4000,
  run_command: 3000,
  extract_document: 4000,
  retrieve_knowledge: 4000,
  retrieve_result: 4000,
  // Aliases / related tool names
  ocr_extract: 4000,
  inspect_drawing: 4000,
  retrieve_sop: 4000,
};

export const DEFAULT_TOOL_BUDGET = 4000;

/**
 * Unconditional global safety limit: No single model-facing tool observation
 * may exceed this threshold under any circumstance.
 */
export const GLOBAL_SAFETY_LIMIT = 8000;

/**
 * Tighter budgets for older turns (turns older than keepFullTurns cutoff)
 * to keep multi-turn context lean and avoid GPU VRAM / context window overflow.
 */
export const OLDER_TOOL_BUDGETS: Record<string, number> = {
  read_file: 4000,
  search: 2000,
  list_dir: 2000,
  run_command: 1500,
  extract_document: 2000,
  retrieve_knowledge: 2000,
  retrieve_result: 2000,
  ocr_extract: 2000,
  inspect_drawing: 2000,
  retrieve_sop: 2000,
};

export const DEFAULT_OLDER_TOOL_BUDGET = 2000;

/**
 * Line limits for older turns when multiline text is present,
 * ensuring balanced head/tail context without token bloat.
 */
export const OLDER_LINE_LIMITS: Record<string, number> = {
  read_file: 25,
  list_dir: 15,
  search: 12,
  run_command: 15,
  extract_document: 50,
  retrieve_knowledge: 40,
  ocr_extract: 50,
  inspect_drawing: 50,
  retrieve_sop: 40,
};

export const DEFAULT_OLDER_MAX_LINES = 25;

/**
 * Assistant message budgets:
 * Older intermediate assistant thinking turns are bounded while strictly
 * preserving tool_calls and conversation structure.
 */
export const OLDER_ASSISTANT_BUDGET = 1500;
export const RECENT_ASSISTANT_SAFETY_LIMIT = 12000;

export interface CompactObservationParams {
  content: string;
  toolName?: string;
  source?: string;
  isOlderTurn: boolean;
  maxBudget?: number;
  maxLines?: number;
  resultId?: string;
}

export interface CompactObservationResult {
  content: string;
  metadata: CompactionMetadata;
}

/**
 * Extracts a candidate source identifier (file path, query, command) from tool arguments.
 */
export function extractSourceArg(toolName: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  if (typeof args.result_id === "string") return args.result_id;
  if (typeof args.path === "string" && args.path.trim()) return args.path.trim();
  if (typeof args.filename === "string" && args.filename.trim()) return args.filename.trim();
  if (typeof args.filePath === "string" && args.filePath.trim()) return args.filePath.trim();
  if (typeof args.file === "string" && args.file.trim()) return args.file.trim();
  if (typeof args.document === "string" && args.document.trim()) return args.document.trim();
  if (typeof args.command === "string" && args.command.trim()) return args.command.trim();
  if (typeof args.query === "string" && args.query.trim()) return args.query.trim();
  if (typeof args.search_query === "string" && args.search_query.trim()) return args.search_query.trim();
  return "";
}

/**
 * Compacts a tool observation deterministically based on tool type, turn age,
 * and character/line budgets. Always enforces the global safety limit.
 */
export function compactToolObservation(params: CompactObservationParams): CompactObservationResult {
  // Reserve a prefix before applying existing budgets: head/tail compaction must never remove the ID.
  if (params.resultId) {
    const budget = Math.min(params.maxBudget ?? (params.isOlderTurn ? OLDER_TOOL_BUDGETS[params.toolName ?? ""] ?? DEFAULT_OLDER_TOOL_BUDGET : TOOL_OBSERVATION_BUDGETS[params.toolName ?? ""] ?? DEFAULT_TOOL_BUDGET), GLOBAL_SAFETY_LIMIT);
    const fullPrefix = `[DURABLE RESULT: ${params.resultId}; retrieve_result action=read result_id=${params.resultId}]\n`;
    const shortPrefix = `[DURABLE RESULT: ${params.resultId}; retrieve_result]\n`;
    const prefix = budget >= fullPrefix.length ? fullPrefix : shortPrefix;
    if (budget < prefix.length) throw new RangeError("Observation budget cannot preserve the durable result ID and retrieval instruction");
    const existingPrefix = params.content.startsWith(fullPrefix) ? fullPrefix : params.content.startsWith(shortPrefix) ? shortPrefix : "";
    const contentWithoutPrefix = params.content.slice(existingPrefix.length);
    const result = compactToolObservation({ ...params, content: contentWithoutPrefix, resultId: undefined, maxBudget: Math.max(1, budget - prefix.length) });
    const content = `${prefix}${result.content}`.slice(0, budget);
    return { content, metadata: { ...result.metadata, resultId: params.resultId, retainedChars: content.length } };
  }
  const { content, toolName, source, isOlderTurn } = params;
  if (!content) {
    return {
      content: "",
      metadata: {
        truncated: false,
        originalChars: 0,
        retainedChars: 0,
        toolName,
        source,
      },
    };
  }

  const toolKey = toolName ? toolName.toLowerCase() : "";
  const baseBudget = isOlderTurn
    ? (OLDER_TOOL_BUDGETS[toolKey] ?? DEFAULT_OLDER_TOOL_BUDGET)
    : (TOOL_OBSERVATION_BUDGETS[toolKey] ?? DEFAULT_TOOL_BUDGET);

  // Global safety limit is unconditionally enforced on all branches
  const targetBudget = Math.min(params.maxBudget ?? baseBudget, GLOBAL_SAFETY_LIMIT);
  const maxLines = params.maxLines ?? (isOlderTurn ? (OLDER_LINE_LIMITS[toolKey] ?? DEFAULT_OLDER_MAX_LINES) : undefined);

  const lines = content.split("\n");
  const exceedsChars = content.length > targetBudget;
  const exceedsLines = maxLines !== undefined && lines.length > maxLines;

  // If within budget and line limits, observation passes through uncompacted
  if (!exceedsChars && !exceedsLines) {
    return {
      content,
      metadata: {
        truncated: false,
        originalChars: content.length,
        retainedChars: content.length,
        toolName,
        source,
      },
    };
  }

  // Compaction required!
  const effectiveSource = source || (toolName ? `${toolName}_output` : "unknown");
  const retainedBudget = Math.min(content.length, targetBudget);

  const metadataJson = JSON.stringify(
    {
      truncated: true,
      originalChars: content.length,
      retainedChars: retainedBudget,
      toolName: toolName || "unknown",
      source: effectiveSource,
      ...(params.resultId ? { resultId: params.resultId } : {}),
    },
    null,
    2,
  );

  const resultIdNotice = params.resultId ? ` (resultId: ${params.resultId})` : "";
  const headerNotice = `[OBSERVATION COMPACTED: Truncated to fit context budget${resultIdNotice}]\n${metadataJson}\n\n`;
  const estimatedSeparatorLen = 140;
  const availableContentChars = Math.max(100, targetBudget - headerNotice.length - estimatedSeparatorLen);

  const headBudget = Math.floor(availableContentChars * 0.6);
  const tailBudget = availableContentChars - headBudget;

  let isMultilineFeasible = false;
  let headLines: string[] = [];
  let headChars = 0;
  let tailLines: string[] = [];
  let tailChars = 0;

  if (lines.length > 1) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (headChars + line.length + 1 > headBudget && headLines.length > 0) {
        break;
      }
      headLines.push(line);
      headChars += line.length + 1;
    }

    for (let i = lines.length - 1; i >= headLines.length; i--) {
      const line = lines[i];
      if (tailChars + line.length + 1 > tailBudget && tailLines.length > 0) {
        break;
      }
      tailLines.unshift(line);
      tailChars += line.length + 1;
    }

    // Check line limit constraints on older turns
    if (maxLines !== undefined && headLines.length + tailLines.length > maxLines) {
      const half = Math.floor(maxLines / 2);
      headLines = headLines.slice(0, half);
      tailLines = tailLines.slice(-half);
    }

    if (headLines.length > 0 && (headLines.length + tailLines.length) < lines.length) {
      isMultilineFeasible = true;
    }
  }

  let finalContent = "";
  let omittedLines: number | undefined;
  let omittedChars: number;

  if (isMultilineFeasible) {
    const retainedHead = headLines.join("\n");
    const retainedTail = tailLines.join("\n");
    omittedLines = lines.length - headLines.length - tailLines.length;
    omittedChars = content.length - retainedHead.length - retainedTail.length;

    const resultIdRef = params.resultId ? `; resultId: ${params.resultId}` : "";
    const separator = `\n... [compacted ${omittedChars} characters across ${omittedLines} lines; full data preserved in source: ${effectiveSource}${resultIdRef}] ...\n`;
    finalContent = `${headerNotice}${retainedHead}${separator}${retainedTail}`;
  } else {
    // Single-line JSON, minified text, or lines exceeding the head/tail budgets
    const retainedHead = content.slice(0, headBudget);
    const retainedTail = content.slice(-tailBudget);
    omittedChars = content.length - retainedHead.length - retainedTail.length;

    const resultIdRef = params.resultId ? `; resultId: ${params.resultId}` : "";
    const separator = `\n... [compacted ${omittedChars} characters; full observation preserved in source: ${effectiveSource}${resultIdRef}] ...\n`;
    finalContent = `${headerNotice}${retainedHead}${separator}${retainedTail}`;
  }

  // Unconditional safety limit check: ensure content never exceeds targetBudget or GLOBAL_SAFETY_LIMIT
  if (finalContent.length > targetBudget) {
    finalContent = finalContent.slice(0, targetBudget);
  }
  if (finalContent.length > GLOBAL_SAFETY_LIMIT) {
    finalContent = finalContent.slice(0, GLOBAL_SAFETY_LIMIT);
  }

  const metadata: CompactionMetadata = {
    truncated: true,
    originalChars: content.length,
    retainedChars: finalContent.length,
    toolName: toolName || "unknown",
    source: effectiveSource,
    omittedChars,
    omittedLines,
    resultId: params.resultId,
  };

  return {
    content: finalContent,
    metadata,
  };
}

/**
 * Summarize an individual tool result deterministically to save tokens on older turns.
 * Preserved for backwards compatibility with earlier agent loop callers and tests.
 */
export function compactToolResult(
  resultText: string,
  toolName?: string,
  source?: string,
  customBudget?: number,
): string {
  if (!resultText) return "";
  const res = compactToolObservation({
    content: resultText,
    toolName,
    source,
    isOlderTurn: true,
    maxBudget: customBudget,
  });
  return res.content;
}

export interface ContextCompactionOptions {
  keepFullTurns?: number;
  toolBudgets?: Record<string, number>;
  olderToolBudgets?: Record<string, number>;
  globalSafetyLimit?: number;
  olderAssistantBudget?: number;
}

/**
 * Context Manager:
 * Enforces deterministic, budget-aware context compaction over multi-turn conversations:
 * 1. Turn 0 (system): Never compacted (preserves prompt KV cache and core instructions).
 * 2. User prompt: Never compacted (preserves original user requirements).
 * 3. Assistant messages:
 *    - Older turns (<= cutoffTurn): Bounded to OLDER_ASSISTANT_BUDGET (1500 chars).
 *    - Recent turns: Capped by RECENT_ASSISTANT_SAFETY_LIMIT (12000 chars).
 *    - Assistant tool_calls are ALWAYS preserved to maintain valid OpenAI conversation format.
 * 4. Tool observations:
 *    - Subject to per-tool model-facing observation budgets (both old and recent).
 *    - Older turns subject to tighter budgets and line limits.
 *    - Single-line JSON and minified text are gracefully sliced with head/tail structure.
 *    - Compaction metadata is returned in the observation and attached to the message.
 *    - Global safety limit (8,000 chars) is unconditionally enforced across all branches.
 */
export function compactConversationHistory(
  messages: AgentMessage[],
  currentTurn: number,
  keepFullTurns = 2,
  options?: ContextCompactionOptions,
): AgentMessage[] {
  const cutoffTurn = currentTurn - keepFullTurns;

  return messages.map((msg) => {
    // 1. Never compact system or initial user message
    if (msg.role === "system" || msg.role === "user") {
      return msg;
    }

    // 2. Assistant message bounded compaction strategy
    if (msg.role === "assistant") {
      const isOlder = msg.turn !== undefined && msg.turn <= cutoffTurn;
      const budget = isOlder
        ? (options?.olderAssistantBudget ?? OLDER_ASSISTANT_BUDGET)
        : RECENT_ASSISTANT_SAFETY_LIMIT;

      if (msg.content && msg.content.length > budget) {
        const headChars = Math.floor(budget * 0.6);
        const tailChars = Math.floor(budget * 0.3);
        const omittedChars = msg.content.length - headChars - tailChars;
        const compactedContent = `${msg.content.slice(0, headChars)}\n... [compacted ${omittedChars} chars of assistant thinking for context budget] ...\n${msg.content.slice(-tailChars)}`;

        return {
          ...msg,
          content: compactedContent,
          rawContent: msg.rawContent ?? msg.content,
          // CRITICAL: Preserve tool_calls to ensure valid OpenAI-compatible sequence
          tool_calls: msg.tool_calls,
          compaction: {
            truncated: true,
            originalChars: msg.content.length,
            retainedChars: compactedContent.length,
            reason: isOlder ? "older_assistant_turn" : "recent_assistant_safety_limit",
          },
        };
      }

      return msg;
    }

    // 3. Tool observation compaction with deterministic budgeting
    if (msg.role === "tool") {
      const isOlder = msg.turn !== undefined && msg.turn <= cutoffTurn;
      const contentStr =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
          ? JSON.stringify(msg.content)
          : "";

      const result = compactToolObservation({
        content: contentStr,
        toolName: msg.toolName,
        source: msg.source,
        isOlderTurn: isOlder,
        maxBudget: options?.globalSafetyLimit,
        resultId: msg.resultId,
      });

      if (result.metadata.truncated || msg.resultId) {
        return {
          ...msg,
          content: result.content,
          rawContent: msg.rawContent ?? contentStr,
          compaction: result.metadata,
        };
      }

      return msg;
    }

    return msg;
  });
}

export interface ContextBudgetPlan {
  contextLimit: number;
  safetyMargin: number;
  toolTokens: number;
  messageTokens: number;
  maxGenerationTokens: number;
  isOverBudget: boolean;
}

/**
 * Pre-invocation context window budgeting (Phase 4).
 * Ensures combined serialized messages, tool schemas, generation allowance and safety margin
 * fit within the configured context window limit (e.g. 8,192 tokens).
 */
export function enforceContextBudget(
  messages: AgentMessage[],
  tools: any[],
  contextLimit = 8192,
  options?: {
    safetyMargin?: number;
    minGenerationTokens?: number;
    requestedGenerationTokens?: number;
    currentTurn?: number;
  },
): {
  messages: AgentMessage[];
  maxGenerationTokens?: number;
  budgetPlan: ContextBudgetPlan;
} {
  const safetyMargin = options?.safetyMargin ?? 256;
  const minGenerationTokens = options?.minGenerationTokens ?? 256;
  const currentTurn = options?.currentTurn ?? 1;
  const toolTokens = estimateToolTokens(tools);
  const requestedGen = options?.requestedGenerationTokens;

  const targetGen = requestedGen !== undefined
    ? Math.min(requestedGen, Math.max(minGenerationTokens, Math.floor(contextLimit * 0.5)))
    : 1024;

  // 1. Initial standard compaction (sliding window of 2 turns)
  let compacted = compactConversationHistory(messages, currentTurn, 2);
  let messageTokens = estimateMessageTokens(compacted);

  // 2. If messages + toolTokens + targetGen + safetyMargin > contextLimit, compact more aggressively
  if (messageTokens + toolTokens + targetGen + safetyMargin > contextLimit) {
    // Stage 1 aggressive: keep 1 full turn, tighten older assistant and tool observation budgets
    compacted = compactConversationHistory(messages, currentTurn, 1, {
      olderAssistantBudget: 800,
      globalSafetyLimit: 3000,
    });
    messageTokens = estimateMessageTokens(compacted);

    // Stage 2 aggressive: if still over budget, tighten all past turns
    if (messageTokens + toolTokens + minGenerationTokens + safetyMargin > contextLimit && currentTurn > 1) {
      compacted = compactConversationHistory(messages, currentTurn, 0, {
        olderAssistantBudget: 400,
        globalSafetyLimit: 1500,
      });
      messageTokens = estimateMessageTokens(compacted);
    }
  }

  // 3. Compute budget-aware generation allowance
  const remainingTokens = Math.max(minGenerationTokens, contextLimit - safetyMargin - toolTokens - messageTokens);
  let maxGenerationTokens: number | undefined = undefined;
  if (requestedGen !== undefined) {
    maxGenerationTokens = Math.min(requestedGen, remainingTokens);
  } else if (remainingTokens < 2048) {
    maxGenerationTokens = remainingTokens;
  }

  return {
    messages: compacted,
    maxGenerationTokens,
    budgetPlan: {
      contextLimit,
      safetyMargin,
      toolTokens,
      messageTokens,
      maxGenerationTokens: maxGenerationTokens ?? remainingTokens,
      isOverBudget: messageTokens + toolTokens + (maxGenerationTokens ?? minGenerationTokens) + safetyMargin > contextLimit,
    },
  };
}
