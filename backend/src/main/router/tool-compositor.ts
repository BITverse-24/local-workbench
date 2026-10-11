import type { CapabilityGroup, ExecutionEnvelope, ModelId, RunContract } from "../../shared/contracts.js";
import type { AgentTool } from "../tools/types.js";
import type { SemanticIntent } from "./contextual-router.js";
import { workspaceTools } from "../tools/workspace-tools.js";
import { retrieveResultTool } from "../tools/result-retrieval.js";
import {
  extractDocumentTool,
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
  attachedSourceFiles?: string[];
  attachedSourceBytes?: Record<string, number>;
  maxOutputTokens?: number;
}

/**
 * Returns all potential tools registered in Local Workbench.
 */
export function getAllAvailableTools(_driverModelId: ModelId, _isSingleModel = true): AgentTool[] {
  const tools: AgentTool[] = [
    requestCapabilityTool,
    ...workspaceTools,
    executePythonTool,
    generateDeliverableTool,
    retrieveResultTool,
    retrieveKnowledgeTool,
    extractDocumentTool,
  ];

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
    if (tool.name === "request_capability") return envelope.mode !== "chat";

    // 2. Chat mode server-side restriction: workspace mutations and system commands never visible
    if (envelope.mode === "chat") {
      if (!["extract_document", "retrieve_result", "retrieve_knowledge"].includes(tool.name)) {
        return false;
      }
    }

    if (envelope.mode === "work" && ["write_file", "delete_file", "run_command"].includes(tool.name)) return false;
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
    if (!cap) return false; // If not mapped to a group, expose if permitted

    return envelope.permittedCapabilities.includes(cap) && activeCapabilities.has(cap);
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
export function composeTools(env: EnvironmentState, _driverModelId: ModelId): AgentTool[] {
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

  const hasDeliverables = contract ? contract.deliverables.length > 0 : Boolean(
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
  if (!hasDeliverables) {
    excluded.add("generate_deliverable");
  }

  if (intent.taskType !== "code" && intent.intentType !== "code_modification") {
    excluded.add("generate_code");
  }

  if (intent.intentType !== "document_drafting" || hasDeliverables) {
    excluded.add("generate_text");
  }

  const computationRequested = intent.taskType === "code" || intent.intentType === "code_modification" ||
    intent.intentType === "command_execution" || Boolean(intent.validationRequested);
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

  const strictPythonNames = (contract?.deliverables ?? intent.expectedDeliverables ?? []).filter(file => file.filenameRequired && file.filename?.endsWith(".py")).map(file => file.filename!);
  return tools.filter((tool) => !excluded.has(tool.name)).map((tool) => {
    if (tool.name !== "execute_python" || pythonDeliverables.length === 0) return tool;
    const parameters = tool.definition.function.parameters;
    const repairProperties = parameters.properties ?? {};
    const sourceFiles = !workspaceMutationRequested ? env?.attachedSourceFiles ?? [] : [];
    const patchRepair = sourceFiles.length > 0;
    // A full source avoids block-edit ambiguity when it fits the configured
    // generation budget with room for transport and independent checks.
    const sourceBytes = sourceFiles.length === 1 ? env?.attachedSourceBytes?.[sourceFiles[0]] : undefined;
    const fullSourceFits = sourceBytes !== undefined && env?.maxOutputTokens !== undefined &&
      Math.ceil(sourceBytes / 3) <= Math.floor(env.maxOutputTokens / 2);
    return {
      ...tool,
      definition: {
        ...tool.definition,
        function: {
          ...tool.definition.function,
          description: fullSourceFits ? "The complete attached source fits the generation budget. Supply code containing the entire corrected implementation, filename and input_files. Preserve the interface and unrelated behavior. Provide independent checks from original evidence. Execute and export this exact source. A successful call already delivers the file." : patchRepair ? "Supply complete corrected code OR exact source_file/edits, execute it on the data, and export the corrected file. Fix every documented defect; preserve unrelated code and the interface. Each old string must match once in the selected source. Default source is the original attachment; to continue a failed attempt use its returned source_revision. Anchor insertions to an existing line. A successful call already delivers the file." : "Repair and export the requested Python source, then execute it against the supplied input files. code contains only the complete implementation. A successful call already delivers the file; do not export it again.",
          parameters: {
            ...parameters,
            required: patchRepair && !fullSourceFits ? ["filename"] : ["code", "filename"],
            properties: {
              ...repairProperties,
              input_files: { type: "array", items: { type: "string" }, description: "Only runtime DATA arguments, in the original CLI order. The attached source is source_file, never an input argument." },
              ...(patchRepair && !fullSourceFits ? { source_file: { type: "string", enum: sourceFiles }, source_revision: { type: "string", description: "Optional SHA-256 revision returned by a prior execution. Omit for the original attachment. old strings must match that selected version. To retry only validation, supply this revision, edits=[] and new validation_code." }, edit_indentation: { type: "string", enum: ["exact", "relative"], description: "Default exact preserves replacement whitespace. Choose relative explicitly for replacements indented relative to old's source line." }, edits: { type: "array", description: "Exact old/new replacements; no indentation is inferred or changed. Include leading whitespace in old and full absolute indentation in new for block edits. Fix source-supported defects and retain unrelated source text.", items: { type: "object", properties: { old: { type: "string" }, new: { type: "string", format: "multiline", description: "Exact replacement source lines, including their complete indentation." } }, required: ["old", "new"] } } } : {}),
              filename: strictPythonNames.length ? { type: "string", enum: strictPythonNames } : { type: "string", description: `Source filename; the corrected export is ${pythonDeliverables.join(", ")}.` },
            },
          },
        },
      },
      async execute(args, context) {
        if (fullSourceFits && (typeof args.code !== "string" || !args.code.trim())) {
          const message = "The complete source fits the generation budget. Supply code containing the entire corrected implementation; no operation was executed.";
          return { ok: false, output: message, summary: "Complete source required", error: { code: "invalid_arguments", retryable: true, message } };
        }
        if (args.filename && strictPythonNames.length && !strictPythonNames.includes(String(args.filename))) {
          const message = `Repair requires filename=${pythonDeliverables.join(" or ")} and code containing the repaired implementation. No operation was executed.`;
          return { ok: false, output: message, summary: "Repair validation arguments required", error: { code: "invalid_arguments", retryable: true, message } };
        }
        // Execute the exact source and any separately supplied assertions.
        return tool.execute({ ...args, ...(patchRepair && args.source_file === undefined && sourceFiles.length === 1 ? { source_file: sourceFiles[0] } : {}), filename: args.filename ?? (pythonDeliverables.length === 1 ? pythonDeliverables[0] : undefined) }, context);
      },
    } satisfies AgentTool;
  });
}
