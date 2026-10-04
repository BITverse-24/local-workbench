import { describe, expect, it, vi } from "vitest";
import { buildExecutionEnvelope } from "../src/main/run/envelope.js";
import {
  CAPABILITY_GROUPS,
  requestCapabilityTool,
  getCapabilityForTool,
  getToolsForCapability,
} from "../src/main/tools/capabilities.js";
import {
  getAllAvailableTools,
  filterToolsForTurn,
  composeToolsForEnvelope,
} from "../src/main/router/tool-compositor.js";
import { ToolDispatcher } from "../src/main/agent/tool-dispatcher.js";
import type { ToolExecutionContext, AgentTool } from "../src/main/tools/types.js";
import type { CapabilityGroup, ExecutionEnvelope, RunEvent } from "../src/shared/contracts.js";

describe("Dynamic Progressive Capability Dispatch (Phase 2)", () => {
  const dummyContext = (envelope: ExecutionEnvelope, emit?: (e: RunEvent) => void): ToolExecutionContext => ({
    runId: envelope.runId,
    workspaceRoot: "/test/workspace",
    gateway: {} as any,
    envelope,
    activeCapabilities: new Set(envelope.activeCapabilities),
    emitRunEvent: emit ?? vi.fn(),
  });

  describe("1. Capability Metadata Structure", () => {
    it("defines the 7 required capability groups with explicit agent mode requirements", () => {
      const groups = Object.keys(CAPABILITY_GROUPS) as CapabilityGroup[];
      expect(groups).toContain("source_access");
      expect(groups).toContain("document_processing");
      expect(groups).toContain("result_retrieval");
      expect(groups).toContain("structured_computation");
      expect(groups).toContain("artifact_generation");
      expect(groups).toContain("workspace_mutation");
      expect(groups).toContain("system_execution");

      expect(CAPABILITY_GROUPS.workspace_mutation.requiresAgentMode).toBe(true);
      expect(CAPABILITY_GROUPS.system_execution.requiresAgentMode).toBe(true);
      expect(CAPABILITY_GROUPS.source_access.requiresAgentMode).toBe(false);
      expect(CAPABILITY_GROUPS.structured_computation.requiresAgentMode).toBe(false);
      expect(CAPABILITY_GROUPS.artifact_generation.requiresAgentMode).toBe(false);
    });

    it("correctly maps individual tools to their respective capability group", () => {
      expect(getCapabilityForTool("read_file")).toBe("source_access");
      expect(getCapabilityForTool("list_dir")).toBe("source_access");
      expect(getCapabilityForTool("extract_document")).toBe("document_processing");
      expect(getCapabilityForTool("retrieve_result")).toBe("result_retrieval");
      expect(getCapabilityForTool("execute_python")).toBe("structured_computation");
      expect(getCapabilityForTool("generate_deliverable")).toBe("artifact_generation");
      expect(getCapabilityForTool("write_file")).toBe("workspace_mutation");
      expect(getCapabilityForTool("delete_file")).toBe("workspace_mutation");
      expect(getCapabilityForTool("run_command")).toBe("system_execution");
    });
  });

  describe("2. request_capability Tool Verification", () => {
    it("rejects workspace_mutation and system_execution requests when in Chat mode", async () => {
      const envelope = buildExecutionEnvelope({
        runId: "run-chat-reject",
        mode: "chat",
        modelId: "draft-qwen3",
        hasWorkspace: true,
      });
      const ctx = dummyContext(envelope);

      const res = await requestCapabilityTool.execute(
        { capability: "workspace_mutation", reason: "Need to edit config file" },
        ctx,
      );

      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("permission_denied");
      expect(res.output).toContain("Permission denied");
      expect(ctx.activeCapabilities?.has("workspace_mutation")).toBe(false);
    });

    it("grants permitted capability expansion and emits capability_expanded event", async () => {
      const envelope = buildExecutionEnvelope({
        runId: "run-chat-grant",
        mode: "chat",
        modelId: "draft-qwen3",
        hasWorkspace: true,
      });
      const emittedEvents: RunEvent[] = [];
      const ctx = dummyContext(envelope, (e) => emittedEvents.push(e));

      const res = await requestCapabilityTool.execute(
        { capability: "structured_computation", reason: "Perform data calculations with Python" },
        ctx,
      );

      expect(res.ok).toBe(true);
      expect(res.summary).toContain("Activated capability");
      expect(ctx.activeCapabilities?.has("structured_computation")).toBe(true);
      expect(envelope.activeCapabilities).toContain("structured_computation");

      // Verify telemetry event
      const expandedEvent = emittedEvents.find((e) => e.type === "capability_expanded");
      expect(expandedEvent).toBeDefined();
      if (expandedEvent && expandedEvent.type === "capability_expanded") {
        expect(expandedEvent.capability).toBe("structured_computation");
        expect(expandedEvent.permitted).toBe(true);
      }
    });

    it("grants workspace_mutation when execution envelope is in Agent mode", async () => {
      const envelope = buildExecutionEnvelope({
        runId: "run-agent-grant",
        mode: "agent",
        modelId: "code-qwen25coder",
        hasWorkspace: true,
      });
      const ctx = dummyContext(envelope);

      const res = await requestCapabilityTool.execute(
        { capability: "workspace_mutation", reason: "Apply bug fix to codebase" },
        ctx,
      );

      expect(res.ok).toBe(true);
      expect(ctx.activeCapabilities?.has("workspace_mutation")).toBe(true);
      expect(envelope.activeCapabilities).toContain("workspace_mutation");
    });
  });

  describe("3. Progressive Tool Exposure & Context Token Savings", () => {
    it("exposes only request_capability on turn 1 for pure chat, saving >1500 tokens of tool schemas", () => {
      const envelope = buildExecutionEnvelope({
        runId: "run-pure-chat-budget",
        mode: "chat",
        modelId: "draft-qwen3",
        hasWorkspace: false,
        userPrompt: "Hello, what is a centrifugal pump?",
      });

      const allTools = getAllAvailableTools("draft-qwen3", true);
      const turn1Tools = filterToolsForTurn(allTools, envelope, new Set(envelope.activeCapabilities));

      // In pure chat, turn 1 exposes only request_capability!
      expect(turn1Tools.map((t) => t.name)).toEqual(["request_capability"]);
      expect(turn1Tools.length).toBe(1);

      // Comparing token footprint:
      const fullSchemaJson = JSON.stringify(allTools.map((t) => t.definition));
      const minimalSchemaJson = JSON.stringify(turn1Tools.map((t) => t.definition));
      expect(minimalSchemaJson.length).toBeLessThan(fullSchemaJson.length / 5);
    });

    it("progressively expands tool surface turn-by-turn as capabilities are activated", () => {
      const envelope = buildExecutionEnvelope({
        runId: "run-progressive",
        mode: "chat",
        modelId: "draft-qwen3",
        hasWorkspace: true,
        userPrompt: "Analyze log data",
      });

      const allTools = getAllAvailableTools("draft-qwen3", true);

      // Turn 1: Workspace mounted, so only source_access is active
      const activeCaps = new Set<CapabilityGroup>(envelope.activeCapabilities);
      expect(Array.from(activeCaps)).toEqual(["source_access"]);

      const turn1Tools = filterToolsForTurn(allTools, envelope, activeCaps);
      const turn1Names = turn1Tools.map((t) => t.name);
      expect(turn1Names).toContain("request_capability");
      expect(turn1Names).toContain("read_file");
      expect(turn1Names).toContain("list_dir");
      expect(turn1Names).toContain("search");
      expect(turn1Names).not.toContain("execute_python");
      expect(turn1Names).not.toContain("generate_deliverable");
      expect(turn1Names).not.toContain("write_file");

      // Turn 2: LLM activates structured_computation
      activeCaps.add("structured_computation");
      const turn2Tools = filterToolsForTurn(allTools, envelope, activeCaps);
      const turn2Names = turn2Tools.map((t) => t.name);
      expect(turn2Names).toContain("execute_python");
      expect(turn2Names).not.toContain("generate_deliverable");

      // Turn 3: LLM activates artifact_generation
      activeCaps.add("artifact_generation");
      const turn3Tools = filterToolsForTurn(allTools, envelope, activeCaps);
      const turn3Names = turn3Tools.map((t) => t.name);
      expect(turn3Names).toContain("generate_deliverable");
    });
  });

  describe("4. Realistic Chained Workflow Test", () => {
    it("simulates: Read sources -> Extract -> Structured computation -> Retrieve earlier result -> Generate deliverable", async () => {
      // Step A: Initialize envelope with source access and document processing (due to PDF attachment)
      const envelope = buildExecutionEnvelope({
        runId: "run-chained-flow",
        mode: "chat",
        modelId: "draft-qwen3",
        hasWorkspace: true,
        attachments: [{
          attachmentId: "pdf-1",
          filename: "turbine_specs.pdf",
          mediaType: "application/pdf",
          sizeBytes: 5000,
          relativePath: "input/turbine_specs.pdf",
        }],
        userPrompt: "Read turbine_specs.pdf and produce efficiency-report.docx",
      });

      const allTools = getAllAvailableTools("draft-qwen3", true);
      const activeCaps = new Set<CapabilityGroup>(envelope.activeCapabilities);
      const ctx = dummyContext(envelope);

      // Turn 1 check: source_access, document_processing, and artifact_generation are initially exposed
      const turn1Tools = filterToolsForTurn(allTools, envelope, activeCaps);
      const turn1Names = turn1Tools.map((t) => t.name);
      expect(turn1Names).toContain("read_file");
      expect(turn1Names).toContain("extract_document");
      expect(turn1Names).toContain("generate_deliverable");
      expect(turn1Names).not.toContain("execute_python"); // Python not active yet

      // Step B: Agent requests structured computation to calculate efficiency
      const capReq = await requestCapabilityTool.execute(
        { capability: "structured_computation", reason: "Execute efficiency calculations in Python" },
        ctx,
      );
      expect(capReq.ok).toBe(true);
      activeCaps.add("structured_computation");

      // Turn 2 check: execute_python is now visible!
      const turn2Tools = filterToolsForTurn(allTools, envelope, activeCaps);
      expect(turn2Tools.map((t) => t.name)).toContain("execute_python");

      // Step C: Result is produced and registered in ResultStore -> result_retrieval activated
      activeCaps.add("result_retrieval");
      const turn3Tools = filterToolsForTurn(allTools, envelope, activeCaps, { hasRetrievableResults: true });
      expect(turn3Tools.map((t) => t.name)).toContain("retrieve_result");

      // Step D: Final turn has full read/compute/retrieve/deliver capability, but zero mutating workspace tools!
      expect(turn3Tools.map((t) => t.name)).not.toContain("write_file");
      expect(turn3Tools.map((t) => t.name)).not.toContain("run_command");
    });
  });

  describe("5. Server-Side Chat Mode Mutation Denial in ToolDispatcher", () => {
    it("blocks write_file, delete_file, and run_command at the dispatcher level when in Chat mode", async () => {
      const envelope = buildExecutionEnvelope({
        runId: "run-chat-dispatch-guard",
        mode: "chat",
        modelId: "draft-qwen3",
        hasWorkspace: true,
      });
      const ctx = dummyContext(envelope);

      const fakeWriteTool: AgentTool = {
        name: "write_file",
        definition: {
          type: "function",
          function: { name: "write_file", description: "write", parameters: { type: "object", properties: {} } },
        },
        execute: vi.fn(),
      };

      const fakeRunCmdTool: AgentTool = {
        name: "run_command",
        definition: {
          type: "function",
          function: { name: "run_command", description: "cmd", parameters: { type: "object", properties: {} } },
        },
        execute: vi.fn(),
      };

      const dispatcher = new ToolDispatcher([fakeWriteTool, fakeRunCmdTool]);

      // Attempt write_file in Chat mode:
      const writeResults = await dispatcher.dispatchConcurrent(
        [{ id: "call_w1", name: "write_file", arguments: { path: "exploit.txt", content: "data" } }],
        ctx,
      );

      expect(writeResults[0].result.ok).toBe(false);
      if (!writeResults[0].result.ok) {
        expect(writeResults[0].result.error.code).toBe("permission_denied");
        expect(writeResults[0].result.error.message).toContain("Workspace mutation is prohibited in Chat mode");
      }
      expect(fakeWriteTool.execute).not.toHaveBeenCalled();

      // Attempt run_command in Chat mode:
      const cmdResults = await dispatcher.dispatchConcurrent(
        [{ id: "call_c1", name: "run_command", arguments: { command: "rm -rf /" } }],
        ctx,
      );

      expect(cmdResults[0].result.ok).toBe(false);
      if (!cmdResults[0].result.ok) {
        expect(cmdResults[0].result.error.code).toBe("permission_denied");
        expect(cmdResults[0].result.error.message).toContain("Command execution is prohibited in Chat mode");
      }
      expect(fakeRunCmdTool.execute).not.toHaveBeenCalled();
    });
  });
});
