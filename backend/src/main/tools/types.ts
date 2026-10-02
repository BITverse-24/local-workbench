import type { AgentToolDefinition, ArtifactRef } from "../../shared/contracts.js";
import type { ModelGateway } from "../gateway/model-gateway.js";
import type { HarnessManager } from "../harness/harness-manager.js";
import type { MutationPolicyGuard } from "../harness/policy-guard.js";
import type { RAGGroundingProvider } from "../grounding/rag-grounding-provider.js";

export type ToolErrorCode =
  | "invalid_arguments"
  | "permission_denied"
  | "file_not_found"
  | "timeout"
  | "sandbox_failure"
  | "gateway_failure"
  | "validation_failure"
  | "tool_not_found"
  | "internal_error";

export interface ToolErrorDetail {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export type ToolResult =
  | {
      ok: true;
      toolName: string;
      data: unknown;
      durationMs: number;
      artifacts?: ArtifactRef[];
      output: string;
      summary: string;
    }
  | {
      ok: false;
      toolName: string;
      error: ToolErrorDetail;
      durationMs: number;
      artifacts?: ArtifactRef[];
      output: string;
      summary: string;
    };

export interface ToolExecutionContext {
  runId: string;
  workspaceRoot: string;
  gateway: ModelGateway;
  harness?: HarnessManager;
  grounding?: RAGGroundingProvider;
  policyGuard?: MutationPolicyGuard;
  emitRunEvent?: (event: any) => void;
  lastAssistantContent?: string;
}

export interface ToolExecutionResult {
  output: string;
  summary: string;
  ok?: boolean;
  error?: ToolErrorDetail;
  data?: unknown;
  artifacts?: ArtifactRef[];
  sideEffects?: string[];
}

export interface AgentTool {
  name: string;
  definition: AgentToolDefinition;
  execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}
