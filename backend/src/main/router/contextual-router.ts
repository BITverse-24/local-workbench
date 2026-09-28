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
  temperature?: number;
}

const SEMANTIC_ROUTER_SYSTEM_PROMPT = `You are the Semantic Intent Orchestrator of Sovereign Workbench.
Analyze the user's latest request in the context of the ongoing conversation, attached files, and project workspace.
Determine the user's primary goal, the appropriate specialized lead model, whether disk/terminal action is required, and any target files.

Available lead models:
- "code-qwen25coder": for creating/modifying code, debugging, workspace file operations, command execution, and coding questions/explanations.
- "draft-qwen3": for drafting formal engineering memos, compliance approval notes, deliverables, and general conceptual reasoning.
- "vision-qwen25vl": for reading scanned inspection reports, engineering drawings, or diagrams.

CRITICAL ACTIONABILITY & INTENT RULES:
- If the user is asking questions, seeking explanations, requesting an architectural review, or having general conversation (even inside an active workspace), set "isActionable": false and "intentType": "general_qa" or "pure_chat".
- ONLY set "isActionable": true if the user explicitly asks to create, modify, delete, build, install, or run code/files on disk ("intentType": "code_modification" or "command_execution").
- If the user asks to inspect, review, verify, or check compliance of an attached drawing or report in chat without asking for an official export document or file, set "isActionable": false and "intentType": "file_inspection". Route to "vision-qwen25vl" for drawings or scanned documents.
- ONLY set "intentType": "document_drafting" and "isActionable": true if the user explicitly asks to draft or export an official deliverable document or file (e.g. "draft an approval note", "export report to docx").

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

  // 1. Primary Semantic LLM Resolution Call (when Gateway is available)
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
        let parsed: any = null;
        const resValue = response.value.result as any;
        if (resValue && typeof resValue === "object" && typeof resValue.primaryGoal === "string") {
          parsed = resValue;
        } else {
          let rawJson = resValue?.text ?? (typeof resValue === "string" ? resValue : "");
          rawJson = rawJson.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
          try {
            parsed = JSON.parse(rawJson);
          } catch {}
        }

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

          const attachmentFileNames = attachments.map((a) => a.filename).filter(Boolean) as string[];
          const targetFiles = Array.isArray(parsed.targetFiles) && parsed.targetFiles.length > 0
            ? parsed.targetFiles
                .map((f: any) => String(f).replace(/^@\/?/, "").replace(/^\.\//, "").trim())
                .filter((f: string) => f.length > 0)
            : extractReferencedFiles(userPrompt, history, workspaceFiles, attachmentFileNames);

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
  const referencedFiles = extractReferencedFiles(userPrompt, history, workspaceFiles, attachmentFileNames);

  // Pure conversational greeting without attachments
  if (
    attachments.length === 0 &&
    history.length === 0 &&
    /^(?:hi|hello|hey|greetings|good\s*(?:morning|evening|afternoon)|who are you)[\s!.]*$/i.test(lowerPrompt)
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

  if (isCodeAttachment) {
    const codeTargetFiles = attachments.map((a) => a.filename).filter(Boolean) as string[];
    return {
      driverModel: "code-qwen25coder",
      taskType: "code",
      primaryGoal: `Process and repair attached code: ${codeTargetFiles.join(", ")}`,
      isActionable: true,
      targetFiles: codeTargetFiles,
      intentType: "code_modification",
      reason: "code or data attachment provided; prioritizing attached files",
    };
  }

  // Visual document or drawing attached without code workspace
  if (!hasWorkspace && isImageOrDoc) {
    if (isExplicitDrafting) {
      return {
        driverModel: "draft-qwen3",
        taskType: "draft",
        primaryGoal: "Draft engineering document or compliance note",
        isActionable: true,
        targetFiles: referencedFiles,
        intentType: "document_drafting",
        reason: "document drafting requested for attached document",
      };
    }
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
      return {
        driverModel: "code-qwen25coder",
        taskType: "code",
        primaryGoal: referencedFiles.length > 0 ? `Explain ${referencedFiles.join(", ")}` : "Workspace code inquiry & explanation",
        isActionable: false,
        targetFiles: referencedFiles,
        intentType: "general_qa",
        reason: "workspace active: code inquiry and conceptual explanation without disk mutation",
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
