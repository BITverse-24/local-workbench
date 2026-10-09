import { describe, expect, it } from "vitest";
import { readCompletionStream, withoutInlineReasoning } from "../src/main/gateway/completion-stream.js";

function stream(body: string, byteSize = 11) {
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += byteSize) controller.enqueue(bytes.slice(i, i + byteSize));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data:${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\r\n\r\n`;

it("streams text before completion and keeps native and inline reasoning out of the answer", async () => {
  const text: string[] = [];
  const activities: unknown[] = [];
  const response = await readCompletionStream(stream(
    frame({ reasoning_content: "Private analysis" }) + frame({ content: "<thi" }) + frame({ content: "nk>Hidden</th" }) +
    frame({ content: "ink>Ready ✓" }) + frame({}, "stop") + "data: [DONE]",
  1), delta => text.push(delta), activity => activities.push(activity));
  const result = JSON.parse(await response.text());
  expect(text.join("")).toBe("Ready ✓");
  expect(result.choices[0].message.content).toBe("Ready ✓");
  expect(result.choices[0].message.reasoning_content).toBe("Private analysisHidden");
  expect(activities).toEqual([{ channel: "reasoning", chars: 16 }, { channel: "reasoning", chars: 6 }]);
});

it("preserves split tool arguments, sparse indices, finish reason, and provider usage", async () => {
  let text = "";
  const activities: unknown[] = [];
  const response = await readCompletionStream(stream(frame({ tool_calls: [{ index: 1, id: "save", function: { name: "write_file", arguments: '{"content":"' } }] }) +
    frame({ tool_calls: [{ index: 1, function: { arguments: 'line\\n","path":"main.py"}' } }] }, "tool_calls") +
    'data: {"choices":[],"usage":{"completion_tokens":24}}\n\n' + "data: [DONE]\n\n"), delta => { text += delta; }, update => activities.push(update));
  const result = JSON.parse(await response.text());
  expect(text).toBe("");
  expect(result.choices[0].message.tool_calls).toEqual([{ id: "save", type: "function", function: { name: "write_file", arguments: '{"content":"line\\n","path":"main.py"}' } }]);
  expect(result.choices[0].finish_reason).toBe("tool_calls");
  expect(result.usage.completion_tokens).toBe(24);
  expect(activities.every((activity: any) => activity.channel === "tool_arguments" && !activity.arguments)).toBe(true);
});

it("does not turn a reasoning-only response into answer text", async () => {
  const response = await readCompletionStream(stream(frame({ reasoning: "Still checking" }, "length")), () => { throw new Error("Reasoning leaked"); });
  const result = JSON.parse(await response.text());
  expect(result.choices[0].message.content).toBeNull();
  expect(result.choices[0].finish_reason).toBe("length");
});

it("handles multiline SSE data and a final event without a newline", async () => {
  const response = await readCompletionStream(stream('data: {"choices":\ndata: [{"delta":{"content":"Done"},"finish_reason":"stop"}]}'), () => {});
  expect(JSON.parse(await response.text()).choices[0].message.content).toBe("Done");
});

it("rejects incomplete streams and provider error frames", async () => {
  await expect(readCompletionStream(stream(frame({ tool_calls: [{ index: 0, function: { name: "write_file", arguments: "{" } }] })), () => {})).rejects.toThrow("before completion");
  await expect(readCompletionStream(stream('data: {"error":{"message":"Model unloaded"}}\n\n'), () => {})).rejects.toThrow("Model unloaded");
});

it("preserves a normal JSON envelope when the server ignores streaming", async () => {
  const body = JSON.stringify({ choices: [{ message: { content: "Complete answer" } }] });
  const response = await readCompletionStream(new Response(body, { headers: { "content-type": "application/json" } }), () => {});
  expect(await response.text()).toBe(body);
});

it("propagates connection failures instead of manufacturing partial success", async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error("Connection lost")); } });
  await expect(readCompletionStream(new Response(body), () => {})).rejects.toThrow("Connection lost");
});

describe("inline reasoning", () => {
  it("keeps only answer text and removes unfinished reasoning blocks", () => {
    expect(withoutInlineReasoning("<think>Internal plan</think>Final answer")).toBe("Final answer");
    expect(withoutInlineReasoning("<think>Unfinished private text")).toBe("");
    expect(withoutInlineReasoning("Final <thi")).toBe("Final ");
  });
});

it("preserves reasoning delimiters that are literal source in structured output", async () => {
  const source = JSON.stringify({ tool_calls: [{ name: "write_file", arguments: { content: 'prompt = "<think>literal text</think>"', path: "main.py" } }] });
  const chunks: string[] = [];
  const response = await readCompletionStream(stream(frame({ content: source.slice(0, 50) }) + frame({ content: source.slice(50) }, "stop")), delta => chunks.push(delta));
  expect(chunks.join("")).toBe(source);
  expect(JSON.parse(await response.text()).choices[0].message.content).toBe(source);
  const code = '```python\nprompt = "<think>literal text</think>"\n```';
  expect(withoutInlineReasoning(code)).toBe(code);
});

it("accepts an ordinary JSON response even when its content type is missing", async () => {
  const body = JSON.stringify({ choices: [{ message: { content: "Answer" }, finish_reason: "stop" }] });
  const response = await readCompletionStream(new Response(body), () => {});
  expect(await response.text()).toBe(body);
});

it("finishes on DONE without waiting for the provider to close the connection", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frame({ content: "Answer" }, "stop") + "data: [DONE]\n\n"));
  }, cancel() { cancelled = true; } });
  const response = await readCompletionStream(new Response(body), () => {});
  expect(JSON.parse(await response.text()).choices[0].message.content).toBe("Answer");
  expect(cancelled).toBe(true);
});
