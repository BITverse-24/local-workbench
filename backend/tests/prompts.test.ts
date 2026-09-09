import { describe, expect, it } from "vitest";
import { CODE_SYSTEM_PROMPT } from "../src/main/run/prompts.js";

// CODE_SYSTEM_PROMPT is a verbatim copy of ai/code/prompts/coding-prompt.md.
// The tests pin the generic CSV markers so a future edit can't silently
// reintroduce a fixture-specific prompt.
describe("ai/ prompt wiring", () => {
  it("code prompt matches ai/code/prompts/coding-prompt.md", () => {
    expect(CODE_SYSTEM_PROMPT).toContain("actual CSV");
    expect(CODE_SYSTEM_PROMPT).toContain("Do not assume a fixed filename");
    expect(CODE_SYSTEM_PROMPT).not.toContain("OUT_OF_RANGE 7/240");
    expect(CODE_SYSTEM_PROMPT).toContain('allowedImports must contain only "csv" and "datetime".');
  });
});
