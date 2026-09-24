import type { AgentToolDefinition, ArtifactRef } from "../../shared/contracts.js";
import type { ModelGateway } from "../gateway/model-gateway.js";
import type { HarnessManager } from "../harness/harness-manager.js";
import type { RAGGroundingProvider } from "../grounding/rag-grounding-provider.js";

export interface ToolExecutionContext {
  runId: string;
  workspaceRoot: string;
  gateway: ModelGateway;
  harness?: HarnessManager;
  grounding?: RAGGroundingProvider;
  emitRunEvent?: (event: any) => void;
}

export interface ToolExecutionResult {
  output: string;
  summary: string;
  artifacts?: ArtifactRef[];
  sideEffects?: string[];
}

export interface AgentTool {
  name: string;
  definition: AgentToolDefinition;
  execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}
