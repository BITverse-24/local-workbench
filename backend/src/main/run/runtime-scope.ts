import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionMode } from "../../shared/contracts.js";
import type { AgentCountingProfile } from "../gateway/agent-admission.js";

/** Set by the backend dispatcher, never by a model or a tool argument. */
export interface RuntimeScope {
  runId: string;
  mode: ExecutionMode;
  signal: AbortSignal;
  remainingModelCalls?: number;
  remainingRecoveryAttempts?: number;
  /** Set only after host counting setup. Each selected transport needs its own verification. */
  agentCountingProfiles?: AgentCountingProfile[];
  /** Requirements calls have no workspace tools and precede the immutable run/task binding. */
  agentPhase?: "requirements" | "actions";
  assertAuthority?: () => void;
  approveUncontainedPython?: (code: string, inputs: string[], digest: string) => Promise<boolean>;
  observe?: (values: Record<string, unknown>) => void;
}

const scopes = new AsyncLocalStorage<RuntimeScope>();
export function currentRuntimeScope(): RuntimeScope | undefined { return scopes.getStore(); }
export function withRuntimeScope<T>(scope: RuntimeScope, operation: () => T): T { return scopes.run(scope, operation); }
export function assertRuntimeActive(): void {
  const scope = currentRuntimeScope();
  scope?.signal.throwIfAborted();
  scope?.assertAuthority?.();
}

export function abortError(): Error {
  const error = new Error("Run cancelled.");
  error.name = "AbortError";
  return error;
}

/** All Work stage retries and source corrections share this run budget. */
export function takeWorkRecovery():boolean {
  const scope=currentRuntimeScope();if(scope?.mode!=="work")return true;
  scope.remainingRecoveryAttempts??=2;
  if(scope.remainingRecoveryAttempts<=0)return false;
  scope.remainingRecoveryAttempts--;scope.observe?.({recoveryCount:1});return true;
}
