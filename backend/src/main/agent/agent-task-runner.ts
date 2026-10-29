import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { Validator } from "jsonschema";
import type { AgentTask, AgentToolCall, AgentToolDefinition, RunContract } from "../../shared/contracts.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { getDb } from "../persistence/db.js";
import { bindAgentTaskRun, getAgentTask, getAgentTaskBinding, getCurrentAgentTask, setAgentTaskStatus } from "../run/agent-task-store.js";
import { bindAgentExecutionLedger, configureExecutionLedger, getExecutionLedger, initializeAgentInterpretationBudget, initializeExecutionLedger, takeAgentProtocolCorrection, updateAgentProgress } from "../run/execution-ledger.js";
import { getRunContract, persistRunContract } from "../run/contract.js";
import { currentRuntimeScope, assertRuntimeActive } from "../run/runtime-scope.js";
import { ToolDispatcher } from "./tool-dispatcher.js";
import { getAllAvailableTools, filterToolsForTurn } from "../router/tool-compositor.js";
import { agentWorkspaceActions, canonicalSourcePath, validateAgentFileProposal } from "./workspace-actions.js";
import { fileDigest, readAgentSourceBytes } from "../harness/tools/edit-file.js";
import { resolveSafe } from "../harness/path-guard.js";
import { buildAgentContextPacket, FINISH_TOOL, selectAgentRequirement } from "./context-packet.js";
import { agentInterpretationResponseSchema, interpretationMessages, parseTaskInterpretation, isAgentStatusQuestion } from "./task-interpretation.js";
import { runAgentVerificationStage } from "./verification-stage.js";
import { isCodeVerificationPath } from "./test-verification.js";
import { extractVerificationSkipBasis, recordVerificationTermination, recordVerificationUserSkip } from "../run/verification-controller.js";
import { reviewAgentTaskCoverage } from "./requirement-review.js";
import { captureCommandWorkspaceDigest, commandApprovalDigest, COMMAND_FALLBACK_DISCLOSURE } from "../harness/tools/run-command.js";
import { normalizeRunCommandArgs } from "../tools/workspace-tools.js";

type RunnerInput = { context: ToolExecutionContext; modelId: string; chatId: string; messageId: string; workspace: AgentTask["workspace"]; intent?: "continue" | "new"; predecessorRunId?: string;
  state: (state: "classifying" | "planning" | "acting") => void; approve: (preview: string) => Promise<boolean> };
export interface AgentTaskRunResult { outcome: "completed" | "partial" | "cancelled"; text: string; stopReason: string }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mutations = new Set(["write_file", "edit_file", "delete_file", "run_command", "execute_python", "generate_deliverable"]);
const fileMutations = new Set(["write_file", "edit_file", "delete_file"]);

/** One model, one bounded action, durable host state. No route category or Markdown action synthesis. */
export class AgentTaskRunner {
  async run(input: RunnerInput): Promise<AgentTaskRunResult> {
    const { context, modelId } = input, runId = context.runId, scope = currentRuntimeScope();
    if (!scope || scope.mode !== "agent" || scope.runId !== runId || !context.resultStore || !context.policyGuard || !context.envelope) throw new Error("Agent v3 requires a bound host runtime and result store.");
    const source = getDb().prepare("SELECT content FROM messages WHERE id=? AND chat_id=? AND role='user'").get(input.messageId, input.chatId) as { content: string } | undefined;
    if (!source) throw new Error("Agent requires the saved original user message.");
    const contract: RunContract = getRunContract(runId) ?? persistRunContract({ schemaVersion: 1, runId, createdAt: new Date().toISOString(), objective: source.content.slice(0, 500) || "Inspect selected inputs", resolution: { status: "resolved" }, routing: { intentType: "general_qa", taskType: "code", driverModel: modelId, actionable: true }, response: { required: true, chatOnly: false }, workspace: { requested: false, operations: [] }, deliverables: [], constraints: { protectedPaths: [], restrictMutationsToTargets: false, userConstraints: [] }, acceptance: { validateWrittenCode: false, validatedPythonDeliverables: [], artifactChecks: [] } });
    initializeExecutionLedger(contract); initializeAgentInterpretationBudget(runId);
    configureExecutionLedger(runId, { modelId, mode: "agent", workspaceRoot: context.workspaceRoot, groundingEnabled: !!context.grounding });
    context.runContract = contract; context.executionLedger = getExecutionLedger(runId); context.automaticCodeValidation = true;
    const stop = (reason: string, detail: string, outcome: AgentTaskRunResult["outcome"] = "partial") => {
      updateAgentProgress(runId, progress => { progress.stopReason = reason; progress.feedback = detail.slice(0, 10000); });
      if (outcome === "partial") setAgentTaskStatus(runId, "partial");
      if (outcome === "partial") recordVerificationTermination(runId, { reason, criterionIds: [], detail: detail.slice(0, 2000) });
      const ledger = getExecutionLedger(runId), applied = ledger?.completedOperations.filter(item => fileMutations.has(item.tool)).map(item => item.summary) ?? [];
      const checks = ledger?.verification?.evidence ?? [];
      return { outcome, stopReason: reason, text: `Changes applied: ${applied.join("; ") || "none"}\nChecks passed: ${checks.filter(item => item.status === "passed").map(item => item.reason).join("; ") || "none"}\nChecks unavailable: ${checks.filter(item => item.status === "unverified").map(item => item.reason).join("; ") || "none recorded"}\nRemaining requirements: ${outcome === "completed" ? "none" : detail}` };
    };
    try {
      scope.agentCountingProfiles = await context.gateway.prepareAgentCountingProfiles(modelId, { signal: scope.signal });
      let bound = getAgentTaskBinding(runId);
      if (!bound) {
        input.state("classifying"); scope.agentPhase = "requirements";
        const current = input.intent === "new" ? undefined : getCurrentAgentTask(input.chatId);
        let interpreted: ReturnType<typeof parseTaskInterpretation> | undefined;
        let feedback = "";
        for (;;) {
          const messages = interpretationMessages(source.content, current);
          if (feedback) messages[1].content = JSON.stringify({ ...JSON.parse(messages[1].content), correction: feedback });
          const response = await context.gateway.chatWithTools(modelId, messages, [], { runId, maxTokens: 1024, purpose: "classification", temperature: 0, responseSchema: agentInterpretationResponseSchema, signal: scope.signal });
          if (!response.ok) return stop("interpretation_unavailable", response.error.message);
          try {
            if (response.value.finishReason === "length" || response.value.tool_calls?.length) throw new Error("Requirement interpretation must be complete JSON data, with no workspace action.");
            interpreted = parseTaskInterpretation(response.value.content ?? "", input.messageId, source.content); break;
          } catch (error) {
            context.resultStore.registerResult({ type: "structured", status: "complete", origin: "model_derived", producer: { tool: "agent_rejected_interpretation", callId: randomUUID() }, summary: "Rejected requirement interpretation; no workspace action", payload: { response: response.value.content ?? "", reason: String(error) }, sources: [] });
            if (!takeAgentProtocolCorrection(runId)) {
              bound = bindAgentTaskRun({ runId, chatId: input.chatId, messageId: input.messageId, workspace: input.workspace, intent: input.intent, disposition: "evidence", expectedRevision: current?.snapshot.revision, predecessorRunId: input.predecessorRunId });
              bindAgentExecutionLedger(bound);
              return stop("requirement_interpretation_failed", `The complete request is saved. Its requirements could not be validated: ${String(error)}`);
            }
            feedback = `Correct the JSON once. Keep every user obligation. ${String(error).slice(0, 1000)}`;
          }
        }
        bound = bindAgentTaskRun({ runId, chatId: input.chatId, messageId: input.messageId, workspace: input.workspace, intent: input.intent, disposition: interpreted.disposition, expectedRevision: current?.snapshot.revision, updates: interpreted.updates, predecessorRunId: input.predecessorRunId });
        bindAgentExecutionLedger(bound);
        updateAgentProgress(runId, progress => { progress.fullSuite ||= interpreted!.fullSuite; });
        if (!["evidence", "status"].includes(interpreted.disposition)) { const waiver = extractVerificationSkipBasis(source.content); if (waiver) recordVerificationUserSkip(runId, waiver); }
      }
      scope.agentPhase = "actions"; input.state("acting");
      const task = getAgentTask(bound.taskId)!;
      if (task.snapshot.revision !== bound.taskRevision || task.workspace.root !== input.workspace.root || task.workspace.registeredAt !== input.workspace.registeredAt) return stop("stale_task_binding", "The task or workspace binding changed. Start a fresh bound attempt.");
      if (bound.disposition === "status" || isAgentStatusQuestion(source.content)) {
        const answer = await context.gateway.chatWithTools(modelId, [{ role: "system", content: "Answer the status question from saved task facts only. Do not propose or perform workspace actions. State remaining requirements and unavailable checks." }, { role: "user", content: JSON.stringify({ question: source.content, requirements: task.snapshot.requirements, taskStatus: task.status }) }], [], { runId, maxTokens: 512, signal: scope.signal });
        return answer.ok && answer.value.finishReason !== "length" ? { outcome: "completed", text: answer.value.content ?? "The saved task remains available.", stopReason: "status_reply" } : stop("status_reply_unavailable", answer.ok ? "The status answer was truncated." : answer.error.message);
      }
      if (!task.snapshot.requirements.some(item => item.state === "active")) return stop("requirements_missing", "The full message is saved, but no active requirement was extracted. Narrow or clarify this task.");
      const replacements = new Map(agentWorkspaceActions.map(tool => [tool.name, tool]));
      const registered = [...getAllAvailableTools(modelId).map(tool => replacements.get(tool.name) ?? tool), replacements.get("edit_file")!];
      const dispatcher = new ToolDispatcher(registered);
      context.activeCapabilities = new Set(context.envelope.activeCapabilities);
      for (const capability of ["source_access", "workspace_mutation", "system_execution", "result_retrieval"] as const) context.activeCapabilities.add(capability);
      context.policyGuard.setEnforceExplicit(runId, true);
      const granted: string[] = [];
      const clearApprovals = () => { context.policyGuard!.revokeScopes(granted.splice(0)); context.agentOperationDigest = undefined; context.agentCommandApproval = undefined; };
      const authorize = async (calls: AgentToolCall[]) => {
        for (const call of calls) {
          assertRuntimeActive();
          const commandApproval = call.name === "run_command" ? { workspaceDigest: captureCommandWorkspaceDigest(context.workspaceRoot) } : undefined;
          const previewData = { taskId: bound!.taskId, taskRevision: bound!.taskRevision, requirementId: context.agentRequirementId,
            constraints: task.snapshot.requirements.filter(item => item.state === "active" && item.kind === "preserve"),
            operation: call.name, arguments: call.arguments, ...(commandApproval ? { sourceRevision: commandApproval.workspaceDigest } : {}) };
          const preview = JSON.stringify(previewData, null, 2) + (call.name === "run_command" ? `\n\n${COMMAND_FALLBACK_DISCLOSURE}` : "");
          const before = fileMutations.has(call.name) ? this.sourceVersion(context, call.arguments) : undefined;
          if (!await input.approve(preview)) return false;
          assertRuntimeActive();
          if (before !== undefined && before !== this.sourceVersion(context, call.arguments)) throw new Error("The proposed source changed while approval was pending. Read it again and request a new approval.");
          if (commandApproval && commandApproval.workspaceDigest !== captureCommandWorkspaceDigest(context.workspaceRoot)) throw new Error("The command workspace changed while approval was pending. Propose it again for the current source.");
          context.agentCommandApproval = commandApproval;
          context.agentOperationDigest = commandApproval ? commandApprovalDigest(String(call.arguments.command), commandApproval) : hash([call.name, call.arguments]);
          context.resultStore!.registerResult({ type: "structured", status: "complete", origin: "execution", producer: { tool: "agent_operation_approval", callId: call.id }, summary: "Approved concrete operation and source revision", payload: { ...previewData, operationDigest: context.agentOperationDigest }, sources: [] });
          const grantedScope = context.policyGuard!.grantScope({ runId, operation: call.name as "write_file", targetPath: typeof call.arguments.path === "string" ? canonicalSourcePath(context, call.arguments.path) : undefined,
            command: typeof call.arguments.command === "string" ? call.arguments.command : undefined, operationDigest: fileMutations.has(call.name) || commandApproval ? context.agentOperationDigest : undefined, allowUnisolated: call.name === "run_command" });
          granted.push(grantedScope.id);
        }
        return true;
      };
      const environmentKey = hash([process.platform, process.execPath, process.env.PATH]);
      const hasCodeProject = ["package.json", "pyproject.toml", "pytest.ini", "Cargo.toml", "pom.xml"].some(file => existsSync(resolveSafe(context.workspaceRoot, file)));
      const needsTests = task.snapshot.requirements.some(item => item.state === "active" && (item.kind === "execute" || item.acceptance.some(check => check.kind === "execution") || (item.kind === "change" && hasCodeProject)));
      if (needsTests && !getExecutionLedger(runId)?.agentProgress?.baseline) {
        const baseline = await runAgentVerificationStage({ context, dispatcher, changedPaths: [], authorize, baseline: true });
        clearApprovals();
        updateAgentProgress(runId, progress => { progress.baseline = { status: baseline.action, detail: baseline.detail, environmentKey }; progress.feedback = baseline.detail.slice(0, 10000); });
        if (baseline.action === "cancelled") return stop("approval_denied", baseline.detail, "cancelled");
      }
      for (;;) {
        assertRuntimeActive();
        if ((getExecutionLedger(runId)?.agentTask?.modelCalls ?? 0) >= 40) return stop("model_call_limit", "The run used its 40 model calls. Pending requirements remain saved.");
        const progress = getExecutionLedger(runId)?.agentProgress;
        const pending = task.snapshot.requirements.filter(item => item.state === "active");
        const selected = selectAgentRequirement(task, context);
        const packet = buildAgentContextPacket(task, context, selected);
        // Assess obtained evidence before asking the model to repeat an inspection step.
        // This changes the host phase, not requirement status or registered capabilities.
        const evidenceDigest = progress?.latestResultId ? context.resultStore.getResult(progress.latestResultId).storage.sha256 : undefined;
        const verbatimPageComplete = !pending.some(item => item.acceptance.some(check => check.operation === "verbatim_source")) || packet.observedSource?.endByte === packet.observedSource?.sizeBytes;
        const inspectionDelivery = verbatimPageComplete && packet.observedSource && evidenceDigest && progress?.deliveryEvidenceDigest !== evidenceDigest && pending.every(item => ["inspect", "deliver", "preserve"].includes(item.kind)) && !pending.some(item => item.acceptance.some(check => check.kind === "execution"));
        if (inspectionDelivery) {
          updateAgentProgress(runId, state => { state.deliveryEvidenceDigest = evidenceDigest; });
          const answer = await context.gateway.chatWithTools(modelId, [{ role: "system", content: "The host has obtained source evidence. Propose the requested answer from the supplied requirements and observed content. Do not request or perform more tools in this delivery step. For verbatim_source checks, quote the complete observed source in a fenced block and preserve its whitespace and line endings. Do not claim complete coverage beyond the supplied evidence. The host will review every requirement separately." }, packet.messages[1]], [], { runId, maxTokens: 768, signal: scope.signal });
          if (!answer.ok || answer.value.finishReason === "length" || answer.value.tool_calls?.length || !answer.value.content?.trim()) return stop("delivery_unavailable", answer.ok ? "The delivery proposal was incomplete or requested another action." : answer.error.message);
          const answerDigest = hash(answer.value.content);
          if (progress?.deliveryAttempts.some(attempt => attempt.evidenceDigest === evidenceDigest && attempt.answerDigest === answerDigest)) return stop("repeated_delivery", "The same answer was proposed for unchanged source evidence. Remaining requirements stay saved.");
          updateAgentProgress(runId, state => { state.deliveryAttempts.push({ evidenceDigest, answerDigest }); });
          const admitted = getExecutionLedger(runId)?.agentAdmissions.at(-1);
          if (admitted?.status === "usage_verified") updateAgentProgress(runId, state => { state.reads.push({ ...packet.observedSource!, requestId: admitted.requestId }); });
          context.resultStore.registerResult({ type: "text", status: "complete", origin: "model_derived", producer: { tool: "agent_delivery_proposal", callId: randomUUID() }, summary: "Proposed answer from observed evidence", payload: answer.value.content, sources: [] });
          const reviewed = await reviewAgentTaskCoverage(task, context, modelId, [], answer.value.content);
          if (reviewed.ok) { const completed = stop("requirements_satisfied", "", "completed"); return { ...completed, text: `${answer.value.content}\n\n${completed.text}` }; }
          updateAgentProgress(runId, state => { state.feedback = reviewed.detail; if (reviewed.next === "delivery") state.deliveryEvidenceDigest = undefined; });
          continue;
        }
        const visible = filterToolsForTurn(registered, context.envelope, context.activeCapabilities!, { hasRetrievableResults: true });
        const definitions: AgentToolDefinition[] = visible.map(tool => ({ ...tool.definition, function: { ...tool.definition.function, description: tool.definition.function.description.split(".")[0].slice(0, 220), parameters: { ...tool.definition.function.parameters, properties: { ...tool.definition.function.parameters.properties, requirement_id: { type: "string", description: "Optional active requirement ID; defaults to the current requirement" } } } } }));
        const response = await context.gateway.chatWithTools(modelId, packet.messages, [...definitions, FINISH_TOOL], { runId, maxTokens: 2048, signal: scope.signal });
        if (!response.ok) return stop("model_generation_unavailable", response.error.message);
        const admission = getExecutionLedger(runId)?.agentAdmissions.at(-1);
        if (packet.observedSource && admission?.status === "usage_verified") updateAgentProgress(runId, state => { state.reads.push({ ...packet.observedSource!, requestId: admission.requestId }); });
        let call: AgentToolCall;
        try {
          if (response.value.finishReason === "length") throw new Error("The action was truncated. Return a complete smaller action.");
          const calls = response.value.tool_calls ?? [];
          if (calls.length > 1) throw new Error("Return exactly one action per turn.");
          if (!calls.length && /^\s*```(?:json)?\s*\{[\s\S]*"tool_calls"\s*:/i.test(response.value.content ?? "")) throw new Error('A Markdown example is text and cannot execute. Return one bare JSON object: {"tool_calls":[{"name":"available tool","arguments":{}}],"content":""}. No fences or prose.');
          call = calls[0] ?? { id: randomUUID(), name: "finish", arguments: { text: response.value.content ?? "" } };
          if (call.name !== "finish" && !dispatcher.getTool(call.name)) throw new Error("The proposed tool is not registered.");
          const requirementId = call.arguments.requirement_id;
          context.agentRequirementId = typeof requirementId === "string" ? requirementId : packet.requirement.id;
          if (!pending.some(item => item.id === context.agentRequirementId)) throw new Error("Select an active requirement ID.");
          const { requirement_id: _requirementId, ...args } = call.arguments; call = { ...call, id: randomUUID(), arguments: args };
          const schema = JSON.parse(JSON.stringify(call.name === "finish" ? FINISH_TOOL.function.parameters : dispatcher.getTool(call.name)!.definition.function.parameters));
          const validation = new Validator().validate(args, schema);
          if (!validation.valid || "raw" in args) throw new Error(validation.errors.map(item => item.stack).join("; ") || "Malformed action arguments.");
          // Approve the complete executable command, including host-built Python checks.
          if (call.name === "run_command") {
            call.arguments = normalizeRunCommandArgs(args);
            if ("raw" in call.arguments) throw new Error("The command check arguments could not be normalized.");
          }
        } catch (error) {
          context.resultStore.registerResult({ type: "structured", status: "complete", origin: "model_derived", producer: { tool: "agent_rejected_response", callId: randomUUID() }, summary: "Rejected action format; no operation executed", payload: { response: response.value.content ?? "", toolCalls: response.value.tool_calls ?? [], reason: String(error) }, sources: [] });
          if (!takeAgentProtocolCorrection(runId)) return stop("malformed_action", String(error));
          updateAgentProgress(runId, state => { state.feedback = `Return one valid action. ${String(error).slice(0, 1000)}`; }); continue;
        }
        context.agentChangeReason = response.value.content?.slice(0, 1000) || selected.description;
        const repeated = hash([call.name, call.arguments, this.sourceVersion(context, call.arguments), progress?.latestResultId ? context.resultStore!.getResult(progress.latestResultId).storage.sha256 : null]);
        if (progress?.actions.some(item => item.hash === repeated)) return stop("repeated_action", "The same action was proposed without new source or evidence. Pending requirements remain saved.");
        context.resultStore!.registerResult({ type: "structured", status: "complete", origin: "model_derived", producer: { tool: "agent_proposal", callId: call.id }, summary: context.agentChangeReason, payload: { taskId: task.taskId, taskRevision: bound.taskRevision, requirementId: context.agentRequirementId, reason: context.agentChangeReason, operation: call.name, arguments: call.arguments }, sources: [] });
        updateAgentProgress(runId, state => { state.actions.push({ id: call.id, hash: repeated, requirementId: context.agentRequirementId!, operation: call.name, status: "proposed" }); });
        if (call.name === "finish") {
          const changed = getExecutionLedger(runId)?.completedOperations.filter(item => fileMutations.has(item.tool)).flatMap(item => getExecutionLedger(runId)!.operationAttempts.find(attempt => attempt.callId === item.callId)?.targetPath ?? []) ?? [];
          if (needsTests || changed.some(isCodeVerificationPath)) {
            const baseline = getExecutionLedger(runId)?.agentProgress?.baseline;
            if (baseline?.status === "stop" && baseline.environmentKey === environmentKey) return stop("checks_unavailable", baseline.detail);
            const checked = await runAgentVerificationStage({ context, dispatcher, changedPaths: progress?.fullSuite ? [] : changed, authorize });
            clearApprovals();
            if (checked.action === "repair") { updateAgentProgress(runId, state => { state.feedback = checked.detail.slice(0, 10000); }); continue; }
            if (!["passed", "skipped"].includes(checked.action)) return stop("checks_unavailable", checked.detail, checked.action === "cancelled" ? "cancelled" : "partial");
          }
          const complete = await reviewAgentTaskCoverage(task, context, modelId, changed, String(call.arguments.text));
          if (!complete.ok) { updateAgentProgress(runId, state => { state.feedback = complete.detail; if (complete.next === "delivery") state.deliveryEvidenceDigest = undefined; }); continue; }
          const completed = stop("requirements_satisfied", "", "completed");
          return { ...completed, text: `${String(call.arguments.text)}\n\n${completed.text}` };
        }
        if (fileMutations.has(call.name) && !pending.some(item => item.kind === "change")) return stop("read_only_task", "This task has no user requirement for file changes. No file was changed.");
        if (fileMutations.has(call.name)) {
          try { validateAgentFileProposal(call.name, call.arguments, context); }
          catch (error) { updateAgentProgress(runId, state => { state.actions.find(item => item.id === call.id)!.status = "failed"; state.feedback = String(error).slice(0, 1000); }); continue; }
        }
        if (mutations.has(call.name) && !await authorize([call])) return stop("approval_denied", "The proposed action was declined.", "cancelled");
        const [output] = await dispatcher.dispatchConcurrent([call], context);
        const uncertain = !output.result.ok && output.result.error.code === "persistence_failure" && mutations.has(call.name);
        updateAgentProgress(runId, state => {
          const action = state.actions.find(item => item.id === call.id)!; action.status = uncertain ? "uncertain" : output.result.ok ? "completed" : "failed"; action.resultId = output.result.resultRef?.resultId;
          if (action.resultId) state.latestResultId = action.resultId;
          state.feedback = `${output.result.summary}\n${output.result.ok ? "" : output.result.output}`.slice(0, 10000);
        });
        clearApprovals();
        if (uncertain) return stop("uncertain_mutation", "The operation ran but its evidence could not be saved. Reconcile current files before an explicit retry. Backups remain available.");
      }
    } catch (error) {
      if (scope.signal.aborted) return stop("cancelled", "Execution was cancelled. No uncertain action was replayed.", "cancelled");
      return stop("agent_execution_blocked", error instanceof Error ? error.message : String(error));
    } finally { context.policyGuard.revokeRunScopes(runId); }
  }

  private sourceVersion(context: ToolExecutionContext, args: Record<string, unknown>): string {
    if (typeof args.path !== "string") return "no-file-target";
    const file = resolveSafe(context.workspaceRoot, args.path);
    return existsSync(file) ? statSync(file).isFile() ? fileDigest(readAgentSourceBytes(context.workspaceRoot, args.path)) : "directory" : "new-file";
  }

}
