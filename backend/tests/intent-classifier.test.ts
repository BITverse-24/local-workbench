import { describe, it, expect } from "vitest";
import { classifyIntent } from "../src/main/router/intent-classifier.js";

describe("Intelligent Intent Classifier", () => {
  it("routes file writing requests with directory context to harness", () => {
    const decision = classifyIntent({
      userText: "Write a txt file in the directory saying hello",
      isWorkspaceActive: true,
    });
    expect(decision.actionTarget).toBe("harness");
    expect(decision.taskType).toBe("code");
    expect(decision.modelId).toBe("code-qwen25coder");
    expect(decision.isWorkspaceAction).toBe(true);
  });

  it("routes user request with specific filename to harness even without active workspace", () => {
    const decision = classifyIntent({
      userText: "Write a txt file in the directory saying 'Krishay'",
      isWorkspaceActive: false,
    });
    expect(decision.actionTarget).toBe("harness");
    expect(decision.taskType).toBe("code");
    expect(decision.modelId).toBe("code-qwen25coder");
    expect(decision.isWorkspaceAction).toBe(true);
  });

  it("routes file creation with extensions to harness", () => {
    const decision = classifyIntent({
      userText: "create server.ts and write basic express app",
      isWorkspaceActive: false,
    });
    expect(decision.actionTarget).toBe("harness");
    expect(decision.taskType).toBe("code");
    expect(decision.isWorkspaceAction).toBe(true);
  });

  it("routes terminal commands to harness", () => {
    const decision = classifyIntent({
      userText: "run command npm test in this project",
      isWorkspaceActive: true,
    });
    expect(decision.actionTarget).toBe("harness");
    expect(decision.taskType).toBe("code");
    expect(decision.isWorkspaceAction).toBe(true);
  });

  it("routes exploration actions to harness", () => {
    const decision = classifyIntent({
      userText: "list files in this directory",
      isWorkspaceActive: true,
    });
    expect(decision.actionTarget).toBe("harness");
    expect(decision.isWorkspaceAction).toBe(true);
  });

  it("routes CSV attachments to data analysis", () => {
    const decision = classifyIntent({
      userText: "flag out-of-range readings",
      attachment: { mediaType: "text/csv" },
    });
    expect(decision.actionTarget).toBe("data");
    expect(decision.taskType).toBe("code");
    expect(decision.modelId).toBe("code-qwen25coder");
    expect(decision.reason).toBe("CSV/code intent");
  });

  it("routes PDF and image attachments to vision", () => {
    const pdfDecision = classifyIntent({
      userText: "inspect this invoice",
      attachment: { mediaType: "application/pdf" },
    });
    expect(pdfDecision.actionTarget).toBe("vision");
    expect(pdfDecision.taskType).toBe("vision");
    expect(pdfDecision.modelId).toBe("vision-qwen25vl");

    const imgDecision = classifyIntent({
      userText: "read the meter in this picture",
      attachment: { mediaType: "image/png" },
    });
    expect(imgDecision.actionTarget).toBe("vision");
    expect(imgDecision.taskType).toBe("vision");
    expect(imgDecision.modelId).toBe("vision-qwen25vl");
  });

  it("routes conversational requests without filesystem context to chat", () => {
    const decision = classifyIntent({
      userText: "What is the capital of France?",
    });
    expect(decision.actionTarget).toBe("chat");
    expect(decision.taskType).toBe("draft");
    expect(decision.modelId).toBe("draft-qwen3");
    expect(decision.isWorkspaceAction).toBe(false);
  });

  it("routes generic script writing request without file targets to draft chat for legacy compatibility", () => {
    const decision = classifyIntent({
      userText: "write me a small script",
    });
    expect(decision.actionTarget).toBe("chat");
    expect(decision.taskType).toBe("draft");
    expect(decision.modelId).toBe("draft-qwen3");
  });
});
