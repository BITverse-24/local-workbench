import { describe, expect, it } from "vitest";
import { CODE_SYSTEM_PROMPT } from "../src/main/run/prompts.js";

// CODE_SYSTEM_PROMPT is a verbatim copy of ai/code/prompts/coding-prompt.md.
// The tests pin the lockstep markers so a future edit can't silently revert
// to a placeholder one-liner. Vision/draft prompts live in ai/ as future
// service boundaries and are not mirrored in the backend (Flow A deferred).
describe("ai/ prompt wiring", () => {
  it("code prompt matches ai/code/prompts/coding-prompt.md", () => {
    expect(CODE_SYSTEM_PROMPT).toContain("reactor-temperature-log.csv");
    expect(CODE_SYSTEM_PROMPT).toContain("OUT_OF_RANGE 7/240 (high=5, low=2)");
    expect(CODE_SYSTEM_PROMPT).toContain('allowedImports must contain only "csv" and "datetime".');
  });
});
