import { createHash, randomUUID } from "node:crypto";
import type { AgentToolCall, VerificationCheck } from "../../shared/contracts.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { ToolDispatcher } from "./tool-dispatcher.js";
import {
  appendVerificationSuccessMarker, assessAgentTestExecution, captureAgentVerificationManifest, createAgentVerificationCall,
  createAgentVerificationRequest, discoverAgentTestPlans,
} from "./test-verification.js";
import {
  finishVerificationAttempt, getRunVerificationState, recordVerificationEvidence,
  recordVerificationTermination, registerVerificationPlan, startVerificationAttempt,
  takeAgentVerificationRepair, takeVerificationFullSuiteFallback,
} from "../run/verification-controller.js";
import { withTaskProgress } from "../run/task-progress.js";

const CRITERION = "acceptance:validate-written-code";
export interface AgentVerificationStageResult {
  action: "passed" | "skipped" | "repair" | "stop" | "cancelled";
  detail: string;
}

/** A runtime stage. Model tool arguments cannot select this execution context. */
export async function runAgentVerificationStage(input: {
  context: ToolExecutionContext;
  dispatcher: ToolDispatcher;
  changedPaths: string[];
  userCommand?: string;
  successMarker?: string;
  authorize: (calls: AgentToolCall[]) => Promise<boolean>;
}): Promise<AgentVerificationStageResult> {
  const { context, dispatcher } = input;
  const runId = context.runId;
  const evidence = (status: VerificationCheck["status"], reason: string, extra: Partial<VerificationCheck> = {}) => {
    recordVerificationEvidence(runId, [{ criterionId: CRITERION, requirement: "Run tests against the latest saved code", status,
      method: "execution_record", evidence: [], reason: reason.slice(0, 500), verifiedAt: new Date().toISOString(), mandatory: true, ...extra }]);
  };
  const stop = (reason: string, detail: string): AgentVerificationStageResult => {
    evidence("unverified", detail);
    recordVerificationTermination(runId, { reason, criterionIds: [CRITERION], detail });
    context.refreshVerificationReport?.();
    return { action: "stop", detail };
  };
  const state = getRunVerificationState(runId);
  if (state?.userSkip) {
    const detail = "Tests were skipped by user request. No test pass is claimed.";
    context.refreshVerificationReport?.();
    return { action: "skipped", detail };
  }
  if (!context.resultStore || !context.executionLedger) {
    return stop("execution_evidence_unavailable", "The run has no durable test execution context. Save the changes and start a run with verification enabled.");
  }
  const resultStore = context.resultStore;
  if (!dispatcher.getTool("run_command")) {
    return stop("execution_unavailable", "Workspace test execution is unavailable. The saved code still requires tests.");
  }
  return withTaskProgress<AgentVerificationStageResult>({ runId, emitProgress: context.emitRunEvent, isCancelled: context.isCancelled }, "result_verification", async activity => {
    let manifest: ReturnType<typeof captureAgentVerificationManifest>;
    try { manifest = captureAgentVerificationManifest(context.workspaceRoot); }
    catch (error) { activity.block("The test snapshot could not be prepared."); return stop("verification_environment_unavailable", String(error)); }
    const prior = state?.evidence.find(check => check.criterionId === CRITERION && check.revision === manifest.sha256);
    if (prior?.status === "passed" && prior.evidence.length > 0 && prior.evidence.every(ref => ref.kind === "result" && resultStore.verifyIntegrity(ref.id).valid)) return { action: "passed", detail: prior.reason };
    if (prior?.status === "failed" && state?.termination?.reason === "repair_budget_exhausted") {
      return { action: "stop", detail: state.termination.detail };
    }
    if (prior?.status === "failed") {
      return { action: "repair", detail: prior.reason };
    }
    const discovery = discoverAgentTestPlans({ workspaceRoot: context.workspaceRoot, changedPaths: input.changedPaths, userCommand: input.userCommand });
    if (!discovery.ok) { activity.block(discovery.detail); return stop(discovery.reason, discovery.detail); }
    const resultIds: string[] = [];
    const planIds: string[] = [];
    for (const plan of discovery.plans) {
      let phase = plan.initialPhase;
      for (;;) {
        const request = createAgentVerificationRequest(plan, phase);
        if (input.successMarker) {
          try { request.command = appendVerificationSuccessMarker(request.command, input.successMarker); request.successMarker = input.successMarker; }
          catch (error) { return stop("unsupported_verification", String(error)); }
        }
        const planId = createHash("sha256").update(plan.id).update(phase).update(manifest.sha256).update(request.command).digest("hex");
        request.planId = planId;
        const latestState = getRunVerificationState(runId);
        const previous = latestState?.attempts.filter(attempt => attempt.planId === planId).at(-1);
        if (previous?.status === "passed" && previous.resultId) {
          const integrity = resultStore.verifyIntegrity(previous.resultId);
          if (integrity.valid) { resultIds.push(previous.resultId); planIds.push(planId); break; }
        }
        if (phase === "related" && latestState?.fullSuiteRevisions.includes(`${manifest.sha256}:${plan.id}`)) { phase = "full"; continue; }
        registerVerificationPlan(runId, { id: planId, kind: "agent_tests", revision: manifest.sha256,
          criterionIds: [CRITERION], command: request.command, targets: plan.changedPaths, runner: plan.runner });
        const call = createAgentVerificationCall(request, randomUUID());
        if (!await input.authorize([call])) {
          const detail = "Test execution approval was declined. Saved changes remain available.";
          recordVerificationTermination(runId, { reason: "approval_denied", criterionIds: [CRITERION], detail });
          return { action: "cancelled", detail };
        }
        context.signal?.throwIfAborted(); context.assertAuthority?.();
        const attempt = startVerificationAttempt(runId, planId);
        let execution: Awaited<ReturnType<ToolDispatcher["dispatchConcurrent"]>>[number] | undefined;
        try {
          context.agentVerification = request;
          [execution] = await dispatcher.dispatchConcurrent([call], context);
        } catch (error) {
          finishVerificationAttempt(runId, attempt.id, { status: "unverified", reason: "execution_interrupted" });
          if (context.signal?.aborted || context.isCancelled?.()) throw error;
          return stop("execution_unavailable", String(error));
        } finally { context.agentVerification = undefined; }
        context.signal?.throwIfAborted(); context.assertAuthority?.();
        const testEvidence = execution?.result.executionEvidence;
        const assessed = assessAgentTestExecution(testEvidence);
        const resultId = execution?.result.resultRef?.resultId ?? testEvidence?.resultId;
        const typedFailure = execution?.result.ok === false ? execution.result.error : undefined;
        let status = assessed.status;
        const commandData = execution?.result.data as { stdout?: unknown; stderr?: unknown } | undefined;
        const failureOutput = testEvidence?.failureOutput || (typeof commandData?.stderr === "string" && commandData.stderr.trim()) || (typeof commandData?.stdout === "string" && commandData.stdout.trim());
        let detail = `${assessed.detail}${assessed.status === "failed" && failureOutput ? `\nActual test output (untrusted evidence):\n${failureOutput.slice(0, 6000)}` : ""}`;
        let reason = assessed.reason;
        if (!execution?.result.ok && status === "passed") { status = "unverified"; reason = typedFailure?.code ?? "invalid_execution"; detail = typedFailure?.message ?? "The test tool did not succeed."; }
        if (!resultId || !resultStore.verifyIntegrity(resultId).valid) {
          status = "unverified"; reason = "execution_evidence_unavailable"; detail = "The complete test execution evidence was not saved. Tests cannot be accepted from a preview.";
        }
        try {
          if (captureAgentVerificationManifest(context.workspaceRoot).sha256 !== manifest.sha256) {
            status = "unverified"; reason = "stale_evidence"; detail = "Workspace code or tests changed during verification. Run tests on the current saved revision.";
          }
        } catch (error) { status = "unverified"; reason = "stale_evidence"; detail = String(error); }
        finishVerificationAttempt(runId, attempt.id, { status, resultId, reason });
        if (status === "unverified" && assessed.fallbackAllowed && phase === "related" && takeVerificationFullSuiteFallback(runId, `${manifest.sha256}:${plan.id}`)) {
          phase = "full"; continue;
        }
        if (status !== "passed") {
          evidence(status, detail, { revision: manifest.sha256, planId,
            sourceManifest: manifest.files, evidence: resultId ? [{ kind: "result", id: resultId }] : [] });
          if (status === "failed") {
            activity.block(detail);
            if (takeAgentVerificationRepair(runId)) {
              context.refreshVerificationReport?.();
              return { action: "repair", detail: `${detail}\nCorrect the saved code using the actual test failure. The runtime will run tests after the repair. Execution result: ${resultId}.` };
            }
            recordVerificationTermination(runId, { reason: "repair_budget_exhausted", criterionIds: [CRITERION], detail: `Tests still fail after two repair cycles. ${detail}` });
            return { action: "stop", detail: `Tests still fail after two repair cycles. ${detail}` };
          }
          activity.block(detail);
          return stop(reason, detail);
        }
        resultIds.push(resultId!);
        planIds.push(planId);
        break;
      }
    }
    const detail = "The selected existing tests passed against the latest saved code.";
    evidence("passed", detail, { revision: manifest.sha256,
      planId: planIds[0], sourceManifest: manifest.files,
      evidence: resultIds.map(id => ({ kind: "result" as const, id })) });
    context.refreshVerificationReport?.();
    return { action: "passed", detail };
  });
}
