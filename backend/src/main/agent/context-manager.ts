export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  turn?: number;
  toolName?: string;
}

/**
 * Truncate long text keeping head and tail for compact model context.
 */
function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const half = Math.floor(maxLines / 2);
  return [
    ...lines.slice(0, half),
    `... [compacted ${lines.length - maxLines} lines] ...`,
    ...lines.slice(-half),
  ].join("\n");
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [compacted]`;
}

/**
 * Summarize an individual tool result deterministically to save tokens on older turns.
 */
export function compactToolResult(resultText: string, toolName?: string): string {
  if (!resultText) return "";
  switch (toolName) {
    case "list_dir":
      return truncateLines(resultText, 15);
    case "read_file":
      return truncateLines(resultText, 25);
    case "search":
      return truncateLines(resultText, 12);
    case "run_command":
      return truncateLines(resultText, 15);
    case "extract_document":
      return truncateChars(resultText, 400);
    case "retrieve_knowledge":
      return truncateChars(resultText, 350);
    default:
      return truncateChars(resultText, 250);
  }
}

/**
 * Context Manager:
 * Enforces a sliding-window compaction strategy over multi-turn conversations:
 * - Turn 0 (system): Never compacted (preserves prompt KV cache).
 * - User prompt: Never compacted.
 * - Most recent 2 turns: Kept in full (full arguments & outputs for immediate reasoning).
 * - Turns older than 2 turns: Tool result strings are deterministically compacted.
 */
export function compactConversationHistory(
  messages: AgentMessage[],
  currentTurn: number,
  keepFullTurns = 2,
): AgentMessage[] {
  const cutoffTurn = currentTurn - keepFullTurns;

  return messages.map((msg) => {
    // Never compact system or initial user message
    if (msg.role === "system" || msg.role === "user") {
      return msg;
    }

    // Only compact tool outputs that occurred before the cutoff turn
    if (msg.role === "tool" && msg.turn !== undefined && msg.turn <= cutoffTurn && msg.content) {
      return {
        ...msg,
        content: compactToolResult(msg.content, msg.toolName),
      };
    }

    // Safety guard: even on recent turns, prevent a single giant tool output from overflowing model context
    if (msg.role === "tool" && msg.content && msg.content.length > 24000) {
      return {
        ...msg,
        content: `${msg.content.slice(0, 16000)}\n... [compacted ${msg.content.length - 20000} chars to preserve model context] ...\n${msg.content.slice(-4000)}`,
      };
    }

    return msg;
  });
}
