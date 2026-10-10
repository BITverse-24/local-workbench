import { describe, it, expect } from "vitest";
import { getAllAvailableTools, filterToolsForTurn } from "../src/main/router/tool-compositor.js";
import { buildExecutionEnvelope } from "../src/main/run/envelope.js";
import { ToolDispatcher } from "../src/main/agent/tool-dispatcher.js";
import { countTokens, estimateToolTokens } from "../src/main/agent/context-manager.js";
import type { AttachmentReference, CapabilityGroup } from "../src/shared/contracts.js";

describe("Phase 2 Benchmark: Context Budget & Schema Token Savings", () => {
  const driverModelId = "draft-qwen3";
  const allTools = getAllAvailableTools(driverModelId, true);
  const baselineDispatcher = new ToolDispatcher(allTools);
  const baselineDefinitions = baselineDispatcher.getDefinitions();
  const baselineTokens = estimateToolTokens(baselineDefinitions);

  it("measures baseline token footprint when all tools are loaded", () => {
    expect(baselineDefinitions.length).toBeGreaterThanOrEqual(10);
    expect(baselineTokens).toBeGreaterThan(1500); // typically 1800 - 2300 tokens
  });

  it("demonstrates >70% token savings in Pure Chat mode on turn 1", () => {
    const chatEnvelope = buildExecutionEnvelope({
      runId: "run_bench_chat",
      mode: "chat",
      modelId: driverModelId,
      hasWorkspace: false,
      attachments: [],
      hasKnowledgeBaseDocs: false,
      hasRetrievableResults: false,
      userPrompt: "Explain the Second Law of Thermodynamics.",
    });

    const activeCaps = new Set<CapabilityGroup>(chatEnvelope.activeCapabilities);
    const exposedTools = filterToolsForTurn(allTools, chatEnvelope, activeCaps);
    const dispatcher = new ToolDispatcher(exposedTools);
    const exposedDefinitions = dispatcher.getDefinitions();
    const chatTokens = estimateToolTokens(exposedDefinitions);

    const reductionPercent = ((baselineTokens - chatTokens) / baselineTokens) * 100;

    console.log("\n================ PHASE 2 TOKEN BENCHMARK ================");
    console.log(`Baseline (all tools):             ${baselineTokens} tokens (${baselineDefinitions.length} tools)`);
    console.log(`Pure Chat Turn 1:                 ${chatTokens} tokens (${exposedDefinitions.length} tools)`);
    console.log(`Token Reduction:                  ${reductionPercent.toFixed(1)}% savings`);
    console.log("=========================================================\n");

    // Chat has no autonomous tools
    expect(exposedTools.map((t) => t.name)).toEqual([]);
    // Must achieve >70% reduction from baseline
    expect(reductionPercent).toBeGreaterThan(70);
    // Absolute token footprint should be very small (< 200 tokens)
    expect(chatTokens).toBeLessThan(200);
  });

  it("benchmarks tool surfaces across execution modes and states", () => {
    interface Scenario {
      name: string;
      mode: "chat" | "agent";
      hasWorkspace: boolean;
      attachments?: AttachmentReference[];
      hasKnowledgeBaseDocs: boolean;
      hasRetrievableResults: boolean;
      activeCaps?: CapabilityGroup[];
    }

    const scenarios: Scenario[] = [
      {
        name: "1. Pure Chat (Turn 1)",
        mode: "chat",
        hasWorkspace: false,
        attachments: [],
        hasKnowledgeBaseDocs: false,
        hasRetrievableResults: false,
      },
      {
        name: "2. Chat with Document Attachment (Turn 1)",
        mode: "chat",
        hasWorkspace: false,
        attachments: [
          {
            attachmentId: "att_1",
            filename: "report.pdf",
            mediaType: "application/pdf",
            relativePath: "report.pdf",
            sizeBytes: 1024,
          },
        ],
        hasKnowledgeBaseDocs: false,
        hasRetrievableResults: false,
      },
      {
        name: "3. Chat with Mounted Workspace (Read-Only)",
        mode: "chat",
        hasWorkspace: true,
        attachments: [],
        hasKnowledgeBaseDocs: false,
        hasRetrievableResults: false,
      },
      {
        name: "4. Agent Mode with Workspace (Turn 1)",
        mode: "agent",
        hasWorkspace: true,
        attachments: [],
        hasKnowledgeBaseDocs: false,
        hasRetrievableResults: false,
      },
      {
        name: "5. Agent after Python Computation Expanded (Turn 2)",
        mode: "agent",
        hasWorkspace: true,
        attachments: [],
        hasKnowledgeBaseDocs: false,
        hasRetrievableResults: false,
        activeCaps: ["source_access", "workspace_mutation", "structured_computation"],
      },
      {
        name: "6. Agent with Deliverables & Results (Turn 3)",
        mode: "agent",
        hasWorkspace: true,
        attachments: [],
        hasKnowledgeBaseDocs: false,
        hasRetrievableResults: true,
        activeCaps: [
          "source_access",
          "workspace_mutation",
          "structured_computation",
          "artifact_generation",
          "result_retrieval",
        ],
      },
    ];

    console.log("\n| Execution Scenario | Tools Exposed | Tool Names | Tokens | Savings vs Baseline |");
    console.log("|---|---|---|---|---|");

    for (const s of scenarios) {
      const envelope = buildExecutionEnvelope({
        runId: "run_bench_scenario",
        mode: s.mode,
        modelId: driverModelId,
        hasWorkspace: s.hasWorkspace,
        attachments: s.attachments,
        hasKnowledgeBaseDocs: s.hasKnowledgeBaseDocs,
        hasRetrievableResults: s.hasRetrievableResults,
        userPrompt: "benchmark prompt",
      });

      const activeCaps = new Set<CapabilityGroup>(s.activeCaps ?? envelope.activeCapabilities);
      const exposedTools = filterToolsForTurn(allTools, envelope, activeCaps, {
        hasRetrievableResults: s.hasRetrievableResults,
      });
      const dispatcher = new ToolDispatcher(exposedTools);
      const defs = dispatcher.getDefinitions();
      const tokens = estimateToolTokens(defs);
      const savings = (((baselineTokens - tokens) / baselineTokens) * 100).toFixed(1);

      console.log(
        `| ${s.name} | ${exposedTools.length} | ${exposedTools.map((t) => t.name).join(", ")} | ${tokens} | ${savings}% |`,
      );

      // Verify server-side constraint: Chat mode NEVER exposes mutating tools or commands
      if (s.mode === "chat") {
        const toolNames = exposedTools.map((t) => t.name);
        expect(toolNames).not.toContain("write_file");
        expect(toolNames).not.toContain("delete_file");
        expect(toolNames).not.toContain("run_command");
      }
    }
    console.log("\n");
  });
});
