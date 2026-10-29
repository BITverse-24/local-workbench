/** Requirements describe obligations. They never grant tool or workspace authority. */
export interface AgentSourceQuote {
  messageId: string;
  start: number;
  end: number;
  quote: string;
}
export interface AgentRequirement {
  id: string;
  kind: "inspect" | "change" | "execute" | "preserve" | "deliver";
  description: string;
  source: AgentSourceQuote;
  mandatory: boolean;
  dependencies: string[];
  acceptance: Array<{ id: string; description: string; kind: "inspection" | "execution" | "review" | "delivery" }>;
  state: "active" | "superseded" | "waived";
  resolution?: AgentSourceQuote;
}
export type AgentMessageDisposition = "continue" | "evidence" | "scope_revision" | "status" | "regression";
export interface AgentTaskRevision {
  schemaVersion: 1;
  taskId: string;
  revision: number;
  messages: Array<{ id: string; content: string; disposition: AgentMessageDisposition }>;
  requirements: AgentRequirement[];
}
export interface AgentTask {
  taskId: string;
  chatId: string;
  workspace: { root: string; registeredAt: string };
  status: "open" | "partial" | "completed";
  current: boolean;
  snapshot: AgentTaskRevision;
  latestRunId?: string;
}
export interface AgentTaskBinding {
  runId: string;
  taskId: string;
  taskRevision: number;
  disposition: AgentMessageDisposition;
  predecessorRunId?: string;
}
export type AgentRequirementUpdate =
  | { operation: "append"; requirement: AgentRequirement }
  | { operation: "supersede" | "waive"; requirementId: string; source: AgentSourceQuote };
export interface TaskEvidenceRef {
  taskId: string;
  originRunId: string;
  resultId: string;
  sha256: string;
  requirementIds: string[];
  sourceRevision: string;
}
export interface SourceReadReceipt {
  path: string;
  digest: string;
  startByte: number;
  endByte: number;
  sizeBytes: number;
  resultId: string;
  requestId: string;
}
