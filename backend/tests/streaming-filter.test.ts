import { describe, expect, it } from "vitest";
import { StreamingTagFilter } from "../src/main/agent/streaming-filter.js";

describe("StreamingTagFilter", () => {
  it("strips complete [TOOL_RESULT] and [END_TOOL_RESULT] tags from a single chunk", () => {
    let emitted = "";
    const filter = new StreamingTagFilter((delta) => {
      emitted += delta;
    });

    filter.process("[TOOL_RESULT]\n# Inspection Report\n[END_TOOL_RESULT]");
    filter.flush();

    expect(emitted).toBe("\n# Inspection Report\n");
    expect(emitted).not.toContain("[TOOL_RESULT]");
    expect(emitted).not.toContain("[END_TOOL_RESULT]");
  });

  it("strips [TOOL_RESULT] when split across chunk boundaries", () => {
    let emitted = "";
    const filter = new StreamingTagFilter((delta) => {
      emitted += delta;
    });

    filter.process("\n\n[TOOL_");
    expect(emitted).toBe("\n\n");

    filter.process("RESULT]\nSummary findings");
    filter.flush();

    expect(emitted).toBe("\n\n\nSummary findings");
    expect(emitted).not.toContain("[TOOL_RESULT]");
  });

  it("strips <tool_call> and </tool_call> tags", () => {
    let emitted = "";
    const filter = new StreamingTagFilter((delta) => {
      emitted += delta;
    });

    filter.process("<tool_call>\nread_file\n</tool_call>Analysis complete.");
    filter.flush();

    expect(emitted).not.toContain("<tool_call>");
    expect(emitted).not.toContain("</tool_call>");
    expect(emitted).toContain("Analysis complete.");
  });

  it("preserves non-tool brackets like [Note] or [1.4 mm]", () => {
    let emitted = "";
    const filter = new StreamingTagFilter((delta) => {
      emitted += delta;
    });

    filter.process("Wall thickness is 3.8 mm [Tolerance: ±0.2 mm].");
    filter.flush();

    expect(emitted).toBe("Wall thickness is 3.8 mm [Tolerance: ±0.2 mm].");
  });
});

it("hides JSON tool envelopes and inline reasoning across every token boundary", () => {
  const cases = [
    ['<think>Private reasoning</think>Visible answer', 'Visible answer'],
    ['Before <tool_call>{"name":"write_file","arguments":{"content":"secret code"}}</tool_call> after', 'Before  after'],
    ['{"tool_calls":[{"arguments":{"code":"secret code"}}]}', ''],
    ['```json\n{"tool_calls":[]}', ''],
    ['[TOOL_CALL]{"arguments":{"code":"secret"}}[END_TOOL_CALL]Visible', 'Visible'],
  ];
  for (const [source, expected] of cases) {
    let text = "";
    const filter = new StreamingTagFilter(delta => { text += delta; });
    for (const char of source) filter.process(char);
    filter.flush();
    expect(text).toBe(expected);
  }
});

it("streams normal code fences and reference brackets without changing the content", () => {
  const source = '[Note] Here is the code:\n```python\nvalue = {"key": 1}\n```\n';
  let text = "";
  const filter = new StreamingTagFilter(delta => { text += delta; });
  for (const char of source) filter.process(char);
  filter.flush();
  expect(text).toBe(source);
});
