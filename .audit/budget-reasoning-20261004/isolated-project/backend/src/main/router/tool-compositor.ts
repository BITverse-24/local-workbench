import type { CapabilityGroup, ExecutionEnvelope, ModelId, RunContract } from "../../shared/contracts.js";
import type { AgentTool } from "../tools/types.js";
import type { SemanticIntent } from "./contextual-router.js";
import { workspaceTools } from "../tools/workspace-tools.js";
import { retrieveResultTool } from "../tools/result-retrieval.js";
import {
  extractDocumentTool,
  generateCodeTool,
  generateTextTool,
  retrieveKnowledgeTool,
  executePythonTool,
  generateDeliverableTool,
} from "../tools/specialist-tools.js";
import {
  requestCapabilityTool,
  getCapabilityForTool,
  CAPABILITY_GROUPS,
} from "../tools/capabilities.js";

export interface EnvironmentState {
  hasWorkspace: boolean;
  hasAttachments: boolean;
  hasVisualAttachments?: boolean;
  hasKnowledgeBaseDocs: boolean;
  hasRetrievableResults?: boolean;
}

/**
 * Returns all potential tools registered in Sovereign Workbench.
 */
export function getAllAvailableTools(driverModelId: ModelId, isSingleModel = false): AgentTool[] {
  const tools: AgentTool[] = [
    requestCapabilityTool,
    ...workspaceTools,
    executePythonTool,
    generateDeliverableTool,
    retrieveResultTool,
    retrieveKnowledgeTool,
    extractDocumentTool,
  ];

  if (!isSingleModel) {
    if (driverModelId !== "code-qwen25coder") {
      tools.push(generateCodeTool);
    }
    if (driverModelId !== "draft-qwen3") {
      tools.push(generateTextTool);
    }
  }

  return tools;
}

/**
 * Dynamically prunes tool definitions for a specific model turn based on:
 * 1) Currently activated capability groups in the envelope
 * 2) Server-side Chat mode restrictions (zero workspace mutation or commands in Chat mode)
 * 3) Runtime state (e.g. results actually present in ResultStore, KB docs present)
 *
 * request_capability is always visible so the LLM can request more tools when needed.
 */
export function filterToolsForTurn(
  allTools: AgentTool[],
  envelope: ExecutionEnvelope,
  activeCapabilities: Set<CapabilityGroup>,
  options?: { hasRetrievableResults?: boolean },
): AgentTool[] {
  return allTools.filter((tool) => {
    // 1. request_capability is always visible so model can request expansion
    if (tool.name === "request_capability") return true;

    // 2. Chat mode server-side restriction: workspace mutations and system commands never visible
    if (envelope.mode === "chat") {
      if (tool.name === "write_file" || tool.name === "delete_file" || tool.name === "run_command") {
        return false;
      }
    }

    // 3. Dynamic result retrieval: only visible when results actually exist
    if (tool.name === "retrieve_result") {
      const resultsExist = options?.hasRetrievableResults ?? envelope.hasRetrievableResults;
      return activeCapabilities.has("result_retrieval") && resultsExist;
    }

    // 4. Knowledge base retrieval: only visible if KB docs exist
    if (tool.name === "retrieve_knowledge") {
      return activeCapabilities.has("source_access") && envelope.hasKnowledgeBaseDocs;
    }

    // 5. Document extraction: only visible if document_processing is active
    if (tool.name === "extract_document") {
      return activeCapabilities.has("document_processing");
    }

    // 6. Check if tool belongs to an active capability group
    const cap = getCapabilityForTool(tool.name);
    if (!cap) return true; // If not mapped to a group, expose if permitted

    return activeCapabilities.has(cap);
  });
}

/**
 * Compose tools for an execution envelope using active capability groups.
 */
export function composeToolsForEnvelope(
  envelope: ExecutionEnvelope,
  activeCapabilities: Iterable<CapabilityGroup>,
  driverModelId: ModelId,
  isSingleModel = false,
): AgentTool[] {
  const allTools = getAllAvailableTools(driverModelId, isSingleModel);
  const activeSet = new Set(activeCapabilities);
  return filterToolsForTurn(allTools, envelope, activeSet);
}

/**
 * Tool Surface Compositor:
 * Determines available tools strictly based on runtime environment state.
 * No natural-language regex parsing or prompt guessing — pure boolean checks.
 *
 * Excludes self-referential specialist tools (e.g. if the code model is driving,
 * it doesn't need generate_code; it is the code specialist).
 */
export function composeTools(env: EnvironmentState, driverModelId: ModelId): AgentTool[] {
  const tools: AgentTool[] = [];

  // request_capability tool
  tools.push(requestCapabilityTool);

  // 1. Python execution & deliverable generation
  tools.push(executePythonTool);
  tools.push(generateDeliverableTool);

  // 2. Result retrieval tool: available in tool dispatcher, filtered dynamically per turn until results exist
  tools.push(retrieveResultTool);

  // 3. Knowledge base tool (RAG query)
  if (env.hasKnowledgeBaseDocs) {
    tools.push(retrieveKnowledgeTool);
  }

  // 4. Workspace file tools (always active: mounts user workspace, or falls back to run sandbox dir)
  tools.push(...workspaceTools);

  // 5. Multimodal document extraction (strictly if user attached visual documents, PDFs, or drawings)
  if (env.hasVisualAttachments ?? env.hasAttachments) {
    tools.push(extractDocumentTool);
  }

  // 6. Cross-specialist delegation tools
  // If the driver is NOT the code model, provide code generation capability
  if (driverModelId !== "code-qwen25coder") {
    tools.push(generateCodeTool);
  }

  // If the driver is NOT the drafting model, provide text drafting capability.
  // In an active workspace without document attachments, the code model must write/refactor
  // code directly using workspace tools, NOT offload coding tasks to generate_text.
  if (driverModelId !== "draft-qwen3" && (!env.hasWorkspace || env.hasAttachments)) {
    tools.push(generateTextTool);
  }

  return tools;
}

/** Apply execution scope independently of which workspace is mounted. */
export function constrainToolsToIntent(
  tools: AgentTool[],
  intent: Partial<SemanticIntent>,
  contract?: RunContract,
  env?: EnvironmentState,
): AgentTool[] {
  const formattedDocumentRevision = intent.intentType === "document_drafting" &&
    [...(intent.targetFiles ?? []), ...(intent.expectedDeliverables ?? []).map((d) => d.filename ?? "")]
      .some((filename) => /\.(?:docx|xlsx|pdf)$/i.test(filename));

  const isPureChat = Boolean(
    (intent.intentType === "pure_chat" || intent.intentType === "general_qa") &&
    !env?.hasWorkspace && !env?.hasAttachments && !env?.hasKnowledgeBaseDocs
  );

  const chatOnly = Boolean(
    contract?.response.chatOnly ||
    intent.chatResponseOnly ||
    isPureChat
  );

  const workspaceMutationRequested = Boolean(
    !formattedDocumentRevision &&
    !chatOnly &&
    (contract?.workspace.requested ?? intent.workspaceMutationRequested)
  );

  const commandExecutionRequested = Boolean(
    !chatOnly &&
    (intent.intentType === "command_execution" ||
     contract?.workspace.operations?.some((op) => op.operation === "execute"))
  );

  const hasDeliverables = Boolean(
    (contract?.deliverables && contract.deliverables.length > 0) ||
    (intent.expectedDeliverables && intent.expectedDeliverables.length > 0) ||
    intent.intentType === "document_drafting"
  );

  const excluded = new Set<string>();

  // 1. Mutation tools: prune during explicitly chat-only/read-only execution
  if (!workspaceMutationRequested) {
    excluded.add("write_file");
    excluded.add("delete_file");
  }
  if (!workspaceMutationRequested && !commandExecutionRequested) {
    excluded.add("run_command");
  }

  // Pure chat with no workspace, attachments, or KB docs needs no workspace or execution tools
  if (isPureChat) {
    excluded.add("read_file");
    excluded.add("list_dir");
    excluded.add("search");
    excluded.add("write_file");
    excluded.add("delete_file");
    excluded.add("run_command");
    excluded.add("execute_python");
    excluded.add("generate_code");
    excluded.add("generate_text");
    excluded.add("generate_deliverable");
    excluded.add("retrieve_result");
  }

  // 4. Avoid unnecessary specialist-tool overlap
  if (isPureChat && !hasDeliverables) {
    excluded.add("generate_deliverable");
  }

  if (intent.taskType !== "code" && intent.intentType !== "code_modification") {
    excluded.add("generate_code");
  }

  if (intent.intentType !== "document_drafting" || hasDeliverables) {
    excluded.add("generate_text");
  }

  const computationRequested = /\b(?:python|calculate|compute|reconcil|pandas|numpy|script|math)\b/i.test(
    `${intent.primaryGoal ?? ""} ${contract?.objective ?? ""}`
  );
  if ((intent.intentType === "file_inspection" || intent.intentType === "document_drafting" || chatOnly) && !computationRequested) {
    if (intent.intentType !== "command_execution" && intent.intentType !== "code_modification") {
      excluded.add("execute_python");
    }
  }

  if (intent.intentType === "code_modification") {
    excluded.add("generate_text");
    excluded.add("generate_code");
    const deliverables = intent.expectedDeliverables ?? [];
    if (deliverables.length > 0 && deliverables.every((file) => file.filename?.endsWith(".py"))) {
      excluded.add("generate_deliverable");
    }
  }

  const pythonDeliverables = intent.intentType === "code_modification"
    ? (intent.expectedDeliverables ?? []).filter((file) => file.filename?.endsWith(".py")).map((file) => file.filename!)
    : [];

  return tools.filter((tool) => !excluded.has(tool.name)).map((tool) => {
    if (tool.name !== "execute_python" || pythonDeliverables.length === 0) return tool;
    const parameters = tool.definition.function.parameters;
    return {
      ...tool,
      definition: {
        ...tool.definition,
        function: {
          ...tool.definition.function,
          description: "Repair, validate and export the requested Python source in one call. code contains only the complete repaired implementation; validation_code contains separate assertions calling repaired['function'] with the real input files. A successful call already delivers the file; do not export or validate it again.",
          parameters: {
            ...parameters,
            required: ["code", "filename", "validation_code"],
            properties: {
              ...parameters.properties,
              filename: { type: "string", enum: pythonDeliverables },
              validation_code: { type: "string", description: "Required separate assertions against the exact repaired namespace, using repaired['function'](...). Never import a different source module. Tests remain outside the delivered source." },
            },
          },
        },
      },
      async execute(args, context) {
        if (!pythonDeliverables.includes(String(args.filename)) || typeof args.validation_code !== "string" || !args.validation_code.trim()) {
          const message = `Repair requires filename=${pythonDeliverables.join(" or ")}, code containing the repaired implementation, and separate validation_code asserting its behavior through repaired['function'](...). Helper scripts are not deliverables. No operation was executed.`;
          return { ok: false, output: message, summary: "Repair validation arguments required", error: { code: "invalid_arguments", retryable: true, message } };
        }
        return tool.execute(args, context);
      },
    } satisfies AgentTool;
  });
}
