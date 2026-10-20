import { randomUUID } from "node:crypto";
import type { RunVerificationState, VerificationAttempt, VerificationCheck, VerificationPlan, VerificationTermination } from "../../shared/contracts.js";
import { getExecutionLedger, updateRunVerificationState } from "./execution-ledger.js";

export function getRunVerificationState(runId: string): RunVerificationState | undefined {
  return getExecutionLedger(runId)?.verification;
}

/** Ignore response liveness until delivery; a user waiver never establishes a pass. */
export function mandatoryVerificationSatisfied(checks: VerificationCheck[], options: { includeResponse?: boolean } = {}): boolean {
  return checks.every(check => !check.mandatory || (options.includeResponse !== true && check.criterionId === "acceptance:response") || check.status === "passed" ||
    (check.criterionId === "acceptance:validate-written-code" && check.status === "skipped" && Boolean(check.waiver?.basis.trim()) && Boolean(check.waiver?.recordedAt)));
}

export function unresolvedVerificationChecks(checks: VerificationCheck[], options: { includeResponse?: boolean } = {}): VerificationCheck[] {
  return checks.filter(check => !mandatoryVerificationSatisfied([check], options));
}

export function recordVerificationEvidence(runId: string, checks: VerificationCheck[]): void {
  updateRunVerificationState(runId, state => {
    const combined = new Map(state.evidence.map(check => [check.criterionId, check]));
    for (const check of checks) {
      if (check.status === "skipped" || check.waiver) throw new Error("Only a direct user waiver can skip verification.");
      combined.set(check.criterionId, check);
    }
    state.evidence = [...combined.values()];
    state.phase = mandatoryVerificationSatisfied(state.evidence) ? "complete" : "pending";
    state.termination = undefined;
  });
}

export function recordVerificationTermination(runId: string, termination: VerificationTermination): void {
  const nextAction = termination.nextAction ?? (/budget|retry_exhausted/.test(termination.reason)
    ? "Review the remaining checks and start a new run after correcting the cause."
    : /interrupted|stale/.test(termination.reason)
    ? "Resume the saved run to verify its current revision."
    : "Resolve the reported cause, then resume the saved run.");
  updateRunVerificationState(runId, state => { state.phase = "blocked"; state.termination = { ...termination,
    detail: termination.detail.slice(0, 2000), criterionIds: termination.criterionIds.slice(0, 200), nextAction: nextAction.slice(0, 500) }; });
}

/** Only the latest direct user text can establish this opt-out. */
export function extractVerificationSkipBasis(userText: string): string | undefined {
  const instructions = userText.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/^\s*>.*$/gm, " ");
  const candidates = instructions.matchAll(/(?:\b(?:do\s+not|don['’]t|never)\s+(?:run|execute)\s+(?:any\s+|the\s+)?(?:tests?|test\s+suites?|validation)|\bskip\s+(?:running\s+|executing\s+)?(?:any\s+|the\s+)?(?:tests?|test\s+suites?|validation))\b/gi);
  for (const match of candidates) {
    const prefix = instructions.slice(0, match.index);
    if (/(?:^|[.!?;,\n]\s*|\band\s+)(?:please\s+)?$/i.test(prefix)) return match[0];
  }
  return undefined;
}

export function recordVerificationUserSkip(runId: string, basis: string): void {
  if (!basis.trim()) throw new Error("A verification skip requires an explicit user basis.");
  updateRunVerificationState(runId, state => { state.userSkip = { basis, recordedAt: new Date().toISOString() }; });
}

export function registerVerificationPlan(runId: string, plan: VerificationPlan): void {
  updateRunVerificationState(runId, state => {
    const existing = state.plans.find(item => item.id === plan.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(plan)) throw new Error("A verification plan cannot change after registration.");
    if (!existing) state.plans.push(plan);
    state.phase = "planning"; state.termination = undefined;
  });
}

/** Persist before dispatch so a restart cannot restore a spent attempt. */
export function startVerificationAttempt(runId: string, planId: string): VerificationAttempt {
  let attempt: VerificationAttempt | undefined;
  updateRunVerificationState(runId, state => {
    const plan = state.plans.find(item => item.id === planId);
    if (!plan) throw new Error("Verification plan is not registered.");
    if (state.attempts.some(item => item.status === "running")) throw new Error("A verification attempt is already running.");
    attempt = { id: randomUUID(), planId, revision: plan.revision, status: "running", startedAt: new Date().toISOString() };
    state.attempts.push(attempt); state.phase = "running"; state.termination = undefined;
  });
  if (!attempt) throw new Error("Run has no execution ledger for verification.");
  return attempt;
}

export function finishVerificationAttempt(runId: string, attemptId: string, result: { status: "passed" | "failed" | "unverified"; resultId?: string; reason?: string }): void {
  updateRunVerificationState(runId, state => {
    const attempt = state.attempts.find(item => item.id === attemptId);
    if (!attempt || attempt.status !== "running") throw new Error("Verification attempt is not running.");
    Object.assign(attempt, result, { completedAt: new Date().toISOString() });
    state.phase = result.status === "passed" ? "pending" : "blocked";
  });
}

/** The repair allowance is shared by every revision and explicit resume. */
export function takeAgentVerificationRepair(runId: string): boolean {
  let allowed = false;
  updateRunVerificationState(runId, state => {
    if (state.repairCount < 2) { state.repairCount++; state.phase = "repairing"; state.termination = undefined; allowed = true; }
  });
  return allowed;
}

export function takeVerificationFullSuiteFallback(runId: string, revision: string): boolean {
  let allowed = false;
  updateRunVerificationState(runId, state => {
    if (!state.fullSuiteRevisions.includes(revision)) { state.fullSuiteRevisions.push(revision); allowed = true; }
  });
  return allowed;
}

export type VerificationNextAction = "deliver" | "verify" | "repair" | "stop";
export function nextVerificationAction(checks: VerificationCheck[], options: { verificationRetryAvailable: boolean; repairAvailable: boolean; blocked?: boolean }): VerificationNextAction {
  if (mandatoryVerificationSatisfied(checks)) return "deliver";
  if (options.blocked) return "stop";
  const unresolved = unresolvedVerificationChecks(checks);
  if (unresolved.some(check => check.status === "failed")) return options.repairAvailable ? "repair" : "stop";
  return options.verificationRetryAvailable ? "verify" : "stop";
}
