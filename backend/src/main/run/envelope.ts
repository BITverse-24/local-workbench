import type {
  AttachmentReference,
  CapabilityGroup,
  ExecutionEnvelope,
  ExecutionMode,
  ModelId,
  OutputMode,
} from "../../shared/contracts.js";

export interface BuildEnvelopeParams {
  runId: string;
  mode?: ExecutionMode;
  modelId: ModelId;
  hasWorkspace: boolean;
  workspaceRoot?: string;
  attachments?: AttachmentReference[];
  hasKnowledgeBaseDocs?: boolean;
  hasRetrievableResults?: boolean;
  outputPreference?: OutputMode;
  userPrompt?: string;
  contextLimit?: number;
  authorizationState?: {
    planConfirmed: boolean;
    authorizedOperations: string[];
  };
  mutationRequested?: boolean;
  commandExecutionRequested?: boolean;
  deliverableRequested?: boolean;
  /** Python source repairs export through execute_python, not the document generator. */
  pythonSourceRepair?: boolean;
}

const CHAT_PERMITTED_CAPABILITIES: readonly CapabilityGroup[] = [
  "source_access",
  "document_processing",
  "result_retrieval",
  "structured_computation",
  "artifact_generation",
];

const AGENT_PERMITTED_CAPABILITIES: readonly CapabilityGroup[] = [
  "source_access",
  "document_processing",
  "result_retrieval",
  "structured_computation",
  "artifact_generation",
  "workspace_mutation",
  "system_execution",
];

export function buildExecutionEnvelope(params: BuildEnvelopeParams): ExecutionEnvelope {
  const attachments = params.attachments ?? [];
  const text = params.userPrompt ?? "";

  const mutationExplicit = Boolean(
    params.mutationRequested ||
    (params.hasWorkspace &&
      /\b(?:modify|edit|update|fix|repair|patch|refactor|change|write|delete|remove|create\s+file|save\s+to|replace)\b/i.test(text)) ||
    /\b(?:write|modify|edit|update|patch|fix|delete|remove|create)\s+(?:to\s+|in\s+)?(?:file|[a-z0-9_.-]+\.[a-z0-9]+)\b/i.test(text),
  );

  const commandExplicit = Boolean(
    params.commandExecutionRequested ||
    (params.hasWorkspace &&
      /\b(?:run|execute|test|npm|pip|build|bash|sh|pytest|vitest|compile|cargo|validat(?:e|ion)|make\s+sure|verify|verification)\b/i.test(text)),
  );

  const mode: ExecutionMode =
    params.mode !== undefined
      ? params.mode
      : (mutationExplicit || commandExplicit ? "agent" : "chat");

  const hasVisualAttachments = attachments.some((a) =>
    /\.(?:pdf|svg|png|jpe?g|bmp|tiff?)$/i.test(a.filename),
  );

  const hasDocumentAttachments = attachments.some((a) =>
    /\.(?:pdf|docx?|xlsx?|csv|svg|png|jpe?g|txt|md|json)$/i.test(a.filename),
  );

  const permittedCapabilities: CapabilityGroup[] =
    mode === "chat"
      ? [...CHAT_PERMITTED_CAPABILITIES]
      : [...AGENT_PERMITTED_CAPABILITIES];
  if (params.pythonSourceRepair) {
    const artifactIndex = permittedCapabilities.indexOf("artifact_generation");
    if (artifactIndex >= 0) permittedCapabilities.splice(artifactIndex, 1);
  }

  // Derive initial active capabilities from deterministic state:
  const active = new Set<CapabilityGroup>();

  // 1. Source access: active if workspace is mounted, workspaceRoot exists, or files are attached
  if (params.hasWorkspace || Boolean(params.workspaceRoot) || attachments.length > 0 || params.hasKnowledgeBaseDocs) {
    active.add("source_access");
  }

  // 2. Document processing: active if extractable/visual attachments are provided
  if (hasVisualAttachments || hasDocumentAttachments) {
    active.add("document_processing");
  }

  // 3. Result retrieval: active only when durable intermediate results actually exist
  if (params.hasRetrievableResults) {
    active.add("result_retrieval");
  }

  // 4. Deliverables: active if output preference or prompt warrants deliverable creation
  const deliverableExplicit =
    (!params.pythonSourceRepair && params.deliverableRequested) ||
    params.outputPreference === "artifact" ||
    params.outputPreference === "chat_and_artifact" ||
    /\b(?:approval\s*note|clearance\s*note|compliance\s*(?:note|review)|audit\s*memo|word\s*doc(?:x)?|spreadsheet|workbook|\.?docx\b|\.?xlsx\b|\.?pdf\b|\.md\b|report\.md|deliverable)\b/i.test(
      text,
    );
  if (deliverableExplicit) {
    active.add("artifact_generation");
  }

  // 5. Structured computation: active if prompt implies calculation/script execution on datasets/attachments
  const computationExplicit =
    /\b(?:python|script|execute|calculate|compute|analyze\s+data|run\s+analysis|pandas|numpy|reconcil)\b/i.test(text) &&
    (attachments.length > 0 || params.hasWorkspace || Boolean(params.workspaceRoot));
  if (computationExplicit) {
    active.add("structured_computation");
  }

  // 6. Agent-only capabilities (workspace mutation & system execution)
  if (mode === "agent") {
    if (mutationExplicit) {
      active.add("workspace_mutation");
    }
    if (commandExplicit) {
      active.add("system_execution");
    }
  }

  // Filter active capabilities to only those strictly permitted by the envelope
  const activeCapabilities = Array.from(active).filter((cap) =>
    permittedCapabilities.includes(cap),
  );

  return {
    schemaVersion: 1,
    runId: params.runId,
    mode,
    modelId: params.modelId,
    hasWorkspace: params.hasWorkspace,
    workspaceRoot: params.workspaceRoot,
    attachments,
    hasVisualAttachments,
    hasKnowledgeBaseDocs: Boolean(params.hasKnowledgeBaseDocs),
    hasRetrievableResults: Boolean(params.hasRetrievableResults),
    outputPreference: params.outputPreference,
    permittedCapabilities,
    activeCapabilities,
    contextLimit: params.contextLimit ?? 8192,
    authorizationState: params.authorizationState ?? {
      planConfirmed: false,
      authorizedOperations: [],
    },
  };
}

export function isCapabilityPermitted(
  envelope: ExecutionEnvelope,
  capability: CapabilityGroup,
): boolean {
  return envelope.permittedCapabilities.includes(capability);
}

export function isMutationPermitted(envelope: ExecutionEnvelope): boolean {
  return (
    envelope.mode === "agent" &&
    envelope.permittedCapabilities.includes("workspace_mutation")
  );
}

export function isCommandExecutionPermitted(envelope: ExecutionEnvelope): boolean {
  return (
    envelope.mode === "agent" &&
    envelope.permittedCapabilities.includes("system_execution")
  );
}
