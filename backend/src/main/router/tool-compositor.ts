import type { ModelId } from "../../shared/contracts.js";
import type { AgentTool } from "../tools/types.js";
import type { SemanticIntent } from "./contextual-router.js";
import { workspaceTools } from "../tools/workspace-tools.js";
import {
  extractDocumentTool,
  generateCodeTool,
  generateTextTool,
  retrieveKnowledgeTool,
  executePythonTool,
  generateDeliverableTool,
} from "../tools/specialist-tools.js";

export interface EnvironmentState {
  hasWorkspace: boolean;
  hasAttachments: boolean;
  hasKnowledgeBaseDocs: boolean;
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

  // 1. Always available capabilities
  tools.push(executePythonTool);
  tools.push(generateDeliverableTool);

  // 2. Knowledge base tool (RAG query)
  if (env.hasKnowledgeBaseDocs) {
    tools.push(retrieveKnowledgeTool);
  }

  // 3. Workspace file tools (always active: mounts user workspace, or falls back to run sandbox dir)
  tools.push(...workspaceTools);

  // 4. Multimodal document extraction (if user attached images or documents)
  if (env.hasAttachments) {
    tools.push(extractDocumentTool);
  }

  // 5. Cross-specialist delegation tools
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
export function constrainToolsToIntent(tools: AgentTool[], intent: Partial<SemanticIntent>): AgentTool[] {
  const formattedDocumentRevision = intent.intentType === "document_drafting" &&
    [...(intent.targetFiles ?? []), ...(intent.expectedDeliverables ?? []).map((d) => d.filename ?? "")]
      .some((filename) => /\.(?:docx|xlsx|pdf)$/i.test(filename));
  if (!formattedDocumentRevision && (intent.workspaceMutationRequested || intent.intentType === "command_execution")) return tools;
  const excluded = new Set(["write_file", "delete_file", "run_command"]);
  if (intent.intentType === "file_inspection" || intent.intentType === "document_drafting") {
    excluded.add("generate_code");
    excluded.add("execute_python");
  }
  if (intent.intentType === "code_modification") {
    excluded.add("generate_text");
    excluded.add("generate_code");
    const deliverables = intent.expectedDeliverables ?? [];
    // execute_python already exports the exact source that passed validation.
    // A separate export would rewrite that artifact and invalidate its checks.
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
