import { describe, expect, it } from "vitest";
import {
  buildExecutionEnvelope,
  isCapabilityPermitted,
  isMutationPermitted,
  isCommandExecutionPermitted,
} from "../src/main/run/envelope.js";
import type { AttachmentReference } from "../src/shared/contracts.js";

describe("Execution Envelope Specification", () => {
  const dummyAttachment = (filename: string, mediaType = "text/plain"): AttachmentReference => ({
    attachmentId: "att-1",
    filename,
    mediaType,
    sizeBytes: 1024,
    relativePath: `input/${filename}`,
  });

  describe("Chat Mode Boundary Guarantees", () => {
    it("strictly prohibits workspace_mutation and system_execution in permitted capabilities", () => {
      const envelope = buildExecutionEnvelope({
        runId: "run-chat-1",
        mode: "chat",
        modelId: "draft-qwen3",
        hasWorkspace: true,
        workspaceRoot: "/workspace",
        userPrompt: "Modify index.ts and run the tests",
        mutationRequested: true,
        commandExecutionRequested: true,
      });

      expect(envelope.mode).toBe("chat");
      expect(envelope.permittedCapabilities).not.toContain("workspace_mutation");
      expect(envelope.permittedCapabilities).not.toContain("system_execution");
      expect(envelope.activeCapabilities).not.toContain("workspace_mutation");
      expect(envelope.activeCapabilities).not.toContain("system_execution");

      expect(isMutationPermitted(envelope)).toBe(false);
      expect(isCommandExecutionPermitted(envelope)).toBe(false);
      expect(isCapabilityPermitted(envelope, "workspace_mutation")).toBe(false);
      expect(isCapabilityPermitted(envelope, "system_execution")).toBe(false);
    });

    it("permits safe read-only, computation, and deliverable capabilities in Chat mode", () => {
      const envelope = buildExecutionEnvelope({
        runId: "run-chat-2",
        mode: "chat",
        modelId: "draft-qwen3",
        hasWorkspace: false,
        userPrompt: "Explain how heat exchangers operate",
      });

      expect(isCapabilityPermitted(envelope, "source_access")).toBe(true);
      expect(isCapabilityPermitted(envelope, "document_processing")).toBe(true);
      expect(isCapabilityPermitted(envelope, "result_retrieval")).toBe(true);
      expect(isCapabilityPermitted(envelope, "structured_computation")).toBe(true);
      expect(isCapabilityPermitted(envelope, "artifact_generation")).toBe(true);
    });

    it("defaults to empty active capabilities for pure chat to minimize schema overhead", () => {
      const envelope = buildExecutionEnvelope({
        runId: "run-pure-chat",
        mode: "chat",
        modelId: "draft-qwen3",
        hasWorkspace: false,
        attachments: [],
        userPrompt: "Hello, what is Newton's second law?",
      });

      // Pure chat with no workspace or attachments exposes 0 capability groups initially
      expect(envelope.activeCapabilities).toEqual([]);
    });
  });

  describe("Agent Mode Authority", () => {
    it("permits full capability surface in Agent mode including workspace mutations", () => {
      const envelope = buildExecutionEnvelope({
        runId: "run-agent-1",
        mode: "agent",
        modelId: "code-qwen25coder",
        hasWorkspace: true,
        workspaceRoot: "/project",
        userPrompt: "Fix bug in main.py and run pytest",
        mutationRequested: true,
        commandExecutionRequested: true,
      });

      expect(envelope.mode).toBe("agent");
      expect(envelope.permittedCapabilities).toContain("workspace_mutation");
      expect(envelope.permittedCapabilities).toContain("system_execution");
      expect(envelope.permittedCapabilities).toContain("source_access");
      expect(envelope.permittedCapabilities).toContain("structured_computation");
      expect(envelope.permittedCapabilities).toContain("artifact_generation");

      expect(isMutationPermitted(envelope)).toBe(true);
      expect(isCommandExecutionPermitted(envelope)).toBe(true);
      expect(envelope.activeCapabilities).toContain("workspace_mutation");
      expect(envelope.activeCapabilities).toContain("system_execution");
    });
  });

  describe("Deterministic Initial Exposure Rules", () => {
    it("activates source_access when workspace is mounted", () => {
      const envelope = buildExecutionEnvelope({
        runId: "run-ws",
        mode: "chat",
        modelId: "code-qwen25coder",
        hasWorkspace: true,
        userPrompt: "What files are in this project?",
      });

      expect(envelope.activeCapabilities).toContain("source_access");
      expect(envelope.activeCapabilities).not.toContain("workspace_mutation");
    });

    it("activates document_processing only when applicable document attachments exist", () => {
      const pdfEnvelope = buildExecutionEnvelope({
        runId: "run-pdf",
        mode: "chat",
        modelId: "draft-qwen3",
        hasWorkspace: false,
        attachments: [dummyAttachment("report.pdf", "application/pdf")],
        userPrompt: "Summarize findings from report.pdf",
      });

      expect(pdfEnvelope.activeCapabilities).toContain("document_processing");
      expect(pdfEnvelope.activeCapabilities).toContain("source_access");

      const textEnvelope = buildExecutionEnvelope({
        runId: "run-no-docs",
        mode: "chat",
        modelId: "draft-qwen3",
        hasWorkspace: false,
        attachments: [],
        userPrompt: "Tell me a story",
      });

      expect(textEnvelope.activeCapabilities).not.toContain("document_processing");
    });

    it("activates result_retrieval only when retrievable results actually exist", () => {
      const withoutResults = buildExecutionEnvelope({
        runId: "run-no-res",
        mode: "agent",
        modelId: "code-qwen25coder",
        hasWorkspace: true,
        hasRetrievableResults: false,
        userPrompt: "Run tests",
      });
      expect(withoutResults.activeCapabilities).not.toContain("result_retrieval");

      const withResults = buildExecutionEnvelope({
        runId: "run-with-res",
        mode: "agent",
        modelId: "code-qwen25coder",
        hasWorkspace: true,
        hasRetrievableResults: true,
        userPrompt: "Run tests",
      });
      expect(withResults.activeCapabilities).toContain("result_retrieval");
    });

    it("activates artifact_generation when deliverables are explicitly requested", () => {
      const docxEnvelope = buildExecutionEnvelope({
        runId: "run-deliv",
        mode: "chat",
        modelId: "draft-qwen3",
        hasWorkspace: false,
        userPrompt: "Compile findings and save as compliance-note.docx",
      });

      expect(docxEnvelope.activeCapabilities).toContain("artifact_generation");
    });
  });
});
