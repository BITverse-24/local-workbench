import type { ModelId } from "../../shared/contracts.js";
import type { AgentTool } from "../tools/types.js";
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

  // If the driver is NOT the drafting model, provide text drafting capability
  if (driverModelId !== "draft-qwen3") {
    tools.push(generateTextTool);
  }

  return tools;
}
