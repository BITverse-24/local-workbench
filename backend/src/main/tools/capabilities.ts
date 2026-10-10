import type { CapabilityGroup } from "../../shared/contracts.js";
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { isCapabilityPermitted } from "../run/envelope.js";

export interface CapabilityMetadata {
  name: CapabilityGroup;
  label: string;
  description: string;
  tools: string[];
  requiresAgentMode: boolean;
}

export const CAPABILITY_GROUPS: Record<CapabilityGroup, CapabilityMetadata> = {
  source_access: {
    name: "source_access",
    label: "Source Access",
    description: "Filesystem listing, reading, searching, and knowledge base document retrieval",
    tools: ["read_file", "list_dir", "search", "retrieve_knowledge"],
    requiresAgentMode: false,
  },
  document_processing: {
    name: "document_processing",
    label: "Document Processing",
    description: "Multimodal and text extraction from attached PDF, SVG, images, or engineering documents",
    tools: ["extract_document"],
    requiresAgentMode: false,
  },
  result_retrieval: {
    name: "result_retrieval",
    label: "Result Retrieval",
    description: "Inspection and bounded retrieval of durable intermediate execution results",
    tools: ["retrieve_result"],
    requiresAgentMode: false,
  },
  structured_computation: {
    name: "structured_computation",
    label: "Structured Computation",
    description: "Isolated Python script execution, calculations, and structured data processing",
    tools: ["execute_python"],
    requiresAgentMode: false,
  },
  artifact_generation: {
    name: "artifact_generation",
    label: "Artifact Generation",
    description: "Generation of formal publication-ready deliverable documents (.docx, .xlsx tables, .csv, .json, .md, .txt)",
    tools: ["generate_deliverable"],
    requiresAgentMode: false,
  },
  workspace_mutation: {
    name: "workspace_mutation",
    label: "Workspace Mutation",
    description: "Creating, editing, or deleting files within the active project workspace",
    tools: ["write_file", "delete_file"],
    requiresAgentMode: true,
  },
  system_execution: {
    name: "system_execution",
    label: "System Execution",
    description: "Executing sandboxed shell commands within the active project workspace",
    tools: ["run_command"],
    requiresAgentMode: true,
  },
};

const TOOL_TO_CAPABILITY = new Map<string, CapabilityGroup>();
for (const group of Object.values(CAPABILITY_GROUPS)) {
  for (const tool of group.tools) {
    TOOL_TO_CAPABILITY.set(tool, group.name);
  }
}

export function getCapabilityForTool(toolName: string): CapabilityGroup | undefined {
  return TOOL_TO_CAPABILITY.get(toolName);
}

export function getToolsForCapability(group: CapabilityGroup): string[] {
  return CAPABILITY_GROUPS[group]?.tools ?? [];
}

export const requestCapabilityTool: AgentTool = {
  name: "request_capability",
  definition: {
    type: "function",
    function: {
      name: "request_capability",
      description:
        "Request activation of additional capability groups during execution when needed. When granted, tools belonging to the requested capability become available on subsequent turns.",
      parameters: {
        type: "object",
        properties: {
          capability: {
            type: "string",
            enum: [
              "source_access",
              "document_processing",
              "result_retrieval",
              "structured_computation",
              "artifact_generation",
              "workspace_mutation",
              "system_execution",
            ],
            description: "The capability group to activate.",
          },
          reason: {
            type: "string",
            description: "Brief reason why this capability is needed.",
          },
        },
        required: ["capability"],
      },
    },
  },
  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const capability = String(args.capability ?? "").trim() as CapabilityGroup;
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";

    const meta = CAPABILITY_GROUPS[capability];
    if (!meta) {
      return {
        ok: false,
        output: `Error: Unknown capability "${capability}". Available capabilities: ${Object.keys(CAPABILITY_GROUPS).join(", ")}.`,
        summary: `Unknown capability: ${capability}`,
        error: {
          code: "invalid_arguments",
          message: `Unknown capability "${capability}"`,
          retryable: false,
        },
      };
    }

    // Check against execution envelope permissions:
    if (context.envelope && !isCapabilityPermitted(context.envelope, capability)) {
      const mode = context.envelope.mode;
      const errorMsg = meta.requiresAgentMode
        ? `Permission denied: Capability "${capability}" requires Agent mode. Current execution mode is ${mode}. Workspace actions require Agent authority.`
        : `Permission denied: Capability "${capability}" is not permitted under the current execution envelope.`;

      return {
        ok: false,
        output: errorMsg,
        summary: `Capability denied: ${capability}`,
        error: {
          code: "permission_denied",
          message: errorMsg,
          retryable: false,
        },
      };
    }

    // Grant capability:
    if (context.activeCapabilities) {
      context.activeCapabilities.add(capability);
    }
    if (context.envelope && !context.envelope.activeCapabilities.includes(capability)) {
      context.envelope.activeCapabilities.push(capability);
    }

    if (context.emitRunEvent) {
      context.emitRunEvent({
        type: "capability_expanded",
        runId: context.runId,
        capability,
        permitted: true,
        reason,
      });
    }

    const availableTools = meta.tools.join(", ");
    return {
      ok: true,
      output: `Capability "${capability}" granted. The following tools are now active and available for use on subsequent turns: ${availableTools}.`,
      summary: `Activated capability: ${meta.label}`,
    };
  },
};
