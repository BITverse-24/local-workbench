import { describe, expect, it } from "vitest";
import { CODE_SYSTEM_PROMPT } from "../src/main/run/prompts.js";

// CODE_SYSTEM_PROMPT is a verbatim copy of ai/code/prompts/coding-prompt.md.
// The tests pin generic source, interface, and execution guidance.
describe("ai/ prompt wiring", () => {
  it("code prompt matches ai/code/prompts/coding-prompt.md", () => {
    expect(CODE_SYSTEM_PROMPT).toContain("supplied source and input evidence");
    expect(CODE_SYSTEM_PROMPT).toContain("Preserve the existing public interface");
    expect(CODE_SYSTEM_PROMPT).not.toContain("OUT_OF_RANGE 7/240");
    expect(CODE_SYSTEM_PROMPT).toContain('allowedImports must contain only "csv", "datetime", and "math".');
  });
});
