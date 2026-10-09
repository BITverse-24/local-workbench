export type StreamActivity = { channel: "reasoning" | "tool_arguments"; chars: number };

/** Separates inline reasoning even when its delimiters cross token boundaries. */
export class ReasoningStreamFilter {
  private buffer = "";
  private thinking = false;
  private visibleHistory = "";
  constructor(private readonly text: (delta: string) => void, private readonly reasoning: (delta: string) => void = () => {}) {}

  process(delta: string, final = false): void {
    this.buffer += delta;
    while (this.buffer) {
      const marker = this.thinking ? "</think>" : "<think>";
      const index = this.buffer.toLowerCase().indexOf(marker);
      if (index >= 0) {
        // Source strings in JSON and code fences are data, even if they contain
        // a model delimiter. Keep structured tool fallback payloads lossless.
        if (!this.thinking && this.protectedContent(this.visibleHistory + this.buffer.slice(0, index))) {
          this.publish(this.buffer.slice(0, index + marker.length));
          this.buffer = this.buffer.slice(index + marker.length);
          continue;
        }
        this.publish(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + marker.length);
        this.thinking = !this.thinking;
        continue;
      }
      let held = 0;
      for (let n = 1; n < marker.length; n++) {
        if (this.buffer.toLowerCase().endsWith(marker.slice(0, n))) held = n;
      }
      this.publish(this.buffer.slice(0, this.buffer.length - held));
      this.buffer = held ? this.buffer.slice(-held) : "";
      // A truncated delimiter is never user-facing text.
      if (final) {
        if (!this.thinking && this.protectedContent(this.visibleHistory)) this.publish(this.buffer);
        this.buffer = "";
      }
      break;
    }
  }
  flush(): void { this.process("", true); }
  private protectedContent(value: string): boolean {
    return /^[\s]*[\[{]/.test(value) || (value.match(/```/g)?.length ?? 0) % 2 === 1;
  }
  private publish(value: string): void {
    if (!value) return;
    if (this.thinking) this.reasoning(value);
    else { this.visibleHistory += value; this.text(value); }
  }
}

export function withoutInlineReasoning(value: string): string {
  let text = "";
  const filter = new ReasoningStreamFilter(delta => { text += delta; });
  filter.process(value);
  filter.flush();
  return text;
}

/** Reads OpenAI-compatible SSE and retains the complete tool payload for validation. */
export async function readCompletionStream(
  response: Response,
  onChunk: (delta: string) => void,
  onActivity?: (activity: StreamActivity) => void,
): Promise<{ status: number; text(): Promise<string> }> {
  if (!response.ok || !response.body) {
    const body = await response.text();
    return { status: response.status, text: async () => body };
  }
  // Some servers ignore stream=true. Keep their ordinary JSON response intact.
  if (response.headers.get("content-type")?.includes("application/json")) {
    const body = await response.text();
    return { status: response.status, text: async () => body };
  }
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let finished = false;
  let usage: unknown;
  const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
  const reasoningFilter = new ReasoningStreamFilter(delta => { content += delta; onChunk(delta); }, delta => {
    reasoning += delta;
    onActivity?.({ channel: "reasoning", chars: delta.length });
  });
  const consume = (data: string) => {
    if (finished) return;
    if (!data) return;
    if (data === "[DONE]") { finished = true; return; }
    const frame = JSON.parse(data);
    if (frame.error) throw new Error(frame.error.message || "Provider stream failed");
    if (frame.usage) usage = frame.usage;
    const choice = frame.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    const thought = delta.reasoning_content ?? delta.reasoning;
    if (typeof thought === "string" && thought) {
      reasoning += thought;
      onActivity?.({ channel: "reasoning", chars: thought.length });
    }
    if (typeof delta.content === "string") reasoningFilter.process(delta.content);
    for (const call of delta.tool_calls ?? []) {
      if (!call || typeof call !== "object") continue;
      const index = Number.isInteger(call.index) && call.index >= 0 ? call.index : toolCalls.length;
      const item = toolCalls[index] ??= { id: `call_${index}`, type: "function", function: { name: "", arguments: "" } };
      if (call.id) item.id = call.id;
      if (call.type) item.type = call.type;
      if (call.function?.name) item.function.name += call.function.name;
      if (typeof call.function?.arguments === "string") {
        item.function.arguments += call.function.arguments;
        onActivity?.({ channel: "tool_arguments", chars: call.function.arguments.length });
      }
    }
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let format: "unknown" | "json" | "sse" = "unknown";
  let eventData: string[] = [];
  const consumeLine = (line: string) => {
    if (!line) {
      if (eventData.length) consume(eventData.join("\n").trim());
      eventData = [];
    } else if (line.startsWith("data:")) eventData.push(line.slice(5).trimStart());
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (format === "unknown" && buffer.trimStart()) format = buffer.trimStart().startsWith("{") ? "json" : "sse";
      if (format === "json") {
        if (!done) continue;
        const body = buffer;
        return { status: response.status, text: async () => body };
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line.trimEnd());
      if (done || finished) break;
    }
    if (buffer) consumeLine(buffer.trimEnd());
    consumeLine("");
    if (!finished && !finishReason) throw new Error("Provider stream ended before completion");
    reasoningFilter.flush();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = JSON.stringify({ choices: [{ message: {
    role: "assistant", content: content || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls.filter(Boolean) } : {}),
  }, finish_reason: finishReason ?? (toolCalls.length ? "tool_calls" : "stop") }], usage });
  return { status: response.status, text: async () => body };
}
