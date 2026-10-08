import { describe, expect, it } from "vitest";
import { parseProviderUsage, resolveReasoningControl } from "../src/main/gateway/telemetry.js";

describe("inference telemetry parsing and reasoning controls", () => {
  it("retains provider token counts and reasoning details", () => {
    expect(parseProviderUsage({
      prompt_tokens: 123,
      completion_tokens: 45,
      completion_tokens_details: { reasoning_tokens: 17 },
    })).toEqual({ source: "provider", promptTokens: 123, completionTokens: 45, reasoningTokens: 17 });
  });

  it("marks provider usage unavailable instead of estimating missing counts", () => {
    expect(parseProviderUsage(undefined)).toEqual({ source: "unavailable" });
    expect(parseProviderUsage({ prompt_tokens: "100", completion_tokens: null })).toEqual({ source: "unavailable" });
  });

  it("leaves production reasoning unchanged by default and allows only the Qwen template-off experiment", () => {
    expect(resolveReasoningControl({})).toEqual({ mode: "default", params: {} });
    expect(resolveReasoningControl({ WORKBENCH_REASONING_MODE: "template_off" })).toEqual({
      mode: "template_off",
      params: { chat_template_kwargs: { enable_thinking: false } },
    });
    expect(resolveReasoningControl({ WORKBENCH_REASONING_MODE: "effort_low" })).toEqual({ mode: "default", params: {} });
  });
});
