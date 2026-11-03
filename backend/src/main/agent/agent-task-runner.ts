import { agentAppliedChanges, savedAgentTaskFacts } from "./task-evidence.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { Validator } from "jsonschema";
import { z } from "zod";
import type { AgentTask, AgentToolCall, AgentToolDefinition, CapabilityGroup, RunContract } from "../../shared/contracts.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { getDb } from "../persistence/db.js";
import { bindAgentTaskRun, getAgentTask, getAgentTaskBinding, ingestAgentTaskMessage, setAgentTaskStatus } from "../run/agent-task-store.js";
import { advanceAgentEscalation, bindAgentExecutionLedger, configureExecutionLedger, getExecutionLedger, initializeAgentInterpretationBudget, initializeExecutionLedger, prepareAgentTaskInterpretation, takeAgentProtocolCorrection, updateAgentProgress } from "../run/execution-ledger.js";
import { getRunContract, persistRunContract } from "../run/contract.js";
import { currentRuntimeScope, assertRuntimeActive } from "../run/runtime-scope.js";
import { ToolDispatcher } from "./tool-dispatcher.js";
import { getAllAvailableTools, filterToolsForTurn } from "../router/tool-compositor.js";
import { agentWorkspaceActions, canonicalSourcePath, validateAgentFileProposal } from "./workspace-actions.js";
import { fileDigest, prepareFileEdit, readAgentSourceBytes } from "../harness/tools/edit-file.js";
import { resolveSafe } from "../harness/path-guard.js";
import { buildAgentContextPacket, conciseAgentTool, FINISH_TOOL, selectAgentRequirement } from "./context-packet.js";
import { AGENT_MODULE_DECISION_INSTRUCTIONS, bindAgentRepairProposal, MODULE_DRAFT_TOOL, moduleDecisionTools, REPAIR_PROPOSAL_TOOL } from "./repair-proposal.js";
import { REPLACE_SYMBOL_TOOL, bindSymbolEdit } from "./symbol-edit.js";
import { obtainAgentFailureSources, selectAgentFailureStep } from "./source-evidence.js";
import { assessAgentFileScope, refineAgentInterpretation, reviewAgentInterpretation } from "./requirement-scope.js";
import { agentInterpretationFormat, interpretationMessages, parseTaskInterpretation, isAgentStatusQuestion } from "./task-interpretation.js";
import { runAgentVerificationStage } from "./verification-stage.js";
import { captureAgentVerificationManifest, computeExpectedManifestRevision, isAgentTestPath, isCodeVerificationPath, type AgentTestOverlay } from "./test-verification.js";
import { extractVerificationSkipBasis, recordVerificationTermination, recordVerificationUserSkip } from "../run/verification-controller.js";
import { agentDeliveryGap, reviewAgentTaskCoverage } from "./requirement-review.js";
import { agentTestEnvironmentKey, captureCommandWorkspaceDigest, commandApprovalDigest, COMMAND_FALLBACK_DISCLOSURE } from "../harness/tools/run-command.js";
import { normalizeRunCommandArgs } from "../tools/workspace-tools.js";
import { agentDependencyConstraints } from "./dependency-constraint.js";
import { assessAgentArtifactScope, assertAgentArtifactScope } from "./artifact-scope.js";
import { bindTaskInputs } from "./task-inputs.js";
import { agentArtifactOutcomes } from "./artifact-evidence.js";
import { bindArtifactTests } from "./artifact-test-plan.js";
import { preservesPublicInterface } from "./export-preservation.js";
import type { InferenceRole } from "../gateway/telemetry.js";

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
      const ledger = getExecutionLedger(runId);
      let applied: string[] = [];
      try {applied=agentAppliedChanges(context).map(item=>`${item.summary}${item.originRunId === runId ? "" : " (earlier attempt)"}`);} catch {applied=ledger?.completedOperations.filter(item=>fileMutations.has(item.tool)).map(item=>item.summary) ?? [];}
      const checks = ledger?.verification?.evidence ?? [];
      return { outcome, stopReason: reason, text: `Changes applied: ${applied.join("; ") || "none"}\nChecks passed: ${checks.filter(item => item.status === "passed").map(item => item.reason).join("; ") || "none"}\nChecks unavailable: ${checks.filter(item => item.status === "unverified").map(item => item.reason).join("; ") || "none recorded"}\nRemaining requirements: ${outcome === "completed" ? "none" : detail}` };
    };
    const generationFailure = (reason: string, detail: string) => (getExecutionLedger(runId)?.agentTask?.modelCalls ?? 0) >= 40
      ? stop("model_call_limit",`The run used its 40 model calls. The full request and unresolved work remain saved. ${detail}`)
      : stop(reason,detail);
    try {
      let bound = getAgentTaskBinding(runId);
      const current = bound ? undefined : ingestAgentTaskMessage({runId,chatId:input.chatId,messageId:input.messageId,workspace:input.workspace,intent:input.intent,statusOnly:isAgentStatusQuestion(source.content)});
      if (current) prepareAgentTaskInterpretation(runId,current.taskId,current.snapshot.revision,input.messageId);
      scope.agentCountingProfiles = await context.gateway.prepareAgentCountingProfiles(modelId, { signal: scope.signal });
      if (!bound) {
        input.state("classifying"); scope.agentPhase = "requirements";
        let interpreted: ReturnType<typeof parseTaskInterpretation> | undefined;
        let feedback = "";
        for (;;) {
          const messages = interpretationMessages(source.content, current, input.messageId);
          if (feedback) messages[1].content = JSON.stringify({ ...JSON.parse(messages[1].content), correction: feedback });
          const response = await context.gateway.chatWithTools(modelId, messages, [], { runId, role: "interpretation", maxTokens: 1024, purpose: "classification", temperature: 0, responseSchema: agentInterpretationFormat(source.content,current,input.messageId), signal: scope.signal });
          assertRuntimeActive();
          if (!response.ok) return generationFailure("interpretation_unavailable", response.error.message);
          try {
            if (response.value.finishReason === "length" || response.value.tool_calls?.length) throw new Error("Requirement interpretation must be complete JSON data, with no workspace action.");
            interpreted = parseTaskInterpretation(response.value.content ?? "", input.messageId, source.content, current);
          } catch (error) {
            context.resultStore.registerResult({ type: "structured", status: "complete", origin: "model_derived", producer: { tool: "agent_rejected_interpretation", callId: randomUUID() }, summary: "Rejected requirement interpretation; no workspace action", payload: { response: response.value.content ?? "", reason: String(error) }, sources: [] });
            if (!takeAgentProtocolCorrection(runId)) {
              return stop("requirement_interpretation_failed", `The complete request is saved. Its requirements could not be validated: ${String(error)}`);
            }
            feedback = `Correct the JSON once. Keep every user obligation. ${String(error).slice(0, 1000)}`;
            continue;
          }
          if (!isAgentStatusQuestion(source.content)) {
            let reviewed: Awaited<ReturnType<typeof reviewAgentInterpretation>>;
            try { reviewed = await reviewAgentInterpretation(current!,interpreted,context,modelId,input.messageId); }
            catch (error) { assertRuntimeActive();return generationFailure("requirement_coverage_unverified",String(error)); }
            if (!reviewed.covered) {
              if (getExecutionLedger(runId)?.agentProgress?.scopeCorrectionUsed) return stop("requirement_coverage_unverified",reviewed.detail);
              updateAgentProgress(runId,progress=>{progress.scopeCorrectionUsed=true;});
              try {
                interpreted.fullSuite ||= reviewed.fullSuite;
                interpreted = await refineAgentInterpretation(current!,interpreted,input.messageId,source.content,reviewed.gaps,context,modelId);
                reviewed = await reviewAgentInterpretation(current!,interpreted,context,modelId,input.messageId);
              } catch (error) { assertRuntimeActive();return generationFailure("requirement_coverage_unverified",String(error)); }
              if (!reviewed.covered) return stop("requirement_coverage_unverified",reviewed.detail);
            }
            interpreted.fullSuite ||= reviewed.fullSuite;
          }
          break;
        }
        bound = bindAgentTaskRun({ runId, chatId: input.chatId, messageId: input.messageId, workspace: input.workspace, intent: "continue", disposition: interpreted.disposition, expectedRevision: current?.snapshot.revision, updates: interpreted.updates, predecessorRunId: input.predecessorRunId });
        bindAgentExecutionLedger(bound);
        updateAgentProgress(runId, progress => { progress.fullSuite ||= interpreted!.fullSuite; });
        if (!["evidence", "status"].includes(interpreted.disposition)) { const waiver = extractVerificationSkipBasis(source.content); if (waiver) recordVerificationUserSkip(runId, waiver); }
      }
      scope.agentPhase = "actions"; input.state("acting");
      const task = getAgentTask(bound.taskId)!;
      if (task.snapshot.revision !== bound.taskRevision || task.workspace.root !== input.workspace.root || task.workspace.registeredAt !== input.workspace.registeredAt) return stop("stale_task_binding", "The task or workspace binding changed. Start a fresh bound attempt.");
      if (bound.disposition === "status" || isAgentStatusQuestion(source.content)) {
        const answer = await context.gateway.chatWithTools(modelId, [{ role: "system", content: "Answer the status question from saved task facts only. Do not propose or perform workspace actions. State remaining requirements and unavailable checks." }, { role: "user", content: JSON.stringify({ question: source.content, requirements: task.snapshot.requirements, pendingRequests: task.snapshot.messages.filter(message=>message.disposition === "pending"), taskStatus: task.status, savedFacts:savedAgentTaskFacts(task) }) }], [], { runId, role: "status", maxTokens: 512, signal: scope.signal });
        assertRuntimeActive();
        return answer.ok && answer.value.finishReason !== "length" ? { outcome: "completed", text: answer.value.content ?? "The saved task remains available.", stopReason: "status_reply" } : stop("status_reply_unavailable", answer.ok ? "The status answer was truncated." : answer.error.message);
      }
      if (task.snapshot.messages.some(message => message.disposition === "pending")) return stop("requirements_pending", "An earlier request still needs requirement interpretation. Its complete text remains pending; it was not treated as logs or completed work.");
      if (!task.snapshot.requirements.some(item => item.state === "active")) return stop("requirements_missing", "The full message is saved, but no active requirement was extracted. Narrow or clarify this task.");
      bindTaskInputs(context);
      const replacements = new Map(agentWorkspaceActions.map(tool => [tool.name, tool]));
      const registered = [...getAllAvailableTools(modelId).map(tool => replacements.get(tool.name) ?? tool), replacements.get("edit_file")!, replacements.get("read_input")!];
      const dispatcher = new ToolDispatcher(registered);
      context.activeCapabilities = new Set(context.envelope.activeCapabilities);
      for (const capability of ["source_access", "workspace_mutation", "system_execution", "result_retrieval"] as const) context.activeCapabilities.add(capability);
      context.policyGuard.setEnforceExplicit(runId, true);
      context.agentDependencyConstraints = agentDependencyConstraints(task);
      context.agentPreservePublicInterface = preservesPublicInterface(task);
      const granted: string[] = [];
      const clearApprovals = () => { context.policyGuard!.revokeScopes(granted.splice(0)); context.agentOperationDigest = undefined; context.agentCommandApproval = undefined; context.agentArtifactScope = undefined; };
      const authorize = async (calls: AgentToolCall[], silent = false) => {
        for (const call of calls) {
          assertRuntimeActive();
          const commandApproval = call.name === "run_command" ? { workspaceDigest: captureCommandWorkspaceDigest(context.workspaceRoot), ...(context.agentVerification?.artifact ? {artifact:context.agentVerification.artifact} : {}) } : undefined;
          const previewData = { taskId: bound!.taskId, taskRevision: bound!.taskRevision, requirementId: context.agentRequirementId ?? null,
            constraints: task.snapshot.requirements.filter(item => item.state === "active" && item.kind === "preserve"),
            fileScope: context.agentFileScope ?? null, artifactScope: context.agentArtifactScope ?? null,
            operation: call.name, arguments: call.arguments, ...(commandApproval ? { sourceRevision: commandApproval.workspaceDigest, ...(commandApproval.artifact ? {testArtifact:commandApproval.artifact} : {}) } : {}) };
          const preview = JSON.stringify(previewData, null, 2) + (call.name === "run_command" ? `\n\n${COMMAND_FALLBACK_DISCLOSURE}` : "");
          const before = fileMutations.has(call.name) ? this.sourceVersion(context, call.arguments) : undefined;
          if (!silent && !await input.approve(preview)) return false;
          assertRuntimeActive();
          if (before !== undefined && before !== this.sourceVersion(context, call.arguments)) throw new Error("The proposed source changed while approval was pending. Read it again and request a new approval.");
          if (commandApproval && commandApproval.workspaceDigest !== captureCommandWorkspaceDigest(context.workspaceRoot)) throw new Error("The command workspace changed while approval was pending. Propose it again for the current source.");
          context.agentCommandApproval = commandApproval;
          context.agentOperationDigest = commandApproval ? commandApprovalDigest(String(call.arguments.command), commandApproval) : hash([call.name, call.arguments]);
          context.resultStore!.registerResult({ type: "structured", status: "complete", origin: "execution", producer: { tool: "agent_operation_approval", callId: call.id }, summary: "Approved concrete operation and source revision", payload: { ...previewData, operationDigest: context.agentOperationDigest }, sources: [] });
          const grantedScope = context.policyGuard!.grantScope({ runId, operation: call.name as "write_file", targetPath: typeof call.arguments.path === "string" ? canonicalSourcePath(context, call.arguments.path) : undefined,
            command: typeof call.arguments.command === "string" ? call.arguments.command : undefined, operationDigest: fileMutations.has(call.name) || commandApproval || call.name === "generate_deliverable" ? context.agentOperationDigest : undefined, allowUnisolated: call.name === "run_command" });
          granted.push(grantedScope.id);
        }
        return true;
      };
      const environmentKey = (reason?:string) => hash([agentTestEnvironmentKey(context.workspaceRoot),
        reason === "test_runtime_unavailable" ? null : captureAgentVerificationManifest(context.workspaceRoot).sha256,
        // An installed interpreter package can change outside PATH. A user-initiated
        // resume permits a fresh check; the same run will not retry automatically.
        reason === "test_dependency_unavailable" ? getExecutionLedger(runId)?.resumeCount ?? 0 : null]);
      const hasCodeProject = ["package.json", "pyproject.toml", "pytest.ini", "Cargo.toml", "pom.xml"].some(file => existsSync(resolveSafe(context.workspaceRoot, file)));
      const needsTests = task.snapshot.requirements.some(item => item.state === "active" && (item.kind === "execute" || item.acceptance.some(check => check.kind === "execution") || (item.kind === "change" && hasCodeProject)));
      const changedPaths = () => agentAppliedChanges(context).map(item=>item.path);
      const verifyChanges = async () => {
        const progress = getExecutionLedger(runId)?.agentProgress;
        if (progress?.baseline?.status === "stop" && progress.baseline.environmentKey === environmentKey(progress.baseline.reason)) return { action: "stop" as const, detail: progress.baseline.detail };
        const checked = await runAgentVerificationStage({ context, dispatcher, changedPaths: progress?.fullSuite ? [] : changedPaths(), authorize });
        clearApprovals();
        updateAgentProgress(runId, state => { state.feedback = checked.detail.slice(0, 10000); });
        if (checked.action === "repair") await obtainAgentFailureSources(context, dispatcher, checked.sourceHints);
        return checked;
      };
      const savedBaseline=getExecutionLedger(runId)?.agentProgress?.baseline;
      if (needsTests && (!savedBaseline || savedBaseline.status === "stop" && savedBaseline.environmentKey !== environmentKey(savedBaseline.reason))) {
        const baseline = await runAgentVerificationStage({ context, dispatcher, changedPaths: [], authorize, baseline: true });
        clearApprovals();
        updateAgentProgress(runId, progress => { progress.baseline = { status: baseline.action, detail: baseline.detail, environmentKey:environmentKey(baseline.reason),...(baseline.reason ? {reason:baseline.reason} : {}) }; progress.feedback = baseline.detail.slice(0, 10000); });
        if (baseline.action === "cancelled") return stop("approval_denied", baseline.detail, "cancelled");
        if (baseline.action === "repair") await obtainAgentFailureSources(context,dispatcher,baseline.sourceHints);
      }
      for (;;) {
        assertRuntimeActive();
        // A changed failure candidate advances to host verification. The model
        // does not need to select finish or rediscover an already known test call.
        const failureStep = selectAgentFailureStep(context);
        const beforeCheck = getExecutionLedger(runId)!;
        const currentManifest = captureAgentVerificationManifest(context.workspaceRoot).sha256;
        const failureChanged = beforeCheck.agentProgress?.failure && (
          failureStep?.phase === "check_changes" ||
          currentManifest !== beforeCheck.agentProgress.failure.revision ||
          beforeCheck.agentProgress.failure.targets.some(t => {
            try { return fileDigest(readAgentSourceBytes(context.workspaceRoot, t.path)) !== t.digest; } catch { return true; }
          })
        );
        if (failureChanged && beforeCheck.agentProgress?.failure?.targets.some(target => target.role === "implementation") && !beforeCheck.verification?.userSkip) {
          const checked = await verifyChanges();
          if (checked.action === "repair") continue;
          if (checked.action !== "passed") return stop("checks_unavailable", checked.detail, checked.action === "cancelled" ? "cancelled" : "partial");
        }
        if ((getExecutionLedger(runId)?.agentTask?.modelCalls ?? 0) >= 40) return stop("model_call_limit", "The run used its 40 model calls. Pending requirements remain saved.");
        const progress = getExecutionLedger(runId)?.agentProgress;
        const pending = task.snapshot.requirements.filter(item => item.state === "active");
        const selected = selectAgentRequirement(task, context);
        let packet = buildAgentContextPacket(task, context, selected);
        // Assess obtained evidence before asking the model to repeat an inspection step.
        // This changes the host phase, not requirement status or registered capabilities.
        const currentTests = getExecutionLedger(runId)?.verification?.evidence.find(check => check.criterionId === "acceptance:validate-written-code" && check.status === "passed");
        const repairDelivery = !!progress?.failure && changedPaths().length > 0 && !agentDeliveryGap(task, context, changedPaths()) && currentTests?.revision === captureAgentVerificationManifest(context.workspaceRoot).sha256 && currentTests.evidence.length > 0 && currentTests.evidence.every(ref => ref.kind === "result" && context.resultStore!.verifyIntegrity(ref.id).valid);
        const evidenceDigest = repairDelivery ? hash([currentTests!.revision, currentTests!.evidence]) : progress?.latestResultId ? context.resultStore.getResult(progress.latestResultId).storage.sha256 : undefined;
        const verbatimPageComplete = !pending.some(item => item.acceptance.some(check => check.operation === "verbatim_source")) || packet.observedSource?.endByte === packet.observedSource?.sizeBytes;
        const inspectionDelivery = verbatimPageComplete && packet.observedSource && evidenceDigest && progress?.deliveryEvidenceDigest !== evidenceDigest && pending.every(item => ["inspect", "deliver", "preserve"].includes(item.kind)) && !pending.some(item => item.acceptance.some(check => check.kind === "execution"));
        if (evidenceDigest && (inspectionDelivery || repairDelivery && progress?.deliveryEvidenceDigest !== evidenceDigest)) {
          updateAgentProgress(runId, state => { state.deliveryEvidenceDigest = evidenceDigest; });
          const answer = await context.gateway.chatWithTools(modelId, [{ role: "system", content: repairDelivery ? "The host has verified the saved repair with the listed existing tests. All appliedOperations are saved and acceptance:validate-written-code passed (baseline:project-tests records the initial pre-repair failure reproduction). Propose the requested explanation from the supplied requirements, changes, and evidence: explicitly name each inspected and tested file (both source and test files), state what was inspected, how the failing baseline tests were reproduced, the cause and applied fix in each modified module, and that the existing test suite passed while preserving the current design/public behavior and adding no dependencies. Do not request tools in this delivery step or list completed repairs/tests as unresolved. Keep any <think> block empty and immediately close </think> on the first line, then write ONLY the final user-facing explanation with no Analysis or Drafting sections." : "The host has obtained source evidence. Propose the requested answer from the supplied requirements and observed content. Do not request or perform more tools in this delivery step. For verbatim_source checks, output ONLY a fenced code block (```\\n<exact content>```) containing the exact observed source content with its exact whitespace and line endings and no extra blank lines inside the fence. Do not claim complete coverage beyond the supplied evidence. The host will review every requirement separately. Keep any <think> block empty and immediately close </think> on the first line, then write ONLY the final user-facing answer with no Analysis or Drafting sections." }, packet.messages[1]], [], { runId, role: "delivery", maxTokens: 1024, signal: scope.signal });
          assertRuntimeActive();
          if (!answer.ok || answer.value.finishReason === "length" || answer.value.tool_calls?.length || !answer.value.content?.trim()) return stop("delivery_unavailable", answer.ok ? "The delivery proposal was incomplete or requested another action." : answer.error.message);
          const answerDigest = hash(answer.value.content);
          if (progress?.deliveryAttempts.some(attempt => attempt.evidenceDigest === evidenceDigest && attempt.answerDigest === answerDigest)) return stop("repeated_delivery", "The same answer was proposed for unchanged source evidence. Remaining requirements stay saved.");
          updateAgentProgress(runId, state => { state.deliveryAttempts.push({ evidenceDigest, answerDigest }); });
          const admitted = getExecutionLedger(runId)?.agentAdmissions.at(-1);
          if (admitted?.status === "usage_verified") updateAgentProgress(runId, state => { state.reads.push(...packet.observedSources.map(source=>({...source,requestId:admitted.requestId}))); });
          context.resultStore.registerResult({ type: "text", status: "complete", origin: "model_derived", producer: { tool: "agent_delivery_proposal", callId: randomUUID() }, summary: "Proposed answer from observed evidence", payload: answer.value.content, sources: [] });
          const reviewed = await reviewAgentTaskCoverage(task, context, modelId, repairDelivery ? changedPaths() : [], answer.value.content);
          assertRuntimeActive();
          if (reviewed.ok) { const completed = stop("requirements_satisfied", "", "completed"); return { ...completed, text: `${answer.value.content}\n\n${completed.text}` }; }
          updateAgentProgress(runId, state => { state.feedback = reviewed.detail; if (reviewed.next === "delivery") state.deliveryEvidenceDigest = undefined; });
          continue;
        }
        const inactiveCapabilities = context.envelope.permittedCapabilities.filter(capability=>!context.activeCapabilities!.has(capability));
        const visible = filterToolsForTurn(registered, context.envelope, context.activeCapabilities!, { hasRetrievableResults: true }).filter(tool=>(tool.name !== "request_capability" || inactiveCapabilities.length > 0) && (tool.name !== "read_input" || Boolean(context.inputSources?.length)));
        const definitions = (): AgentToolDefinition[] => visible.map(tool => conciseAgentTool({ ...tool.definition, function: { ...tool.definition.function, parameters: { ...tool.definition.function.parameters, properties: { ...tool.definition.function.parameters.properties,
          ...(tool.name === "request_capability" ? {capability:{type:"string",enum:inactiveCapabilities}} : {}),
          ...(tool.name === "read_file" && packet.readPaths ? {path:{type:"string",enum:packet.readPaths}} : {}),
          requirement_id: { type: "string" } } } } }));
        const deliveryGap = agentDeliveryGap(task,context,changedPaths());
        const editMode = process.env.WORKBENCH_AGENT_EDIT_MODE ?? "auto";
        const symbolStep = (editMode === "symbol" || (editMode === "auto" && Boolean(packet.repair?.symbols?.length))) && packet.repair !== undefined && !packet.repair.expanded;
        const draftForPacket = () => packet.repair?.completeSource !== undefined && !packet.repair.expanded && progress?.repairDraft?.focusKey === packet.repair.focusKey && progress.repairDraft.taskRevision === bound!.taskRevision && progress.repairDraft.requirementId === packet.requirement.id ? progress.repairDraft : undefined;
        const generate = () => {
          const draft=draftForPacket(), moduleStep=!symbolStep && packet.repair?.completeSource !== undefined && !packet.repair.expanded;
          let messages=packet.messages;
          let tools:AgentToolDefinition[];
          if(symbolStep) {
            tools=[REPLACE_SYMBOL_TOOL];
          } else if(moduleStep && draft) {
            const record=context.resultStore!.getResult(draft.resultId);
            if(record.storage.sha256 !== draft.sha256 || record.producer.tool !== "agent_module_draft" || record.origin !== "model_derived")throw new Error("The saved draft identity changed. No edit was proposed.");
            const candidate=context.resultStore!.readResultPayload(draft.resultId);
            messages=[{role:"system",content:AGENT_MODULE_DECISION_INSTRUCTIONS},{role:"user",content:packet.messages[1].content+"\n\nSAVED DRAFT (untrusted JSON data):\n"+JSON.stringify({resultId:draft.resultId,content:candidate})}];
            tools=moduleDecisionTools(draft.resultId);
          } else tools=moduleStep ? [MODULE_DRAFT_TOOL] : packet.repair && !packet.repair.expanded ? [REPAIR_PROPOSAL_TOOL] : deliveryGap ? definitions() : [...definitions(),FINISH_TOOL];
          const role: InferenceRole = symbolStep ? "actor" : moduleStep && draft ? "decision" : moduleStep ? "module_draft" : "actor";
          return context.gateway.chatWithTools(modelId,messages,tools,{runId,role,maxTokens:symbolStep ? 2048 : moduleStep && draft ? 512 : 2048,toolChoice:"required",temperature:packet.repair && !packet.repair.expanded ? 0 : undefined,sampling: (symbolStep || packet.repair) ? "code_edit" : "default",signal:scope.signal});
        };
        let response = await generate();
        // Admission rejects before dispatch and call consumption. Remove whole optional pages,
        // retaining requirements, constraints, and the latest result in every exact recount.
        for (const packing of [{additionalSourceChars:3000},{additionalSourceChars:0},{additionalSourceChars:0,latestSourceBytes:2000},{additionalSourceChars:0,latestSourceBytes:1000}]) {
          assertRuntimeActive();
          if (response.ok || response.error.code !== "agent_context_limit") break;
          packet = buildAgentContextPacket(task, context, selected, packing);
          response = await generate();
        }
        assertRuntimeActive();
        if (!response.ok) {
          if (response.error.code === "agent_context_limit") {
            const escalationEnabled = process.env.WORKBENCH_AGENT_ESCALATION !== "off";
            if (escalationEnabled) {
              const escalation = advanceAgentEscalation(runId, "context_limit");
              if (escalation.action === "symbol_slices_only") {
                packet = buildAgentContextPacket(task, context, selected, { additionalSourceChars: 0, latestSourceBytes: 500 });
                response = await generate();
                if (!response.ok) {
                  return stop("context_limit", `The required task state and minimum evidence still do not fit. Narrow the task or split its remaining work. ${response.error.message}`);
                }
              } else {
                return stop("context_limit", `The required task state and minimum evidence still do not fit. Narrow the task or split its remaining work. ${response.error.message}`);
              }
            } else {
              return stop("context_limit", `The required task state and minimum evidence still do not fit. Narrow the task or split its remaining work. ${response.error.message}`);
            }
          } else {
            return stop("model_generation_unavailable", response.error.message);
          }
        }
        const admission = getExecutionLedger(runId)?.agentAdmissions.at(-1);
        if (admission?.status === "usage_verified") updateAgentProgress(runId, state => { state.reads.push(...packet.observedSources.map(source=>({...source,requestId:admission.requestId}))); });
        let call: AgentToolCall, selectedDraftId:string|undefined;
        try {
          if (response.value.finishReason === "length") throw new Error("The action was truncated. Return a complete smaller action.");
          const calls = response.value.tool_calls ?? [];
          if (!calls.length && response.value.content) {
            try {
              let text = response.value.content.trim();
              if (text.includes("</think>")) {
                text = text.slice(text.indexOf("</think>") + 8).trim();
              }
              text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
              if (text.startsWith("{") && text.endsWith("}")) {
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === "object") {
                  if (Array.isArray(parsed.edits)) {
                    calls.push({ id: randomUUID(), name: "replace_symbol", arguments: parsed });
                  } else if (typeof parsed.name === "string" && (parsed.name === "replace_symbol" || tools.some(t => t.function.name === parsed.name))) {
                    calls.push({ id: randomUUID(), name: parsed.name, arguments: parsed.arguments ?? parsed });
                  } else if (tools.length === 1) {
                    calls.push({ id: randomUUID(), name: tools[0].function.name, arguments: parsed.arguments ?? parsed });
                  } else if (typeof parsed.content === "string") {
                    calls.push({ id: randomUUID(), name: "draft_module", arguments: parsed });
                  }
                }
              }
            } catch {}
          }
          if (calls.length > 1) throw new Error("Return exactly one action per turn.");
          if (!calls.length && /^\s*```(?:json)?\s*\{[\s\S]*"tool_calls"\s*:/i.test(response.value.content ?? "")) throw new Error('A Markdown example is text and cannot execute. Return one bare JSON object: {"tool_calls":[{"name":"available tool","arguments":{}}],"content":""}. No fences or prose.');
          call = calls[0] ?? { id: randomUUID(), name: "finish", arguments: { text: response.value.content ?? "" } };
          if((call.name === "replace_symbol" || Array.isArray((call.arguments as any)?.edits)) && packet.repair && !packet.repair.expanded) {
            if (call.name !== "replace_symbol") call = { ...call, name: "replace_symbol" };
            const currentBytes = readAgentSourceBytes(context.workspaceRoot, packet.repair.path);
            const proposal = await bindSymbolEdit(call, packet.repair, currentBytes);
            if("blocked" in proposal) {
              context.resultStore.registerResult({type:"structured",status:"complete",origin:"model_derived",producer:{tool:"agent_repair_blocker",callId:randomUUID()},summary:"Repair proposal reported a blocker; no operation executed",payload:{taskId:task.taskId,taskRevision:bound!.taskRevision,source:packet.repair,reason:proposal.blocked},sources:[]});
              return stop("repair_blocked", proposal.blocked);
            }
            if("contextNeeded" in proposal) {
              updateAgentProgress(runId, state => { state.feedback = proposal.contextNeeded; });
              continue;
            }
            call = proposal.call;
          } else if(packet.repair?.completeSource !== undefined && !packet.repair.expanded) {
            const draft=draftForPacket();
            if(!draft) {
              if(call.name !== "draft_module" || !calls.length)throw new Error("Return one complete module draft as data.");
              const candidate=z.object({content:z.string().min(1).max(16384)}).strict().parse(call.arguments).content;
              if(/^\s*```/.test(candidate))throw new Error("Return module source without a Markdown fence. No example was converted into an edit.");
              const record=context.resultStore.registerResult({type:"text",status:"complete",origin:"model_derived",producer:{tool:"agent_module_draft",callId:randomUUID()},summary:"Untrusted source draft; no workspace mutation",payload:candidate,sources:[]});
              updateAgentProgress(runId,state=>{state.repairDraft={focusKey:packet.repair!.focusKey,resultId:record.resultId,sha256:record.storage.sha256,requirementId:packet.requirement.id,taskRevision:bound!.taskRevision};
                state.actions.push({id:randomUUID(),hash:hash(["draft_module",packet.repair!.focusKey,record.storage.sha256]),requirementId:packet.requirement.id,operation:"draft_module",status:"completed",resultId:record.resultId});});
              continue;
            }
            const tools=moduleDecisionTools(draft.resultId),definition=tools.find(tool=>tool.function.name === call.name);
            if(!definition || !calls.length || !new Validator().validate(call.arguments,JSON.parse(JSON.stringify(definition.function.parameters))).valid)throw new Error("Select the saved draft, request context, or report a blocker.");
            if(call.name === "select_module_draft") {selectedDraftId=draft.resultId;call={...call,name:"propose_module_repair",arguments:{content:context.resultStore.readResultPayload(draft.resultId),requirement_id:draft.requirementId}};}
            else if(call.name === "request_module_context")call={...call,name:"propose_module_repair",arguments:{content:null,context_needed:call.arguments.reason,requirement_id:draft.requirementId}};
            else call={...call,name:"propose_module_repair",arguments:{content:null,blocked_reason:call.arguments.reason,requirement_id:draft.requirementId}};
          }
          const requirementId = call.arguments.requirement_id;
          context.agentRequirementId = typeof requirementId === "string" ? requirementId : packet.requirement.id;
          if (!pending.some(item => item.id === context.agentRequirementId)) throw new Error("Select an active requirement ID.");
          if(packet.repair && !packet.repair.expanded && calls.length && call.name !== "edit_file") {
            const proposal=bindAgentRepairProposal(call,packet.repair);
            if("blocked" in proposal) {
              context.resultStore.registerResult({type:"structured",status:"complete",origin:"model_derived",producer:{tool:"agent_repair_blocker",callId:randomUUID()},summary:"Repair proposal reported a blocker; no operation executed",payload:{taskId:task.taskId,taskRevision:bound.taskRevision,source:packet.repair,reason:proposal.blocked},sources:[]});
              return stop("repair_blocked",proposal.blocked);
            }
            if("contextNeeded" in proposal) {
              const records=context.resultStore.listResults({limit:50});
              for(let offset=50;records.length === offset;offset+=50)records.push(...context.resultStore.listResults({limit:50,offset}));
              const reads=getExecutionLedger(runId)?.agentProgress?.reads ?? [];
              const observed=[...new Set(reads.map(read=>JSON.stringify([read.path,read.digest,read.startByte,read.endByte])))].sort();
              // Approval receipts authorize operations; they are not observations
              // of the project and cannot make a repeated request productive.
              const evidence=[...new Set(records.filter(record=>record.origin === "execution" && record.producer.tool !== "agent_operation_approval" || record.origin === "source_extracted" && record.producer.tool !== "read_file").map(record=>record.storage.sha256))].sort();
              const key=hash([packet.repair.focusKey,observed,evidence]);
              if (progress?.actions.some(action => action.operation === "request_context" && action.hash === key)) {
                const escalationEnabled = process.env.WORKBENCH_AGENT_ESCALATION !== "off";
                if (escalationEnabled) {
                  const escalation = advanceAgentEscalation(runId, "repeated_context_request");
                  if (escalation.action === "supply_neighbor_symbols") {
                    updateAgentProgress(runId, state => {
                      state.expandedToolFocus = undefined;
                      state.feedback = "Context request was repeated. Observed file source and neighbor symbols are provided in your packet.";
                    });
                    continue;
                  }
                }
                return stop("repeated_context_request", "The same module requested more context without new source or execution evidence.");
              }
              const id=randomUUID(),record=context.resultStore.registerResult({type:"structured",status:"complete",origin:"model_derived",producer:{tool:"agent_repair_context_request",callId:id},summary:"Module draft requests context; no operation executed",payload:{taskId:task.taskId,taskRevision:bound.taskRevision,requirementId:context.agentRequirementId,path:packet.repair.path,reason:proposal.contextNeeded},sources:[]});
              updateAgentProgress(runId,state=>{state.actions.push({id,hash:key,requirementId:context.agentRequirementId!,operation:"request_context",status:"completed",resultId:record.resultId});state.expandedToolFocus=packet.repair!.focusKey;state.feedback=proposal.contextNeeded;});
              continue;
            }
            call=proposal.call;
          }
          if (call.name !== "finish" && !dispatcher.getTool(call.name)) throw new Error("The proposed tool is not registered.");
          const { requirement_id: _requirementId, ...args } = call.arguments; call = { ...call, id: randomUUID(), arguments: args };
          const schema = JSON.parse(JSON.stringify(call.name === "finish" ? FINISH_TOOL.function.parameters : dispatcher.getTool(call.name)!.definition.function.parameters));
          const validation = new Validator().validate(args, schema);
          if (!validation.valid || "raw" in args) throw new Error(validation.errors.map(item => item.stack).join("; ") || "Malformed action arguments.");
          if (call.name === "request_capability" && context.activeCapabilities!.has(args.capability as CapabilityGroup) && !(packet.repair && !packet.repair.expanded)) throw new Error("This capability is already active. Select one of its available tools instead of activating it again.");
          // Approve the complete executable command, including host-built Python checks.
          if (call.name === "run_command") {
            call.arguments = normalizeRunCommandArgs(args);
            if ("raw" in call.arguments) throw new Error("The command check arguments could not be normalized.");
          }
        } catch (error) {
          context.resultStore.registerResult({ type: "structured", status: "complete", origin: "model_derived", producer: { tool: "agent_rejected_response", callId: randomUUID() }, summary: "Rejected action format; no operation executed", payload: { response: response.value.content ?? "", toolCalls: response.value.tool_calls ?? [], reason: String(error) }, sources: [] });
          const escalationEnabled = process.env.WORKBENCH_AGENT_ESCALATION !== "off";
          if (escalationEnabled) {
            const escalation = advanceAgentEscalation(runId, "malformed_action");
            if (escalation.action === "correction" && takeAgentProtocolCorrection(runId)) {
              updateAgentProgress(runId, state => { state.feedback = `Return one valid action. ${String(error).slice(0, 1000)}`; });
              continue;
            }
            if (escalation.action === "constrained_transport") {
              updateAgentProgress(runId, state => { state.feedback = `Return one bare JSON action object matching the tool parameters schema. ${String(error).slice(0, 1000)}`; });
              continue;
            }
          } else {
            if (!takeAgentProtocolCorrection(runId)) return stop("malformed_action", String(error));
            updateAgentProgress(runId, state => { state.feedback = `Return one valid action. ${String(error).slice(0, 1000)}`; });
            continue;
          }
          return stop("malformed_action", String(error));
        }
        context.agentChangeReason = response.value.content?.slice(0, 1000) || selected.description;
        // A command result contains fresh timing and result IDs even when the
        // same command ran against identical inputs. Those receipt details are
        // not new project evidence and must not permit an endless retry loop.
        const repeated = call.name === "run_command"
          ? hash([call.name,call.arguments,captureCommandWorkspaceDigest(context.workspaceRoot),agentTestEnvironmentKey(context.workspaceRoot)])
          : hash([call.name, call.arguments, this.sourceVersion(context, call.arguments), progress?.latestResultId ? context.resultStore!.getResult(progress.latestResultId).storage.sha256 : null]);
        if (progress?.actions.some(item => item.hash === repeated)) {
          const escalationEnabled = process.env.WORKBENCH_AGENT_ESCALATION !== "off";
          if (escalationEnabled && call.name !== "finish") {
            const escalation = advanceAgentEscalation(runId, "repeated_action");
            if (escalation.action === "expand_context") {
              updateAgentProgress(runId, state => {
                state.feedback = "The proposed action was already attempted without effect. Review surrounding context before proposing another change.";
                state.expandedToolFocus = packet.repair?.focusKey;
              });
              continue;
            }
            if (escalation.action === "switch_edit_mode") {
              updateAgentProgress(runId, state => {
                state.feedback = "Repeated action detected. Switch to a broader edit strategy or different replacement range.";
                state.expandedToolFocus = packet.repair?.focusKey;
              });
              continue;
            }
            if (escalation.action === "resample_t0.5") {
              updateAgentProgress(runId, state => {
                state.feedback = "Repeated action detected. Retrying with alternate variation.";
              });
              continue;
            }
          }
          return stop("repeated_action", "The same action was proposed without new source or evidence. Pending requirements remain saved.");
        }
        context.resultStore!.registerResult({ type: "structured", status: "complete", origin: "model_derived", producer: { tool: "agent_proposal", callId: call.id }, summary: context.agentChangeReason, payload: { taskId: task.taskId, taskRevision: bound.taskRevision, requirementId: context.agentRequirementId, reason: context.agentChangeReason, operation: call.name, arguments: call.arguments, ...(selectedDraftId ? {draftResultId:selectedDraftId} : {}) }, sources: selectedDraftId ? [{resultId:selectedDraftId,relation:"source"}] : [] });
        updateAgentProgress(runId, state => { state.actions.push({ id: call.id, hash: repeated, requirementId: context.agentRequirementId!, operation: call.name, status: "proposed" }); });
        if (call.name === "finish") {
          const changed = changedPaths(), gap = agentDeliveryGap(task,context,changed);
          if (gap) {updateAgentProgress(runId,state=>{state.feedback=gap;});continue;}
          const exports=agentArtifactOutcomes(context).flatMap(artifact=>{
            const requirement=task.snapshot.requirements.find(item=>item.state === "active" && item.kind === "change" && item.id === artifact.requirementId);
            return requirement && isCodeVerificationPath(artifact.filename) ? [{artifact,requirement}] : [];
          });
          if (exports.length && (exports.length > 1 || changed.some(isCodeVerificationPath)) && task.snapshot.requirements.some(item=>item.state === "active" && (item.kind === "execute" || item.acceptance.some(check=>check.kind === "execution")))) return stop("checks_unavailable","The combined exported and applied code needs tests in one shared test copy. Separate test results do not establish the combined behavior.");
          if (changed.some(isCodeVerificationPath) || needsTests && !exports.length) {
            const checked = await verifyChanges();
            if (checked.action === "repair") continue;
            if (!["passed", "skipped"].includes(checked.action)) return stop("checks_unavailable", checked.detail, checked.action === "cancelled" ? "cancelled" : "partial");
          }
          if (!getExecutionLedger(runId)?.verification?.userSkip) for (const item of exports) {
            let binding:ReturnType<typeof bindArtifactTests>;
            const fullSuite=Boolean(getExecutionLedger(runId)?.agentProgress?.fullSuite);
            try { binding=bindArtifactTests(context,item.requirement,item.artifact,fullSuite); }
            catch(error) { return stop("checks_unavailable",`Exported repair tests are unavailable: ${String(error)}`); }
            const checked=await runAgentVerificationStage({context,dispatcher,changedPaths:fullSuite ? [] : [binding.targetPath],artifact:binding,authorize});
            clearApprovals();
            updateAgentProgress(runId,state=>{state.feedback=checked.detail.slice(0,10000);});
            if (checked.action === "repair") { await obtainAgentFailureSources(context,dispatcher,checked.sourceHints); break; }
            if (checked.action !== "passed") return stop("checks_unavailable",checked.detail,checked.action === "cancelled" ? "cancelled" : "partial");
          }
          if (exports.some(item=>{
            if(getExecutionLedger(runId)?.verification?.userSkip)return false;
            try { const binding=bindArtifactTests(context,item.requirement,item.artifact,Boolean(getExecutionLedger(runId)?.agentProgress?.fullSuite));
              return !getExecutionLedger(runId)?.verification?.evidence.some(check=>check.criterionId===binding.criterionId && check.status==="passed" && check.revision===binding.revision);
            } catch { return true; }
          })) continue;
          const complete = await reviewAgentTaskCoverage(task, context, modelId, changed, String(call.arguments.text));
          assertRuntimeActive();
          if (!complete.ok) { updateAgentProgress(runId, state => { state.feedback = complete.detail; if (complete.next === "delivery") state.deliveryEvidenceDigest = undefined; }); continue; }
          const completed = stop("requirements_satisfied", "", "completed");
          return { ...completed, text: `${String(call.arguments.text)}\n\n${completed.text}` };
        }
        context.agentFileScope = undefined;
        if (call.name === "generate_deliverable") {
          try { context.agentArtifactScope = await assessAgentArtifactScope(task, context.agentRequirementId!, context, modelId); assertAgentArtifactScope(context.agentArtifactScope, call.arguments, context); }
          catch (error) { assertRuntimeActive(); return stop("artifact_scope_unverified", `No artifact was approved or created. ${String(error)}`); }
        }
        if (fileMutations.has(call.name) || call.name === "run_command") {
          try { if (fileMutations.has(call.name)) validateAgentFileProposal(call.name, call.arguments, context); }
          catch (error) { updateAgentProgress(runId, state => { state.actions.find(item => item.id === call.id)!.status = "failed"; if (selectedDraftId && state.repairDraft?.resultId === selectedDraftId) delete state.repairDraft; state.feedback = String(error).slice(0, 1000); }); continue; }
          const assessed = await assessAgentFileScope(task,context.agentRequirementId!,call,context,modelId);
          if (!assessed.verified || !assessed.withinScope) {
            updateAgentProgress(runId,state=>{state.actions.find(item=>item.id === call.id)!.status="failed";});
            return assessed.verified ? stop("action_outside_task",assessed.reason) : generationFailure("action_scope_unverified",assessed.reason);
          }
          // Scope assessment can await inference. Recheck before showing a concrete preview.
          try { if (fileMutations.has(call.name)) validateAgentFileProposal(call.name,call.arguments,context); }
          catch (error) { updateAgentProgress(runId,state=>{state.actions.find(item=>item.id === call.id)!.status="failed"; if (selectedDraftId && state.repairDraft?.resultId === selectedDraftId) delete state.repairDraft; state.feedback=String(error).slice(0,1000);});continue; }
        }
        // Shadow Verification & Best-of-N (Phase 2):
        // Before requesting user approval for an edit, verify the candidate in an isolated temp copy
        const shadowVerifyEnabled = (process.env.WORKBENCH_AGENT_SHADOW_VERIFY ?? "on") !== "off";
        const editArgs = call.arguments as any;
        if (shadowVerifyEnabled && call.name === "edit_file" && editArgs?.path && editArgs?.expected_digest && editArgs?.replacements) {
          try {
            const canonical = canonicalSourcePath(context, editArgs.path);
            if (!isAgentTestPath(canonical) && isCodeVerificationPath(canonical)) {
              const reads = getExecutionLedger(runId)?.agentProgress?.reads ?? [];
              const prepared = prepareFileEdit(context.workspaceRoot, {
                path: canonical,
                expectedDigest: editArgs.expected_digest,
                replacements: editArgs.replacements,
                requirementId: context.agentRequirementId ?? "",
                reason: context.agentChangeReason ?? ""
              }, reads);

              const overlay: AgentTestOverlay = {
                path: canonical,
                sourceDigest: editArgs.expected_digest,
                bytes: prepared.after,
                digest: prepared.afterDigest
              };

              const manifest = captureAgentVerificationManifest(context.workspaceRoot);
              const expectedRevision = computeExpectedManifestRevision(manifest.files, [overlay]);

              const shadow = await runAgentVerificationStage({
                context,
                dispatcher,
                changedPaths: [canonical],
                overlay: [overlay],
                expectedRevision,
                shadow: true,
                authorize: (calls) => authorize(calls, true)
              });

              if (shadow.action === "repair") {
                // Best-of-N retry on shadow failure:
                let passedCandidate: typeof call | undefined;
                const samples = [{ temperature: 0.4 }, { temperature: 0.7 }];
                const seenDigests = new Set<string>([overlay.digest]);

                if (packet.repair && !packet.repair.expanded) {
                  for (const s of samples) {
                    assertRuntimeActive();
                    if (scope.signal.aborted) break;
                    const altPacket = buildAgentContextPacket(task, context, selected);
                    const altResponse = await context.gateway.chatWithTools(
                      modelId,
                      altPacket.messages,
                      [REPLACE_SYMBOL_TOOL],
                      {
                        runId,
                        role: "actor",
                        maxTokens: 2048,
                        toolChoice: "required",
                        temperature: s.temperature,
                        signal: scope.signal
                      }
                    );
                    const altCalls = altResponse.ok ? [...(altResponse.value.tool_calls ?? [])] : [];
                    if (!altCalls.length && altResponse.ok && altResponse.value.content) {
                      try {
                        let text = altResponse.value.content.trim();
                        if (text.includes("</think>")) text = text.slice(text.indexOf("</think>") + 8).trim();
                        text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
                        if (text.startsWith("{") && text.endsWith("}")) {
                          const parsed = JSON.parse(text);
                          if (Array.isArray(parsed?.edits)) {
                            altCalls.push({ id: randomUUID(), name: "replace_symbol", arguments: parsed });
                          }
                        }
                      } catch {}
                    }
                    if (!altCalls.length) continue;
                    const altCall = altCalls[0];
                    if (altCall.name !== "replace_symbol") continue;
                    try {
                      const altBytes = readAgentSourceBytes(context.workspaceRoot, canonical);
                      const altBound = await bindSymbolEdit(altCall, packet.repair, altBytes);
                      if (!("call" in altBound)) continue;
                      const altEditArgs = altBound.call.arguments as any;
                      const altPrepared = prepareFileEdit(context.workspaceRoot, {
                        path: canonical,
                        expectedDigest: altEditArgs.expected_digest,
                        replacements: altEditArgs.replacements,
                        requirementId: context.agentRequirementId ?? "",
                        reason: "Best-of-N repair sample"
                      }, reads);
                      if (seenDigests.has(altPrepared.afterDigest)) continue;
                      seenDigests.add(altPrepared.afterDigest);
                      const altOverlay: AgentTestOverlay = {
                        path: canonical,
                        sourceDigest: altEditArgs.expected_digest,
                        bytes: altPrepared.after,
                        digest: altPrepared.afterDigest
                      };
                      const altExpectedRevision = computeExpectedManifestRevision(manifest.files, [altOverlay]);
                      const altShadow = await runAgentVerificationStage({
                        context,
                        dispatcher,
                        changedPaths: [canonical],
                        overlay: [altOverlay],
                        expectedRevision: altExpectedRevision,
                        shadow: true,
                        authorize: (calls) => authorize(calls, true)
                      });
                      if (altShadow.action === "passed" || altShadow.action === "skipped") {
                        passedCandidate = { ...altBound.call, id: randomUUID() };
                        break;
                      }
                    } catch {
                      // Continue to next sample
                    }
                  }
                }

                if (passedCandidate) {
                  call = passedCandidate;
                } else {
                  // None passed shadow verification; feed back failure and continue turn
                  updateAgentProgress(runId, state => {
                    state.actions.find(item => item.id === call.id)!.status = "failed";
                    if (selectedDraftId && state.repairDraft?.resultId === selectedDraftId) delete state.repairDraft;
                    state.feedback = `Shadow test verification failed in isolated copy:\n${shadow.detail.slice(0, 5000)}`;
                  });
                  continue;
                }
              }

              if (shadow.action !== "passed" && shadow.action !== "skipped") {
                return stop("checks_unavailable", shadow.detail, shadow.action === "cancelled" ? "cancelled" : "partial");
              }
            }
          } catch {
            // Fall back to normal path if shadow preparation fails
          }
        }
        if (mutations.has(call.name) && !await authorize([call])) return stop("approval_denied", "The proposed action was declined.", "cancelled");
        const [output] = await dispatcher.dispatchConcurrent([call], context);
        const uncertain = !output.result.ok && output.result.error.code === "persistence_failure" && mutations.has(call.name);
        updateAgentProgress(runId, state => {
          const action = state.actions.find(item => item.id === call.id)!; action.status = uncertain ? "uncertain" : output.result.ok ? "completed" : "failed"; action.resultId = output.result.resultRef?.resultId;
          if (action.resultId) state.latestResultId = action.resultId;
          if(output.result.ok && call.name === "request_capability" && packet.repair && !packet.repair.expanded)state.expandedToolFocus=packet.repair.focusKey;
          else if(packet.repair?.expanded)delete state.expandedToolFocus;
          if(output.result.ok && packet.repair?.expanded && call.name !== "request_capability")delete state.repairDraft;
          state.feedback = `${output.result.summary}${output.result.ok && call.name === "generate_deliverable" ? ". Deliverable is saved; if all requested operations are complete, call finish with your final response." : ""}\n${output.result.ok ? "" : output.result.output}`.slice(0, 10000);
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
