import { ReasoningStreamFilter } from "../gateway/completion-stream.js";

/** Keep private reasoning and executable tool envelopes out of the live answer. */
export class StreamingTagFilter {
  private buffer = "";
  private blockedTag: string | null = null;
  private blockedJson = false;
  private atLineStart = true;
  private inFence = false;
  private readonly reasoningFilter: ReasoningStreamFilter;

  constructor(private readonly onCleanChunk: (delta: string) => void) {
    this.reasoningFilter = new ReasoningStreamFilter(delta => this.processVisible(delta));
  }

  process(delta: string): void { this.reasoningFilter.process(delta); }

  private processVisible(delta: string, final = false): void {
    if (this.blockedJson) return;
    this.buffer += delta;
    const markers = ["<tool_call>", "[TOOL_CALL]", "[TOOL_RESULT]", "[END_TOOL_RESULT]", "[ENDTOOLRESULT]", "<tool_response>", "</tool_response>", "<tool_result>", "</tool_result>"];
    let visible = "";
    try {
      while (this.buffer) {
        if (this.blockedTag) {
          const close = this.buffer.toLowerCase().indexOf(this.blockedTag.toLowerCase());
          if (close < 0) {
            this.buffer = final ? "" : this.buffer.slice(-(this.blockedTag.length - 1));
            return;
          }
          this.buffer = this.buffer.slice(close + this.blockedTag.length);
          this.blockedTag = null;
          continue;
        }
        const lower = this.buffer.toLowerCase();
        const marker = !this.inFence && markers.find(item => lower.startsWith(item.toLowerCase()));
        if (marker) {
          this.buffer = this.buffer.slice(marker.length);
          if (marker === "<tool_call>") this.blockedTag = "</tool_call>";
          if (marker === "[TOOL_CALL]") this.blockedTag = "[END_TOOL_CALL]";
          continue;
        }
        if (!final && markers.some(item => item.toLowerCase().startsWith(lower))) return;
        if (this.atLineStart && this.buffer.startsWith("`")) {
          const newline = this.buffer.indexOf("\n");
          if (newline < 0 && !final) return;
          const line = newline < 0 ? this.buffer : this.buffer.slice(0, newline + 1);
          if (line.startsWith("```")) {
            if (!this.inFence && /^```json\b/i.test(line)) { this.blockedJson = true; this.buffer = ""; return; }
            this.inFence = !this.inFence;
          }
          visible += line;
          this.buffer = this.buffer.slice(line.length);
          this.atLineStart = newline >= 0;
          continue;
        }
        if (this.atLineStart && this.buffer === "[" && !final) return;
        // JSON-at-line-start is a structured result/tool envelope. Do not publish
        // its keys or argument strings while they are incomplete.
        if (!this.inFence && this.atLineStart && (this.buffer[0] === "{" || /^\[\s*["{[]/.test(this.buffer))) {
          this.blockedJson = true;
          this.buffer = "";
          return;
        }
        const char = this.buffer[0];
        this.buffer = this.buffer.slice(1);
        visible += char;
        if (char === "\n") this.atLineStart = true;
        else if (!/\s/.test(char)) this.atLineStart = false;
      }
    } finally { if (visible) this.onCleanChunk(visible); }
  }

  flush(): void {
    this.reasoningFilter.flush();
    // Drop incomplete protocol markers instead of revealing them at EOF.
    if (/^(?:<\/?tool|\[(?:TOOL|END_TOOL))/i.test(this.buffer)) this.buffer = "";
    this.processVisible("", true);
  }
}
