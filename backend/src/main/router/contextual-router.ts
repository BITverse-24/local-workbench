import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type {
  AttachmentReference,
  ExpectedDeliverableSpec,
  IntentResolutionStatus,
  ModelId,
  OutputExpectation,
  TaskType,
} from "../../shared/contracts.js";
import { ModelGateway, requestBase } from "../gateway/model-gateway.js";
import {
  deriveOutputExpectation,
  determineOutputExpectation,
  extractNegativeFileConstraints,
} from "./output-expectation.js";

export const RawExpectedDeliverableSchema = z.object({
  filename: z.string().optional(),
  type: z.enum(["docx", "xlsx", "csv", "pdf", "md", "json", "file"]).default("file"),
  description: z.string().optional(),
});

export const RawSemanticIntentSchema = z.object({
  intentType: z.enum([
    "code_modification",
    "file_inspection",
    "command_execution",
    "document_drafting",
    "pure_chat",
    "general_qa",
  ]),
  taskType: z.enum(["code", "draft", "vision"]).default("draft"),
  driverModel: z.enum(["code-qwen25coder", "draft-qwen3", "vision-qwen25vl"]).default("draft-qwen3"),
  primaryGoal: z.string().min(1),
  isActionable: z.boolean().default(false),
  chatResponseOnly: z.boolean().default(false),
  workspaceMutationRequested: z.boolean().default(false),
  targetFiles: z.array(z.string()).default([]),
  protectedPaths: z.array(z.string()).default([]),
  restrictMutationsToTargets: z.boolean().default(false),
  expectedDeliverables: z.array(RawExpectedDeliverableSchema).default([]),
  reason: z.string().default(""),
  confidence: z.number().min(0).max(1).optional(),
  ambiguityDetails: z.string().optional(),
});

export type RawSemanticIntent = z.infer<typeof RawSemanticIntentSchema>;

export interface ValidatedSemanticIntent {
  status: IntentResolutionStatus;
  driverModel: ModelId;
  taskType: TaskType;
  primaryGoal: string;
  isActionable: boolean;
  chatResponseOnly: boolean;
  workspaceMutationRequested: boolean;
  targetFiles: string[];
  protectedPaths: string[];
  restrictMutationsToTargets: boolean;
  expectedDeliverables: ExpectedDeliverableSpec[];
  intentType:
    | "code_modification"
    | "file_inspection"
    | "command_execution"
    | "document_drafting"
    | "pure_chat"
    | "general_qa";
  reason: string;
  confidence?: number;
  ambiguityDetails?: string;
  failureReason?: string;
  outputExpectation?: OutputExpectation;
}

export type SemanticIntent = ValidatedSemanticIntent;

export interface SemanticRouterInput {
  userPrompt: string;
  runId?: string;
  attachments?: AttachmentReference[];
  hasWorkspace?: boolean;
  workspaceFiles?: string[];
  history?: Array<{ role: string; content: string }>;
  temperature?: number;
}

export const SEMANTIC_ROUTER_SYSTEM_PROMPT = `You are the Semantic Intent Orchestrator of Sovereign Workbench.
Analyze the user's latest request in the context of the ongoing conversation, attached files, and project workspace.
Determine the user's primary goal, appropriate specialized lead model, whether disk/terminal action is required, target files, protected paths, and any downloadable deliverables.

Available lead models:
- "code-qwen25coder": for creating/modifying code, debugging, workspace file operations, command execution, and coding questions/explanations.
- "draft-qwen3": for drafting formal engineering memos, compliance approval notes, deliverables, and general conceptual reasoning.
- "vision-qwen25vl": for reading scanned inspection reports, engineering drawings, or diagrams.

CRITICAL INTENTION & SEPARATION RULES:
1. WORKSPACE OPERATIONS VS. DELIVERABLES (DO NOT CONFUSE THEM):
   - Modifying or updating an existing workspace file (e.g. "Update notes.md", "Fix server.py") is a WORKSPACE OPERATION.
     • Set "workspaceMutationRequested": true.
     • Include the file in "targetFiles": ["notes.md"].
     • "expectedDeliverables" MUST BE EMPTY! Updating a workspace file is NOT a downloadable deliverable.
   - ONLY include files in "expectedDeliverables" if the user explicitly asked to generate or export an official standalone deliverable document/spreadsheet (e.g. Word document .docx, Excel workbook .xlsx, CSV report export .csv).
2. NEGATIVE CONSTRAINTS & PROTECTED PATHS:
   - If the user explicitly forbids modifying, touching, changing, or creating certain files (e.g. "Do not modify config.json, unrelated.md"):
     • Add those files to "protectedPaths": ["config.json", "unrelated.md"].
     • Protected files MUST NEVER appear in "targetFiles" or "expectedDeliverables"!
   - If the user specifies broader restrictions like "or any other existing file", "only modify X", or "touch nothing else":
     • Set "restrictMutationsToTargets": true.
3. CHAT-ONLY QUERIES VS. DISK ACTIONS:
   - If the user asks questions, seeks explanations, asks for architectural advice, or asks for code snippets/examples directly in chat (e.g. "show me how to do this in Python", "explain this CSV", "how does auth work?"):
     • Set "isActionable": false.
     • Set "chatResponseOnly": true.
     • Set "workspaceMutationRequested": false.
     • Set "targetFiles": [].
     • Set "expectedDeliverables": [].
     • Set "intentType": "general_qa".
4. AMBIGUOUS REQUESTS:
   - If the request is incomplete, unintelligible, or contradictory (e.g. user instructs to modify a file while also stating not to touch it):
     • Set "isActionable": false.
     • Set "ambiguityDetails": "brief explanation of why the request is ambiguous".

Output strictly valid JSON matching this schema:
{
  "intentType": "code_modification" | "file_inspection" | "command_execution" | "document_drafting" | "pure_chat" | "general_qa",
  "taskType": "code" | "draft" | "vision",
  "driverModel": "code-qwen25coder" | "draft-qwen3" | "vision-qwen25vl",
  "primaryGoal": "brief description of user's core intent (under 15 words)",
  "isActionable": true | false,
  "chatResponseOnly": true | false,
  "workspaceMutationRequested": true | false,
  "targetFiles": ["relative/path/to/file.ext"],
  "protectedPaths": ["relative/path/to/protected.ext"],
  "restrictMutationsToTargets": true | false,
  "expectedDeliverables": [
    { "filename": "report.docx", "type": "docx" | "xlsx" | "csv" | "pdf" | "md" | "file", "description": "short description" }
  ],
  "reason": "short explanation of model choice and routing",
  "confidence": 1.0,
  "ambiguityDetails": "optional note if request is ambiguous"
}
Output ONLY raw JSON. Do NOT wrap in markdown code blocks.`;

/**
 * Validates, normalizes, and resolves cross-field consistency for raw semantic intents.
 * Enforces deterministic separation of workspace operations and deliverables,
 * conflict resolution between targets and protected paths, and chat-only constraints.
 */
export function validateAndNormalizeIntent(
  raw: unknown,
  context: {
    hasWorkspace: boolean;
    workspaceFiles: string[];
    userPrompt: string;
  },
): ValidatedSemanticIntent {
  const parseResult = RawSemanticIntentSchema.safeParse(raw);
  if (!parseResult.success) {
    return {
      status: "failed",
      driverModel: context.hasWorkspace ? "code-qwen25coder" : "draft-qwen3",
      taskType: context.hasWorkspace ? "code" : "draft",
      primaryGoal: "Failed intent classification",
      isActionable: false,
      chatResponseOnly: true,
      workspaceMutationRequested: false,
      targetFiles: [],
      protectedPaths: [],
      restrictMutationsToTargets: false,
      expectedDeliverables: [],
      intentType: "general_qa",
      reason: "Schema validation failure",
      failureReason: parseResult.error.message,
    };
  }

  const data = parseResult.data;

  // 1. Sanitize & normalize paths (remove leading @, ./, ../, trim)
  const sanitize = (p: string) =>
    p.replace(/^@\/?/, "").replace(/^\.\//, "").replace(/^\.\\/, "").trim();

  const isEscapingPath = (p: string) =>
    p.startsWith("..") || p.includes("/../") || p.includes("\\..\\");

  const protectedPaths = Array.from(
    new Set(data.protectedPaths.map(sanitize).filter((p) => p.length > 0 && !isEscapingPath(p))),
  );
  const protectedSet = new Set(protectedPaths.map((p) => p.toLowerCase()));
  for (const p of protectedPaths) {
    protectedSet.add(path.basename(p).toLowerCase());
  }

  // 2. Filter targetFiles against protected paths (conflict resolution: protected paths ALWAYS win)
  const rawTargetFiles = Array.from(
    new Set(data.targetFiles.map(sanitize).filter((p) => p.length > 0 && !isEscapingPath(p))),
  );
  const targetFiles = rawTargetFiles.filter((t) => {
    const lower = t.toLowerCase();
    const base = path.basename(lower);
    return !protectedSet.has(lower) && !protectedSet.has(base);
  });

  const hadConflict = rawTargetFiles.length > targetFiles.length;

  // 3. Normalize expected deliverables & separate from workspace mutations
  const targetSet = new Set(targetFiles.map((t) => t.toLowerCase()));
  for (const t of targetFiles) {
    targetSet.add(path.basename(t).toLowerCase());
  }

  const expectedDeliverables: ExpectedDeliverableSpec[] = [];
  for (const d of data.expectedDeliverables) {
    const rawFn = d.filename ? sanitize(d.filename) : undefined;
    if (rawFn && isEscapingPath(rawFn)) continue;
    if (rawFn && (protectedSet.has(rawFn.toLowerCase()) || protectedSet.has(path.basename(rawFn.toLowerCase())))) {
      continue;
    }

    // A workspace source file being modified must NOT become a deliverable
    if (rawFn && targetSet.has(rawFn.toLowerCase())) {
      const ext = rawFn.split(".").pop()?.toLowerCase();
      if (ext !== "docx" && ext !== "xlsx" && ext !== "pdf") {
        continue;
      }
    }

    expectedDeliverables.push({
      filename: rawFn,
      type: d.type,
      description: d.description || rawFn,
    });
  }

  // 4. Chat-only consistency enforcement
  let isActionable = data.isActionable;
  let chatResponseOnly = data.chatResponseOnly;
  let workspaceMutationRequested = data.workspaceMutationRequested;
  let intentType = data.intentType;

  if (chatResponseOnly) {
    isActionable = false;
    workspaceMutationRequested = false;
    targetFiles.length = 0;
    expectedDeliverables.length = 0;
    if (intentType === "code_modification" || intentType === "document_drafting") {
      intentType = "general_qa";
    }
  }

  // If no workspace is active, workspace mutations cannot occur
  if (!context.hasWorkspace && workspaceMutationRequested && targetFiles.length === 0) {
    workspaceMutationRequested = false;
    if (!isActionable && expectedDeliverables.length === 0) {
      chatResponseOnly = true;
      intentType = "general_qa";
    }
  }

  // 5. Ambiguity evaluation
  let status: IntentResolutionStatus = "resolved";
  let ambiguityDetails = data.ambiguityDetails;

  if (data.ambiguityDetails) {
    status = "ambiguous";
    isActionable = false;
  } else if (hadConflict && targetFiles.length === 0 && data.workspaceMutationRequested) {
    status = "ambiguous";
    ambiguityDetails = "Conflict detected: all requested target files are in the protected paths list";
    isActionable = false;
  } else if (data.confidence !== undefined && data.confidence < 0.4) {
    status = "ambiguous";
    ambiguityDetails = "Low classification confidence";
    isActionable = false;
  }

  const validDriverModel: ModelId = ["code-qwen25coder", "draft-qwen3", "vision-qwen25vl"].includes(data.driverModel)
    ? data.driverModel
    : context.hasWorkspace
    ? "code-qwen25coder"
    : "draft-qwen3";

  const validTaskType: TaskType = ["code", "draft", "vision"].includes(data.taskType)
    ? data.taskType
    : validDriverModel === "code-qwen25coder"
    ? "code"
    : "draft";

  const intent: ValidatedSemanticIntent = {
    status,
    driverModel: validDriverModel,
    taskType: validTaskType,
    primaryGoal: data.primaryGoal,
    isActionable,
    chatResponseOnly,
    workspaceMutationRequested,
    targetFiles,
    protectedPaths,
    restrictMutationsToTargets: data.restrictMutationsToTargets,
    expectedDeliverables,
    intentType,
    reason: data.reason || "validated natural language semantic classification",
    confidence: data.confidence,
    ambiguityDetails,
  };

  intent.outputExpectation = deriveOutputExpectation(intent);
  return intent;
}

/**
 * Extracts candidate file references (@path/to/file or exact file matches)
 * from text and chat history as a fallback or pre-pass.
 */
export function extractReferencedFiles(
  text: string,
  history: Array<{ role: string; content: string }> = [],
  workspaceFiles: string[] = [],
  attachmentFiles: string[] = [],
): string[] {
  const referenced = new Set<string>();
  const combined = [
    ...history.slice(-3).map((m) => m.content),
    text,
  ].join("\n");

  // Match @path/to/file.ext
  const atRegex = /@([a-zA-Z0-9_.\-/]+\.[a-zA-Z0-9]+)/g;
  let match: RegExpExecArray | null;
  while ((match = atRegex.exec(combined)) !== null) {
    const p = match[1].replace(/^\.?\//, "").trim();
    if (p) referenced.add(p);
  }

  // Match files known to exist in the workspace or attachments
  const allKnownFiles = [...workspaceFiles, ...attachmentFiles];
  for (const f of allKnownFiles) {
    const base = path.basename(f);
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedRel = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordRx = new RegExp(`(?:@|\\b)(?:${escapedRel}|${escapedBase})\\b`, "i");
    if (wordRx.test(combined)) {
      referenced.add(f);
    }
  }

  // When prompt refers to script/code/fix/broken and attachments exist, include code attachments
  if (referenced.size === 0 && /\b(?:script|parser|code|fix|broken|python|csv|utility)\b/i.test(combined)) {
    for (const f of attachmentFiles) {
      if (/\.(?:py|js|ts|json|csv|sh)$/i.test(f)) {
        referenced.add(f);
      }
    }
  }

  // When prompt refers to codebase/project-level tasks without naming individual files,
  // collect primary source files and package.json
  if (referenced.size === 0 && /\b(?:codebase|project|typescript|ts|convert|migrate|refactor)\b/i.test(combined)) {
    const codeFiles = workspaceFiles.filter(
      (f) =>
        /\.(?:js|jsx|ts|tsx|json|py)$/i.test(f) &&
        !f.includes("package-lock") &&
        !f.includes("node_modules") &&
        !f.startsWith("."),
    );
    for (const f of codeFiles.slice(0, 10)) {
      referenced.add(f);
    }
  }

  return Array.from(referenced);
}

/**
 * Contextual Semantic Router:
 * Evaluates conversation history, workspace files, attachments, and the user prompt
 * using local LLM Natural Language Intention Detection without fragile regex filters.
 */
export async function resolveSemanticIntent(
  input: SemanticRouterInput,
  gateway?: ModelGateway,
): Promise<ValidatedSemanticIntent> {
  const {
    userPrompt,
    runId = randomUUID(),
    attachments = [],
    hasWorkspace = false,
    workspaceFiles = [],
    history = [],
    temperature = 0.0,
  } = input;

  const promptTrimmed = userPrompt.trim();
  const lowerPrompt = promptTrimmed.toLowerCase();

  // 1. Primary Semantic LLM Resolution Call (when Gateway is available)
  if (gateway && typeof gateway.execute === "function") {
    try {
      const formattedHistory = history
        .slice(-4)
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 300)}`)
        .join("\n");

      // Scope strictly to resource metadata - do NOT inject untrusted document bodies
      const fileListSample = workspaceFiles.slice(0, 40).join(", ");
      const attachmentsSample = attachments
        .map((a) => `${a.filename} (${a.mediaType || "unknown"}, ${a.sizeBytes || 0} bytes)`)
        .join(", ");

      const prompt = `CONVERSATION HISTORY:
${formattedHistory || "None (new session)"}

RUNTIME CONTEXT (METADATA ONLY - UNTRUSTED SOURCE DATA):
Workspace Active: ${hasWorkspace ? "Yes" : "No"}
Available Files: ${fileListSample || "None"}
Attachments: ${attachmentsSample || "None"}

LATEST USER REQUEST:
"${promptTrimmed}"`;

      const base = requestBase(
        runId,
        "draft",
        "draft-qwen3",
        "chat-result",
        SEMANTIC_ROUTER_SYSTEM_PROMPT,
        prompt,
        15000,
        384,
        temperature,
      );

      const request = {
        ...base,
        taskType: "draft" as const,
        modelId: "draft-qwen3" as const,
        responseFormat: "chat-result" as const,
      };

      const response = await gateway.execute(request);
      if (response.ok) {
        let parsed: any = null;
        const resValue = response.value.result as any;
        if (resValue && typeof resValue === "object" && typeof resValue.primaryGoal === "string") {
          parsed = resValue;
        } else {
          let rawJson = resValue?.text ?? (typeof resValue === "string" ? resValue : "");
          // Extract JSON using machine format boundary checks
          const firstBrace = rawJson.indexOf("{");
          const lastBrace = rawJson.lastIndexOf("}");
          if (firstBrace >= 0 && lastBrace > firstBrace) {
            rawJson = rawJson.slice(firstBrace, lastBrace + 1);
          }
          try {
            parsed = JSON.parse(rawJson);
          } catch {
            // Attempt 1 bounded repair
            try {
              const repairRequest = {
                ...base,
                taskType: "draft" as const,
                modelId: "draft-qwen3" as const,
                responseFormat: "chat-result" as const,
                requestId: randomUUID(),
                systemPrompt: "You are a JSON repair tool. Output ONLY valid JSON matching the schema with no formatting or prose.",
                userPrompt: `Repair the following malformed output into valid JSON only:\n${rawJson.slice(0, 800)}`,
                timeoutMs: 8000,
              };
              const repairRes = await gateway.execute(repairRequest);
              if (repairRes.ok) {
                const repText = (repairRes.value.result as any)?.text ?? String(repairRes.value.result ?? "");
                const f = repText.indexOf("{");
                const l = repText.lastIndexOf("}");
                if (f >= 0 && l > f) {
                  parsed = JSON.parse(repText.slice(f, l + 1));
                }
              }
            } catch {}
          }
        }

        if (parsed && typeof parsed === "object") {
          return validateAndNormalizeIntent(parsed, {
            hasWorkspace,
            workspaceFiles,
            userPrompt: promptTrimmed,
          });
        }

        return {
          status: "failed",
          driverModel: hasWorkspace ? "code-qwen25coder" : "draft-qwen3",
          taskType: hasWorkspace ? "code" : "draft",
          primaryGoal: "Malformed model response",
          isActionable: false,
          chatResponseOnly: true,
          workspaceMutationRequested: false,
          targetFiles: [],
          protectedPaths: [],
          restrictMutationsToTargets: false,
          expectedDeliverables: [],
          intentType: "general_qa",
          reason: "Malformed JSON from semantic gateway",
          failureReason: "Gateway returned unparseable JSON",
        };
      } else {
        return {
          status: "failed",
          driverModel: hasWorkspace ? "code-qwen25coder" : "draft-qwen3",
          taskType: hasWorkspace ? "code" : "draft",
          primaryGoal: "Gateway execution failed",
          isActionable: false,
          chatResponseOnly: true,
          workspaceMutationRequested: false,
          targetFiles: [],
          protectedPaths: [],
          restrictMutationsToTargets: false,
          expectedDeliverables: [],
          intentType: "general_qa",
          reason: "Model gateway error: " + (response.error?.message || "unknown"),
          failureReason: response.error?.message,
        };
      }
    } catch (err) {
      return {
        status: "failed",
        driverModel: hasWorkspace ? "code-qwen25coder" : "draft-qwen3",
        taskType: hasWorkspace ? "code" : "draft",
        primaryGoal: "Semantic classification error",
        isActionable: false,
        chatResponseOnly: true,
        workspaceMutationRequested: false,
        targetFiles: [],
        protectedPaths: [],
        restrictMutationsToTargets: false,
        expectedDeliverables: [],
        intentType: "general_qa",
        reason: "Exception during semantic classification: " + (err instanceof Error ? err.message : String(err)),
        failureReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 2. Resilient Contextual Fallback (Offline / Test / Gateway Failure Fallback)
  const isImageOrDoc = attachments.some(
    (a) =>
      a.mediaType.startsWith("image/") ||
      a.mediaType === "application/pdf" ||
      /\.(?:png|jpe?g|webp|pdf|svg)$/i.test(a.filename ?? ""),
  );
  const isCodeAttachment = attachments.some(
    (a) =>
      /\.(?:py|js|ts|jsx|tsx|json|sh|bash|css|html)$/i.test(a.filename ?? "") ||
      a.mediaType === "text/x-python" ||
      a.mediaType === "application/javascript" ||
      a.mediaType === "text/javascript" ||
      a.mediaType === "application/typescript",
  );

  const isExplicitDrafting =
    /\b(?:draft\s+(?:an?\s+)?(?:approval\s*note|memo|deliverable|document|report)|export\s+(?:to\s+)?(?:docx|xlsx|pdf)|write\s+(?:an?\s+)?(?:approval\s*note|deliverable))\b/i.test(
      lowerPrompt,
    );

  const attachmentFileNames = attachments.map((a) => a.filename).filter(Boolean) as string[];
  const rawReferencedFiles = extractReferencedFiles(userPrompt, history, workspaceFiles, attachmentFileNames);
  const negatedFiles = extractNegativeFileConstraints(userPrompt);
  const referencedFiles = rawReferencedFiles.filter(
    (f: string) => !negatedFiles.has(f.toLowerCase()) && !negatedFiles.has(path.basename(f.toLowerCase()))
  );

  const defaultExpectation = () => determineOutputExpectation(userPrompt, { attachments, hasWorkspace, workspaceFiles });

  const buildFallback = (p: {
    driverModel: ModelId;
    taskType: TaskType;
    primaryGoal: string;
    isActionable: boolean;
    targetFiles: string[];
    intentType: ValidatedSemanticIntent["intentType"];
    reason: string;
    outputExpectation: OutputExpectation;
  }): ValidatedSemanticIntent => {
    const isChatOnly =
      !p.isActionable &&
      p.outputExpectation.expectedFiles.length === 0 &&
      !p.outputExpectation.workspaceMutationRequested;

    const fallbackDeliverables: ExpectedDeliverableSpec[] =
      (p.outputExpectation.expectedDeliverables && p.outputExpectation.expectedDeliverables.length > 0)
        ? p.outputExpectation.expectedDeliverables
        : p.outputExpectation.expectedFiles
            .filter((f) => /\.(docx|xlsx|csv|pdf|md)$/i.test(f))
            .map((f) => {
              const ext = f.split(".").pop()?.toLowerCase();
              return {
                filename: f,
                type: (ext === "docx" ? "docx" : ext === "xlsx" ? "xlsx" : ext === "csv" ? "csv" : ext === "pdf" ? "pdf" : ext === "md" ? "md" : "file") as any,
                description: f,
              };
            });

    return {
      status: "resolved",
      driverModel: p.driverModel,
      taskType: p.taskType,
      primaryGoal: p.primaryGoal,
      isActionable: p.isActionable,
      chatResponseOnly: isChatOnly,
      workspaceMutationRequested: p.outputExpectation.workspaceMutationRequested,
      targetFiles: p.targetFiles,
      protectedPaths: Array.from(negatedFiles),
      restrictMutationsToTargets: false,
      expectedDeliverables: fallbackDeliverables,
      intentType: p.intentType,
      reason: p.reason,
      outputExpectation: p.outputExpectation,
    };
  };

  // Pure conversational greeting without attachments
  if (
    attachments.length === 0 &&
    history.length === 0 &&
    /^(?:hi|hello|hey|greetings|good\s*(?:morning|evening|afternoon)|who are you)[\s!.]*$/i.test(lowerPrompt)
  ) {
    return buildFallback({
      driverModel: "draft-qwen3",
      taskType: "draft",
      primaryGoal: "General conversation",
      isActionable: false,
      targetFiles: [],
      intentType: "pure_chat",
      reason: "pure conversational greeting",
      outputExpectation: defaultExpectation(),
    });
  }

  if (isCodeAttachment) {
    const codeTargetFiles = attachments.map((a) => a.filename).filter(Boolean) as string[];
    const isExplicitAction = /\b(?:create|write|add|delete|remove|rm|fix|repair|patch|modify|update|edit|refactor|scaffold|convert|migrate|implement|build|install|npm|run|exec|test)\b/i.test(
      lowerPrompt,
    );
    const isQuestionOrInquiry =
      /\b(?:what|why|how|explain|walk\s*through|tell\s*me\s*about|describe|review|compare|difference|where\s*is|which|meaning|summarize|summary|help\s*me\s*understand|can\s*you\s*(?:explain|clarify|summarize|review))\b/i.test(
        lowerPrompt,
      ) || promptTrimmed.endsWith("?");

    if (isQuestionOrInquiry && !isExplicitAction) {
      return buildFallback({
        driverModel: "code-qwen25coder",
        taskType: "code",
        primaryGoal: `Explain attached code: ${codeTargetFiles.join(", ")}`,
        isActionable: false,
        targetFiles: codeTargetFiles,
        intentType: "general_qa",
        reason: "code attachment provided: inquiry and explanation without disk mutation",
        outputExpectation: defaultExpectation(),
      });
    }

    return buildFallback({
      driverModel: "code-qwen25coder",
      taskType: "code",
      primaryGoal: `Process and repair attached code: ${codeTargetFiles.join(", ")}`,
      isActionable: true,
      targetFiles: codeTargetFiles,
      intentType: "code_modification",
      reason: "code or data attachment provided; prioritizing attached files",
      outputExpectation: defaultExpectation(),
    });
  }

  // Visual document or drawing attached without code workspace
  if (!hasWorkspace && isImageOrDoc) {
    if (isExplicitDrafting) {
      return buildFallback({
        driverModel: "draft-qwen3",
        taskType: "draft",
        primaryGoal: "Draft engineering document or compliance note",
        isActionable: true,
        targetFiles: referencedFiles,
        intentType: "document_drafting",
        reason: "document drafting requested for attached document",
        outputExpectation: defaultExpectation(),
      });
    }
    return buildFallback({
      driverModel: "vision-qwen25vl",
      taskType: "vision",
      primaryGoal: "Inspect and analyze document/image",
      isActionable: false,
      targetFiles: [],
      intentType: "file_inspection",
      reason: "visual document or image attached without code context",
      outputExpectation: defaultExpectation(),
    });
  }

  if (hasWorkspace) {
    if (isExplicitDrafting) {
      return buildFallback({
        driverModel: "draft-qwen3",
        taskType: "draft",
        primaryGoal: "Draft engineering document or compliance note",
        isActionable: true,
        targetFiles: referencedFiles,
        intentType: "document_drafting",
        reason: "workspace active with explicit document drafting intent",
        outputExpectation: defaultExpectation(),
      });
    }

    // Check if the user is asking an informational question, conceptual explanation, architecture review,
    // or general Q&A vs asking for active code modifications or disk actions.
    const isExplicitAction = /\b(?:create|write|add|delete|remove|rm|fix|repair|patch|modify|update|edit|refactor|scaffold|convert|migrate|implement|build|install|npm|run|exec|test)\b/i.test(
      lowerPrompt,
    );
    const isQuestionOrInquiry =
      /\b(?:what|why|how|explain|walk\s*through|tell\s*me\s*about|describe|review|compare|difference|where\s*is|which|meaning|summarize|summary|help\s*me\s*understand|can\s*you\s*(?:explain|clarify|summarize|review))\b/i.test(
        lowerPrompt,
      ) || promptTrimmed.endsWith("?");

    if (isQuestionOrInquiry && !isExplicitAction) {
      return buildFallback({
        driverModel: "code-qwen25coder",
        taskType: "code",
        primaryGoal: referencedFiles.length > 0 ? `Explain ${referencedFiles.join(", ")}` : "Workspace code inquiry & explanation",
        isActionable: false,
        targetFiles: referencedFiles,
        intentType: "general_qa",
        reason: "workspace active: code inquiry and conceptual explanation without disk mutation",
        outputExpectation: defaultExpectation(),
      });
    }

    return buildFallback({
      driverModel: "code-qwen25coder",
      taskType: "code",
      primaryGoal: referencedFiles.length > 0 ? `Work on ${referencedFiles.join(", ")}` : "Workspace engineering",
      isActionable: true,
      targetFiles: referencedFiles,
      intentType: "code_modification",
      reason: "workspace active; routing to code engineering driver",
      outputExpectation: defaultExpectation(),
    });
  }

  if (isExplicitDrafting) {
    return buildFallback({
      driverModel: "draft-qwen3",
      taskType: "draft",
      primaryGoal: "Draft engineering document or compliance note",
      isActionable: true,
      targetFiles: referencedFiles,
      intentType: "document_drafting",
      reason: "explicit document drafting requested",
      outputExpectation: defaultExpectation(),
    });
  }

  const isCodingQuery =
    /\b(?:code|snippet|script|function|class|fastapi|flask|express|react|vue|angular|python|javascript|typescript|ts|js|py|sql|html|css|api|endpoint|middleware|algorithm|async|await)\b/i.test(
      lowerPrompt,
    );

  if (isCodingQuery) {
    return buildFallback({
      driverModel: "code-qwen25coder",
      taskType: "code",
      primaryGoal: "Code snippet or engineering explanation",
      isActionable: false,
      targetFiles: [],
      intentType: "general_qa",
      reason: "coding query without active workspace; chat-only code assistance",
      outputExpectation: defaultExpectation(),
    });
  }

  return buildFallback({
    driverModel: "draft-qwen3",
    taskType: "draft",
    primaryGoal: "Answer query or reason through task",
    isActionable: false,
    targetFiles: [],
    intentType: "general_qa",
    reason: "analytical reasoning and general query",
    outputExpectation: defaultExpectation(),
  });
}
