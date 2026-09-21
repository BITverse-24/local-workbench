import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AttachmentReference, ModelId, TaskType } from "../../shared/contracts.js";
import { ModelGateway, requestBase } from "../gateway/model-gateway.js";

export interface SemanticIntent {
  driverModel: ModelId;
  taskType: TaskType;
  primaryGoal: string;
  isActionable: boolean;
  targetFiles: string[];
  intentType:
    | "code_modification"
    | "file_inspection"
    | "command_execution"
    | "document_drafting"
    | "pure_chat"
    | "general_qa";
  reason: string;
}

export interface SemanticRouterInput {
  userPrompt: string;
  runId?: string;
  attachments?: AttachmentReference[];
  hasWorkspace?: boolean;
  workspaceFiles?: string[];
  history?: Array<{ role: string; content: string }>;
  devWorkload?: boolean;
  temperature?: number;
}

const SEMANTIC_ROUTER_SYSTEM_PROMPT = `You are the Semantic Intent Orchestrator of Sovereign Workbench.
Analyze the user's latest request in the context of the ongoing conversation, attached files, and project workspace.
Determine the user's primary goal, the appropriate specialized lead model, whether disk/terminal action is required, and any target files.

Available lead models:
- "code-qwen25coder": for creating/modifying code, debugging, workspace file operations, command execution, and coding questions.
- "draft-qwen3": for drafting formal engineering memos, compliance approval notes, deliverables, and general conceptual reasoning.
- "vision-qwen25vl": for reading scanned inspection reports, engineering drawings, or diagrams.

Output strictly valid JSON matching this schema:
{
  "intentType": "code_modification" | "file_inspection" | "command_execution" | "document_drafting" | "pure_chat" | "general_qa",
  "taskType": "code" | "draft" | "vision",
  "driverModel": "code-qwen25coder" | "draft-qwen3" | "vision-qwen25vl",
  "primaryGoal": "brief description of user's core intent (under 15 words)",
  "targetFiles": ["relative/path/to/file.ext"],
  "isActionable": true,
  "reason": "short explanation of model choice and routing"
}
Output ONLY raw JSON. Do NOT wrap in markdown code blocks.`;

/**
 * Extracts candidate file references (@path/to/file or exact file matches)
 * from text and chat history as a fallback or pre-pass.
 */
export function extractReferencedFiles(
  text: string,
  history: Array<{ role: string; content: string }> = [],
  workspaceFiles: string[] = [],
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

  // Match files known to exist in the workspace
  for (const f of workspaceFiles) {
    const base = path.basename(f);
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedRel = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordRx = new RegExp(`(?:@|\\b)(?:${escapedRel}|${escapedBase})\\b`, "i");
    if (wordRx.test(combined)) {
      referenced.add(f);
    }
  }

  return Array.from(referenced);
}

/**
 * Contextual Semantic Router:
 * Evaluates conversation history, workspace files, attachments, and the user prompt
 * to determine intent, lead driver model, and target files without rigid regex keyword tables.
 */
export async function resolveSemanticIntent(
  input: SemanticRouterInput,
  gateway?: ModelGateway,
): Promise<SemanticIntent> {
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

  // 1. Fast Deterministic Short-Circuits (Unambiguous Environment States)
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

  const isExplicitDrafting = /\b(?:draft|drafting|approval\s*note|memo|executive\s*summary|deliverable|\.docx|word\s*doc|compliance\s*report)\b/i.test(
    lowerPrompt,
  );

  // Document drafting / synthesis task: draft model drives (delegates to vision via extract_document tool)
  if (isExplicitDrafting) {
    const referencedFiles = extractReferencedFiles(userPrompt, history, workspaceFiles);
    return {
      driverModel: "draft-qwen3",
      taskType: "draft",
      primaryGoal: "Draft engineering document or compliance note",
      isActionable: true,
      targetFiles: referencedFiles,
      intentType: "document_drafting",
      reason: "document drafting and analytical synthesis",
    };
  }

  // Pure vision task: scanned report/drawing attached with no code context
  if (!hasWorkspace && isImageOrDoc && !isCodeAttachment) {
    return {
      driverModel: "vision-qwen25vl",
      taskType: "vision",
      primaryGoal: "Inspect and analyze document/image",
      isActionable: false,
      targetFiles: [],
      intentType: "file_inspection",
      reason: "visual document or image attached without code context",
    };
  }

  // Pure conversational greeting without any context
  if (
    !hasWorkspace &&
    attachments.length === 0 &&
    history.length === 0 &&
    /^(?:hi|hello|hey|greetings|good\s*(?:morning|evening|afternoon))[\s!.]*$/i.test(lowerPrompt)
  ) {
    return {
      driverModel: "draft-qwen3",
      taskType: "draft",
      primaryGoal: "General conversation",
      isActionable: false,
      targetFiles: [],
      intentType: "pure_chat",
      reason: "pure conversational greeting",
    };
  }

  // 2. Semantic LLM Resolution Call
  if (gateway && typeof gateway.execute === "function") {
    try {
      const formattedHistory = history
        .slice(-4)
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 300)}`)
        .join("\n");

      const fileListSample = workspaceFiles.slice(0, 35).join(", ");
      const attachmentsSample = attachments.map((a) => a.filename).filter(Boolean).join(", ");

      const prompt = `CONVERSATION HISTORY:
${formattedHistory || "None (new session)"}

RUNTIME CONTEXT:
Workspace Active: ${hasWorkspace ? "Yes" : "No"}
Available Files: ${fileListSample || "None"}
Attachments: ${attachmentsSample || "None"}

LATEST USER REQUEST:
"${promptTrimmed}"`;

      const base = requestBase(
        runId,
        "plan",
        "plan-qwen3-8b",
        "chat-result",
        SEMANTIC_ROUTER_SYSTEM_PROMPT,
        prompt,
        15000,
        256,
        temperature,
      );

      const request = {
        ...base,
        taskType: "plan" as const,
        modelId: "plan-qwen3-8b" as const,
        responseFormat: "chat-result" as const,
      };

      const response = await gateway.execute(request);
      if (response.ok) {
        let rawJson = (response.value.result as any)?.text ?? "";
        rawJson = rawJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

        const parsed = JSON.parse(rawJson);
        if (parsed && typeof parsed.primaryGoal === "string") {
          const validDriverModel: ModelId = ["code-qwen25coder", "draft-qwen3", "vision-qwen25vl"].includes(
            parsed.driverModel,
          )
            ? parsed.driverModel
            : hasWorkspace
            ? "code-qwen25coder"
            : "draft-qwen3";

          const validTaskType: TaskType = ["code", "draft", "vision"].includes(parsed.taskType)
            ? parsed.taskType
            : validDriverModel === "code-qwen25coder"
            ? "code"
            : "draft";

          const targetFiles = Array.isArray(parsed.targetFiles)
            ? parsed.targetFiles
                .map((f: any) => String(f).replace(/^@\/?/, "").replace(/^\.\//, "").trim())
                .filter((f: string) => f.length > 0)
            : extractReferencedFiles(userPrompt, history, workspaceFiles);

          return {
            driverModel: validDriverModel,
            taskType: validTaskType,
            primaryGoal: parsed.primaryGoal,
            isActionable: Boolean(parsed.isActionable),
            targetFiles,
            intentType: parsed.intentType ?? (hasWorkspace ? "code_modification" : "general_qa"),
            reason: parsed.reason ?? "semantic LLM classification",
          };
        }
      }
    } catch {
      // Fall through to resilient contextual fallback if LLM router times out or fails
    }
  }

  // 3. Resilient Contextual Fallback (No Brittle Regexes)
  // Understands role and context based on active workspace, conversation history, and explicit document requests.
  const referencedFiles = extractReferencedFiles(userPrompt, history, workspaceFiles);

  if (hasWorkspace) {
    if (isExplicitDrafting) {
      return {
        driverModel: "draft-qwen3",
        taskType: "draft",
        primaryGoal: "Draft engineering document or compliance note",
        isActionable: true,
        targetFiles: referencedFiles,
        intentType: "document_drafting",
        reason: "workspace active with explicit document drafting intent",
      };
    }

    return {
      driverModel: "code-qwen25coder",
      taskType: "code",
      primaryGoal: referencedFiles.length > 0 ? `Work on ${referencedFiles.join(", ")}` : "Workspace engineering",
      isActionable: true,
      targetFiles: referencedFiles,
      intentType: "code_modification",
      reason: "workspace active; routing to code engineering driver",
    };
  }

  if (isCodeAttachment) {
    return {
      driverModel: "code-qwen25coder",
      taskType: "code",
      primaryGoal: "Process code or data attachment",
      isActionable: true,
      targetFiles: attachments.map((a) => a.filename).filter(Boolean) as string[],
      intentType: "code_modification",
      reason: "code script or data file attached",
    };
  }

  return {
    driverModel: "draft-qwen3",
    taskType: "draft",
    primaryGoal: "Answer query or reason through task",
    isActionable: false,
    targetFiles: [],
    intentType: "general_qa",
    reason: "analytical reasoning and general query",
  };
}
