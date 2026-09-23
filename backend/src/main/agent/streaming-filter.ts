/**
 * Sanitizes live streamed token deltas to guarantee that internal tool simulator tags
 * (such as [TOOL_RESULT], [END_TOOL_RESULT], [TOOL_CALL], <tool_call>, etc.)
 * are never leaked into the user-facing chat bubble.
 */
export class StreamingTagFilter {
  private buffer = "";
  private readonly onCleanChunk: (delta: string) => void;

  constructor(onCleanChunk: (delta: string) => void) {
    this.onCleanChunk = onCleanChunk;
  }

  process(delta: string): void {
    this.buffer += delta;

    // Strip any complete tool simulator tags
    const tagRegex = /\[\/?(?:TOOL_RESULT|END_TOOL_RESULT|ENDTOOLRESULT|TOOL_CALL|END_TOOL_CALL|ENDTOOLCALL)\]|<\/?(?:tool_call|tool_response|tool_result)[^>]*>/gi;
    this.buffer = this.buffer.replace(tagRegex, "");

    // Check if the tail ends with a potential opening bracket or tag prefix
    // (e.g. "[", "[TOOL", "[END", "<", "<tool", "</tool")
    const partialMatch = this.buffer.match(/(?:\[[A-Z_]*|<[a-z_/]*)$/i);
    if (partialMatch) {
      const holdBackLength = partialMatch[0].length;
      // Tags are at most 20 chars long; if longer, it's normal text and not a tag
      if (holdBackLength <= 20) {
        const toEmit = this.buffer.slice(0, -holdBackLength);
        this.buffer = this.buffer.slice(-holdBackLength);
        if (toEmit) {
          this.onCleanChunk(toEmit);
        }
        return;
      }
    }

    // No partial tag held back, emit full buffer
    if (this.buffer) {
      this.onCleanChunk(this.buffer);
      this.buffer = "";
    }
  }

  flush(): void {
    if (this.buffer) {
      const tagRegex = /\[\/?(?:TOOL_RESULT|END_TOOL_RESULT|ENDTOOLRESULT|TOOL_CALL|END_TOOL_CALL|ENDTOOLCALL)\]|<\/?(?:tool_call|tool_response|tool_result)[^>]*>/gi;
      const cleaned = this.buffer.replace(tagRegex, "");
      if (cleaned) {
        this.onCleanChunk(cleaned);
      }
      this.buffer = "";
    }
  }
}
