import type {
  AgentToolDefinition,
  ArtifactRef,
  CapabilityGroup,
  ExecutionEnvelope,
  IntermediateResultInput,
  IntermediateResultRecord,
  RunContract,
} from "../../shared/contracts.js";
import type { RunResultStore } from "../run/result-store.js";
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
  | "persistence_failure"
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
      resultRef?: IntermediateResultRecord;
    }
  | {
      ok: false;
      toolName: string;
      error: ToolErrorDetail;
      durationMs: number;
      artifacts?: ArtifactRef[];
      output: string;
      summary: string;
      resultRef?: IntermediateResultRecord;
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
  isCancelled?: () => boolean;
  sourceReferences?: Array<{ filename: string; page: number }>;
  requestedArtifacts?: Array<{ type: string; filename: string }>;
  indexedKnowledgeSources?: Array<{ filename: string; docId: string }>;
  runContract?: RunContract;
  resultStore?: RunResultStore;
  currentCallId?: string;
  envelope?: ExecutionEnvelope;
  activeCapabilities?: Set<CapabilityGroup>;
}

export interface ToolExecutionResult {
  output: string;
  summary: string;
  ok?: boolean;
  error?: ToolErrorDetail;
  data?: unknown;
  artifacts?: ArtifactRef[];
  sideEffects?: string[];
  /** Full pre-observation-budget payload; registered by the dispatcher when a store is present. */
  intermediate?: Omit<IntermediateResultInput, "producer" | "summary">;
}

export interface AgentTool {
  name: string;
  definition: AgentToolDefinition;
  execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}
