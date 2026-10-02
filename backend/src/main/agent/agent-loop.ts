import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentOutcome, ModelId, OutputExpectation, RunEvent } from "../../shared/contracts.js";
import type { AgentTool, ToolExecutionContext } from "../tools/types.js";
import { ToolDispatcher } from "./tool-dispatcher.js";
import { compactConversationHistory, extractSourceArg, type AgentMessage, type CompactionMetadata } from "./context-manager.js";
import {
  extractCodeBlocksWithFilenames,
  cleanFinalSummary,
  cleanPlanPreview,
  extractShellCommands,
} from "./code-extractor.js";
import { StreamingTagFilter } from "./streaming-filter.js";
import type { SemanticIntent } from "../router/contextual-router.js";
import { determineOutputExpectation, isInformationalInquiry, extractNegativeFileConstraints } from "../router/output-expectation.js";
import { MutationPolicyGuard, extractPathArg, extractCommandArg } from "../harness/policy-guard.js";

export interface AgentLoopOptions {
  runId: string;
  driverModelId: ModelId;
  userPrompt: string;
  systemPrompt: string;
  semanticIntent?: Partial<SemanticIntent>;
  outputExpectation?: OutputExpectation;
  tools: AgentTool[];
  context: ToolExecutionContext;
  recentChatHistory?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  maxTurns?: number;
  policyGuard?: MutationPolicyGuard;
  onPlanConfirmationRequired?: (plan: string, firstCalls: any[]) => Promise<boolean>;
  isCancelled?: () => boolean;
  emitEvent: (event: RunEvent) => void;
}

export interface AgentLoopResult {
  finalText: string;
  turns: number;
  completed: boolean;
  outcome: AgentOutcome;
  modelId: ModelId;
  messageId?: string;
  outputExpectation?: OutputExpectation;
  deliverables?: {
    requested: string[];
    produced: string[];
    missing: string[];
  };
  metadata?: {
    compactionEvents?: CompactionMetadata[];
    totalCompactedCount?: number;
    [key: string]: any;
  };
}

export interface ExpectedDeliverable {
  type: "docx" | "xlsx" | "csv" | "pdf" | "md" | "json" | "file";
  filename?: string;
  description: string;
}

/**
 * Deterministically analyzes the user's prompt to identify requested output deliverables
 * (e.g. Word documents, Excel spreadsheets, CSV exports), while filtering out input files
 * referenced for inspection or reading.
 */
export function detectRequestedDeliverables(
  userPrompt: string,
  semanticIntent?: Partial<SemanticIntent>,
  inputFilenames: string[] = [],
  outputExpectation?: OutputExpectation,
): ExpectedDeliverable[] {
  // 1. Direct consumption of validated natural language intention:
  if (semanticIntent?.status === "resolved") {
    return (semanticIntent.expectedDeliverables ?? []).map((d) => ({
      type: (d.type || "file") as ExpectedDeliverable["type"],
      filename: d.filename,
      description: d.description || d.filename || d.type,
    }));
  }

  if (semanticIntent?.expectedDeliverables && semanticIntent.expectedDeliverables.length > 0) {
    return semanticIntent.expectedDeliverables.map((d) => ({
      type: (d.type || "file") as ExpectedDeliverable["type"],
      filename: d.filename,
      description: d.description || d.filename || d.type,
    }));
  }

  // 2. Direct consumption of output expectation deliverables:
  if (outputExpectation?.expectedDeliverables && outputExpectation.expectedDeliverables.length > 0) {
    return outputExpectation.expectedDeliverables.map((d) => ({
      type: (d.type || "file") as ExpectedDeliverable["type"],
      filename: d.filename,
      description: d.description || d.filename || d.type,
    }));
  }

  // 3. Direct chat-only or inquiry short-circuit:
  if (
    semanticIntent?.chatResponseOnly === true ||
    (outputExpectation &&
      !outputExpectation.workspaceMutationRequested &&
      outputExpectation.expectedFiles.length === 0 &&
      isInformationalInquiry(userPrompt))
  ) {
    return [];
  }

  const deliverables: ExpectedDeliverable[] = [];
  const lowerInputs = new Set(inputFilenames.map((f) => f.toLowerCase()));
  const negatedFiles = extractNegativeFileConstraints(userPrompt);

  // If prompt is purely informational inquiry without file creation verbs:
  if (isInformationalInquiry(userPrompt)) {
    return [];
  }

  // 1. Detect explicit output filename patterns (e.g. "report.docx", "summary.xlsx", "export data.csv")
  const fileRegex = /\b([a-zA-Z0-9_\-.]+\.(?:docx|xlsx|csv|pdf|md|json))\b/gi;
  let match: RegExpExecArray | null;
  const capturedFiles = new Set<string>();

  while ((match = fileRegex.exec(userPrompt)) !== null) {
    const rawFilename = match[1];
    const filenameLower = rawFilename.toLowerCase();
    // Skip if it's an explicit input file or subject to a negative constraint
    if (lowerInputs.has(filenameLower)) continue;
    if (negatedFiles.has(filenameLower) || negatedFiles.has(path.basename(filenameLower))) continue;

    // Check if immediately preceded by input-related words or negative constraint phrases
    const matchStart = match.index;
    const precedingContext = userPrompt.slice(Math.max(0, matchStart - 35), matchStart).toLowerCase();
    if (/\b(?:from|inspect|read|parse|examine|using|check|input|explain|about|show|what)\s+(?:a\s+|an\s+|the\s+)?$/i.test(precedingContext)) continue;
    if (/\b(?:not\s+modify|not\s+touch|not\s+change|not\s+edit|not\s+create|do\s*n['o]?t|never|exclude|except|leave)\b/i.test(precedingContext)) continue;

    const ext = rawFilename.split(".").pop()?.toLowerCase();
    const type = (ext === "docx" ? "docx" : ext === "xlsx" ? "xlsx" : ext === "csv" ? "csv" : ext === "pdf" ? "pdf" : ext === "md" ? "md" : ext === "json" ? "json" : "file") as ExpectedDeliverable["type"];

    if (!capturedFiles.has(filenameLower)) {
      capturedFiles.add(filenameLower);
      deliverables.push({
        type,
        filename: rawFilename,
        description: rawFilename,
      });
    }
  }

  // 2. Detect requested deliverable categories if not already captured by explicit filename:
  // A. DOCX / Word deliverable / Approval Note
  const requestsDocx =
    !negatedFiles.has("approval-note.docx") &&
    !negatedFiles.has("report.docx") &&
    !/\b(?:do\s*n['o]?t|never)\s+(?:draft|generate|create)\s+(?:a\s+)?(?:word|docx|report|approval\s+note)\b/i.test(userPrompt) &&
    (/\b(?:draft|generate|create|produce|compile|export)\b[^.?!]*\b(?:approval\s+note|compliance\s+note|word\s+doc(?:ument)?|docx|in\s+docx)\b/i.test(userPrompt) ||
    /\b(?:as|in|into)\s+(?:a\s+)?(?:word\s+document|docx\s+file|docx)\b/i.test(userPrompt));

  const hasDocxCaptured = deliverables.some((d) => d.type === "docx");
  if (requestsDocx && !hasDocxCaptured) {
    deliverables.push({
      type: "docx",
      description: "Word document / Approval note (.docx)",
    });
  }

  // B. XLSX / Excel spreadsheet
  const requestsXlsx =
    !negatedFiles.has("workbook.xlsx") &&
    !negatedFiles.has("cleaned.xlsx") &&
    !/\b(?:do\s*n['o]?t|never)\s+(?:generate|create|produce)\s+(?:a\s+)?(?:excel|spreadsheet|xlsx|workbook)\b/i.test(userPrompt) &&
    (/\b(?:generate|create|produce|compile|export|cleaned)\b[^.?!]*\b(?:excel|spreadsheet|xlsx|workbook|in\s+xlsx)\b/i.test(userPrompt) ||
    /\b(?:as|in|into)\s+(?:an?\s+)?(?:excel\s+(?:file|sheet|spreadsheet)?|xlsx\s+file|xlsx)\b/i.test(userPrompt));

  const hasXlsxCaptured = deliverables.some((d) => d.type === "xlsx");
  if (requestsXlsx && !hasXlsxCaptured) {
    deliverables.push({
      type: "xlsx",
      description: "Excel spreadsheet (.xlsx)",
    });
  }

  // C. CSV export
  const requestsCsv =
    !negatedFiles.has("export.csv") &&
    !/\b(?:do\s*n['o]?t|never)\s+(?:export|save|generate)\s+(?:to\s+csv|as\s+csv|csv)\b/i.test(userPrompt) &&
    /\b(?:export|save|generate|create)\b[^.?!]*\b(?:csv\s+file|to\s+csv|as\s+csv)\b/i.test(userPrompt);
  const hasCsvCaptured = deliverables.some((d) => d.type === "csv");
  if (requestsCsv && !hasCsvCaptured) {
    deliverables.push({
      type: "csv",
      description: "CSV file (.csv)",
    });
  }

  return deliverables.filter((d) => {
    if (!d.filename) return true;
    const lower = d.filename.toLowerCase();
    return !negatedFiles.has(lower) && !negatedFiles.has(path.basename(lower));
  });
}

export interface CompletionWorkspaceContext {
  expectedMutations?: string[];
  actualModifiedFiles?: Set<string>;
}

export function evaluateCompletionOutcome(
  expectedDeliverables: ExpectedDeliverable[],
  producedFiles: Set<string>,
  hadErrors: boolean,
  isMaxTurnsReached: boolean,
  isCancelled: boolean,
  workspaceContext?: CompletionWorkspaceContext,
): {
  outcome: AgentOutcome;
  missingDeliverables: string[];
  producedDeliverables: string[];
  missingMutations?: string[];
  producedMutations?: string[];
} {
  if (isCancelled) {
    return { outcome: "cancelled", missingDeliverables: [], producedDeliverables: Array.from(producedFiles) };
  }
  if (isMaxTurnsReached) {
    return { outcome: "limit_exceeded", missingDeliverables: [], producedDeliverables: Array.from(producedFiles) };
  }

  // 1. Evaluate workspace mutations if expected
  const expectedMutations = workspaceContext?.expectedMutations ?? [];
  const actualModified = workspaceContext?.actualModifiedFiles ?? producedFiles;
  const producedMutations: string[] = [];
  const missingMutations: string[] = [];

  if (expectedMutations.length > 0) {
    const lowerModified = Array.from(actualModified).map((f) => f.toLowerCase());
    for (const exp of expectedMutations) {
      const expLower = exp.toLowerCase();
      const expBase = path.basename(expLower);
      const found = lowerModified.some(
        (m) => m === expLower || m === expBase || m.endsWith(`/${expBase}`) || m.endsWith(`\\${expBase}`),
      );
      if (found) {
        producedMutations.push(exp);
      } else {
        missingMutations.push(exp);
      }
    }
  }

  // 2. Evaluate expected deliverables
  const lowerProduced = Array.from(producedFiles).map((f) => ({
    raw: f,
    lower: f.toLowerCase(),
    ext: f.split(".").pop()?.toLowerCase(),
  }));

  const producedDeliverables: string[] = [];
  const missingDeliverables: string[] = [];

  for (const exp of expectedDeliverables) {
    let matched = false;
    if (exp.filename) {
      const targetLower = exp.filename.toLowerCase();
      const match = lowerProduced.find(
        (p) =>
          p.lower === targetLower ||
          p.lower.endsWith(`/${targetLower}`) ||
          p.lower.endsWith(`\\${targetLower}`),
      );
      if (match) {
        matched = true;
        producedDeliverables.push(match.raw);
      }
    } else {
      // Matched by type extension
      const match = lowerProduced.find((p) => p.ext === exp.type);
      if (match) {
        matched = true;
        producedDeliverables.push(match.raw);
      }
    }

    if (!matched) {
      missingDeliverables.push(exp.filename || exp.description);
    }
  }

  // 3. Combined outcome determination
  const totalMissing = missingDeliverables.length + missingMutations.length;
  const totalProduced = producedDeliverables.length + producedMutations.length;

  if (totalMissing === 0) {
    return {
      outcome: "completed",
      missingDeliverables,
      producedDeliverables,
      missingMutations,
      producedMutations,
    };
  }

  if (totalProduced > 0) {
    return {
      outcome: "partial",
      missingDeliverables,
      producedDeliverables,
      missingMutations,
      producedMutations,
    };
  }

  return {
    outcome: hadErrors ? "failed" : "partial",
    missingDeliverables,
    producedDeliverables,
    missingMutations,
    producedMutations,
  };
}

/**
 * Formats a tool invocation into a clean, task-based summary without dumping raw code or JSON payloads.
 */
export function formatToolActionSummary(name: string, args: any): string {
  if (!args || typeof args !== "object") {
    return `• **${name}**`;
  }

  switch (name) {
    case "execute_python": {
      const inputs = Array.isArray(args.input_files) && args.input_files.length > 0
        ? ` using \`${args.input_files.join(", ")}\``
        : "";
      return `• **execute_python**: Run sandboxed script verification${inputs}`;
    }
    case "write_file": {
      const targetPath = args.path || args.filename || "file";
      return `• **write_file**: Write \`${targetPath}\``;
    }
    case "delete_file": {
      const targetPath = args.path || args.filename || "file";
      return `• **delete_file**: Remove \`${targetPath}\``;
    }
    case "run_command": {
      const cmd = args.command ? `\`${args.command}\`` : "command";
      return `• **run_command**: ${cmd}`;
    }
    case "generate_deliverable": {
      const kind = (args.kind || args.type) ? `${String(args.kind || args.type).toUpperCase()} ` : "";
      const filename = args.filename || args.path || "deliverable";
      return `• **generate_deliverable**: Generate ${kind}artifact (\`${filename}\`)`;
    }
    case "generate_code": {
      const lang = args.language || "code";
      const target = args.filename ? ` for \`${args.filename}\`` : "";
      return `• **generate_code**: Generate ${lang}${target}`;
    }
    case "generate_text": {
      return `• **generate_text**: Compose formal deliverable text`;
    }
    default: {
      if (args.command) return `• **${name}**: \`${args.command}\``;
      if (args.path) return `• **${name}**: \`${args.path}\``;
      if (args.filename) return `• **${name}**: \`${args.filename}\``;
      const safeKeys = Object.keys(args).filter((k) => !["code", "content", "body", "text", "source"].includes(k));
      if (safeKeys.length > 0) {
        const compactObj: Record<string, unknown> = {};
        for (const k of safeKeys) compactObj[k] = args[k];
        return `• **${name}**: \`${JSON.stringify(compactObj)}\``;
      }
      return `• **${name}**`;
    }
  }
}

/**
 * Checks whether text contains substantive engineering inspection findings, analysis,
 * or full report documentation rather than a concise execution plan statement.
 */
export function isSubstantiveReportOrFindings(text: string): boolean {
  if (!text) return false;
  // If it contains inspection / report findings headers or draft document headers
  if (/###?\s+(?:Key\s+)?Findings/i.test(text)) return true;
  if (/###?\s+(?:Draft\s+)?(?:Approval\s*Note|Technical\s*Report|Deliverable|Compliance\s*Review)/i.test(text)) return true;
  // If it contains markdown tables
  if (/\|[^\n]+\|[^\n]+\|/m.test(text)) return true;
  // If it contains extensive engineering measurements / evaluation
  if (
    text.length > 200 &&
    /\b(measured|allowable|thickness|pitting|corrosion|deviation|compliant|rejection|clearance|weld|joint)\b/i.test(text)
  ) {
    return true;
  }
  // If it's overall long substantive text (genuine plan previews are concise, <= 250 chars)
  if (text.length > 300) return true;
  return false;
}

/**
 * Derives a formal, task-based N-step plan for user confirmation.
 */
export function deriveFormalPlan(
  userPrompt: string,
  mutatingCalls: any[],
  hasCompletedInChatSummary = false,
): string {
  const actionsList = mutatingCalls
    .map((c: any) => formatToolActionSummary(c.name, c.arguments))
    .join("\n");

  const cleanPrompt = userPrompt.replace(/\s+/g, " ").trim();
  const promptLower = userPrompt.toLowerCase();

  const hasDeliverable = mutatingCalls.some((c) => c.name === "generate_deliverable");

  // If in-chat technical evaluation has already been completed in chat,
  // do not present a backward "Step 1: Inspect & Analyze" plan.
  // Instead, present the pending export action directly.
  if (hasCompletedInChatSummary) {
    if (hasDeliverable) {
      const delivCall = mutatingCalls.find((c) => c.name === "generate_deliverable");
      const docName = delivCall?.arguments?.filename || delivCall?.arguments?.title || "deliverable document";
      return `### Proposed Action\nCompile and export the official deliverable document (\`${docName}\`) incorporating the findings and recommendations detailed above.\n\n### Proposed Operations\n${actionsList}`;
    }
    return `### Proposed Action\nApply verified changes to the workspace based on the technical evaluation above.\n\n### Proposed Operations\n${actionsList}`;
  }

  let objective = "";
  if (/\b(fix|repair|crash|crashing|broken|bug|error|traceback)\b/i.test(promptLower)) {
    objective = "Diagnose and repair reported script/code defects, then verify execution inside the isolated sandbox.";
  } else if (/\b(convert|migrate|refactor|typescript|ts)\b/i.test(promptLower)) {
    objective = "Perform codebase refactor and migration to target specifications with verified integrity.";
  } else if (/\b(install|deps|build|run|test|start)\b/i.test(promptLower)) {
    objective = "Execute requested environment setup and verification commands.";
  } else if (/\b(create|add|write|scaffold|implement)\b/i.test(promptLower)) {
    objective = "Implement requested application components and write required files to the workspace.";
  } else if (/\b(inspect|summarize|summary|findings|review|analyze|analysis|evaluate|check|report)\b/i.test(promptLower)) {
    objective = "Review attached inspection reports, evaluate engineering criteria, and synthesize findings.";
  } else {
    objective = cleanPrompt.length > 120 ? `${cleanPrompt.slice(0, 117)}...` : cleanPrompt;
  }

  const steps: string[] = [];
  // Step 1: Inspection / Analysis / Objective
  if (/\b(inspect|summarize|summary|findings|review|analyze|analysis|evaluate|check|report)\b/i.test(promptLower)) {
    steps.push("1. **Inspection & Analysis**: Review attached reports, data files, or workspace targets and formulate structured technical findings and evaluations in chat.");
  } else if (/\b(diagnose|fix|repair|crash|crashing|bug|error|traceback)\b/i.test(promptLower)) {
    steps.push("1. **Diagnosis & Root Cause**: Diagnose reported defects against attached datasets or workspace code.");
  } else if (/\b(convert|migrate|refactor|typescript|ts)\b/i.test(promptLower)) {
    steps.push("1. **Architecture & Scope**: Analyze existing source structure and prepare target file definitions.");
  } else if (/\b(install|deps|build|run|test|start)\b/i.test(promptLower)) {
    steps.push("1. **Environment Setup**: Prepare environment configuration and verify prerequisites.");
  } else if (/\b(create|add|write|scaffold|implement)\b/i.test(promptLower)) {
    steps.push("1. **Specification & Planning**: Review requested components and file layout.");
  } else {
    const shortPrompt = cleanPrompt.length > 100 ? `${cleanPrompt.slice(0, 97)}...` : cleanPrompt;
    steps.push(`1. **Objective**: ${shortPrompt}`);
  }

  // Step 2..N: Proposed operations from mutatingCalls
  const hasPython = mutatingCalls.some((c) => c.name === "execute_python");
  const hasWrite = mutatingCalls.some((c) => c.name === "write_file");
  const hasCommand = mutatingCalls.some((c) => c.name === "run_command");
  const hasDelete = mutatingCalls.some((c) => c.name === "delete_file");

  let stepNum = 2;
  if (hasDeliverable) {
    const delivCall = mutatingCalls.find((c) => c.name === "generate_deliverable");
    const docName = delivCall?.arguments?.filename || delivCall?.arguments?.title || "deliverable document";
    steps.push(`${stepNum++}. **Document Generation**: Compile and export formal publication-ready deliverable (\`${docName}\`).`);
  }
  if (hasPython) {
    steps.push(`${stepNum++}. **Sandbox Verification**: Execute script in isolated Python environment with test data.`);
  }
  if (hasWrite) {
    const writeFiles = mutatingCalls.filter((c) => c.name === "write_file").map((c) => c.arguments?.path || "target file");
    steps.push(`${stepNum++}. **File Updates**: Persist verified changes to ${writeFiles.slice(0, 3).map((f: string) => `\`${f}\``).join(", ")}.`);
  }
  if (hasCommand) {
    steps.push(`${stepNum++}. **Command Execution**: Run required shell environment commands.`);
  }
  if (hasDelete) {
    steps.push(`${stepNum++}. **Cleanup**: Remove obsolete workspace files.`);
  }

  return `### Objective\n${objective}\n\n### Execution Plan\n${steps.join("\n")}\n\n### Proposed Operations\n${actionsList}`;
}

/**
 * Extracts substantive engineering inspection findings or analysis from model output
 * so they can be presented directly in chat even if tools (such as document compilers)
 * execute across subsequent turns.
 */
export function extractInChatFindings(text: string): string {
  if (!text) return "";
  const cleaned = cleanPlanPreview(text);
  if (!cleaned) return "";

  // Normalize bulleted or indented markdown table rows
  const unbulleted = cleaned.replace(/(?:^|\n)\s*[-*+]\s+(\|.*\|\s*)(?=\r?\n|$)/g, "\n$1");

  // If the text is talking about code modification, script execution, or tool steps,
  // it is NOT engineering inspection report findings!
  if (
    /\b(?:code|script|python|execute_python|write_file|run_command|steps to execute|tool requests?|corrected code|explanation of changes|syntax error|indentation)\b/i.test(
      unbulleted,
    )
  ) {
    return "";
  }

  // If the model produced both findings/analysis and a separate deliverable document structure in the text:
  const documentHeaderMatch = unbulleted.search(
    /\n\s*#{1,3}\s+(?:Draft\s+)?(?:Approval\s*Note|Technical\s*Report|Deliverable|Compliance\s*Review|Official\s*Document|Executive\s*Summary)/i,
  );
  if (documentHeaderMatch > 0) {
    const beforeDoc = unbulleted.slice(0, documentHeaderMatch).trim();
    if (beforeDoc.length > 50) {
      return beforeDoc;
    }
  }

  // If the model produced a findings section:
  if (/###?\s+(?:Key\s+)?Findings/i.test(unbulleted)) {
    return unbulleted;
  }

  // If it's substantive engineering report text with markdown structure and inspection keywords:
  if (
    unbulleted.length > 120 &&
    (/#+\s+/m.test(unbulleted) || /\|[^\n]+\|[^\n]+\|/m.test(unbulleted) || /^\s*[-*]\s+/m.test(unbulleted)) &&
    !/^\s*(?:I\s+will|Let's|Now\s+let's|Sure,\s+I\s+can)\s+/i.test(unbulleted) &&
    /\b(?:inspection|findings|allowable|thickness|measured|corrosion|pitting|clearance|valve|hydrocarbon|non-compliant|compliance|deviation|weld|joint)\b/i.test(
      unbulleted,
    )
  ) {
    return unbulleted;
  }

  return "";
}

export class AgentLoop {
  async run(options: AgentLoopOptions): Promise<AgentLoopResult> {
    const {
      runId,
      driverModelId,
      userPrompt,
      systemPrompt,
      semanticIntent,
      tools,
      context,
      recentChatHistory = [],
      maxTurns = 100,
      onPlanConfirmationRequired,
      emitEvent,
    } = options;

    if (!context.emitRunEvent && emitEvent) {
      context.emitRunEvent = emitEvent;
    }

    const policyGuard = options.policyGuard ?? context.policyGuard ?? new MutationPolicyGuard();
    context.policyGuard = policyGuard;
    if (onPlanConfirmationRequired) {
      policyGuard.setEnforceExplicit(runId, true);
    }
    if (semanticIntent?.protectedPaths && semanticIntent.protectedPaths.length > 0) {
      policyGuard.setProtectedPaths(runId, semanticIntent.protectedPaths);
    }
    if (semanticIntent?.restrictMutationsToTargets) {
      policyGuard.setMutationTargetRestriction(runId, true, semanticIntent.targetFiles ?? []);
    }

    const dispatcher = new ToolDispatcher(tools);
    const toolDefinitions = dispatcher.getDefinitions();

    // Initial conversation history
    const messages: AgentMessage[] = [
      { role: "system", content: systemPrompt },
      ...recentChatHistory.slice(-6).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userPrompt },
    ];

    let turn = 0;
    let finalText = "";
    let hasExecutedTools = false;
    let hasExecutedDiskMutations = false;
    let lastExecutionHadError = false;
    let lastExecutionFailedTool: string | null = null;
    let lastErrorMessage = "";
    let lastErrorCode = "";
    const modifiedFiles = new Set<string>();
    const executedCommands: string[] = [];
    let previousCallSignature: string | null = null;
    const callHistory: string[] = [];
    let lastContent: string | null = null;
    let accumulatedInChatFindings = "";
    let assistantMessageId = randomUUID();
    const compactionHistory: CompactionMetadata[] = [];
    const emittedCompactionKeys = new Set<string>();

    const inputFilenames = options.semanticIntent?.targetFiles ?? [];
    const outputExpectation: OutputExpectation =
      options.outputExpectation ??
      options.semanticIntent?.outputExpectation ??
      determineOutputExpectation(userPrompt, {
        attachments: [],
        hasWorkspace: Boolean(context.workspaceRoot),
        semanticIntent: options.semanticIntent,
      });

    const expectedDeliverables = detectRequestedDeliverables(
      userPrompt,
      options.semanticIntent,
      inputFilenames,
      outputExpectation,
    );

    const shouldAnnouncePyScript = () =>
      outputExpectation.expectedFiles.some((f) => f.endsWith(".py") || f.toLowerCase().includes("script")) ||
      (outputExpectation.workspaceMutationRequested && Array.from(modifiedFiles).some((f) => f.endsWith(".py")));

    const buildResult = (
      resultText: string,
      outcome: AgentOutcome,
      deliverableEval?: { missingDeliverables: string[]; producedDeliverables: string[] },
    ): AgentLoopResult => ({
      finalText: resultText,
      turns: turn,
      completed: outcome === "completed",
      outcome,
      modelId: driverModelId,
      messageId: assistantMessageId,
      outputExpectation,
      deliverables: deliverableEval
        ? {
            requested: expectedDeliverables.map((d) => d.filename || d.description),
            produced: deliverableEval.producedDeliverables,
            missing: deliverableEval.missingDeliverables,
          }
        : undefined,
      metadata: {
        compactionEvents: [...compactionHistory],
        totalCompactedCount: compactionHistory.length,
      },
    });

    while (turn < maxTurns) {
      if (options.isCancelled?.()) {
        return buildResult("Run cancelled by user.", "cancelled");
      }

      turn++;

      // 1. Sliding window context compaction for turns > 2
      const activeMessages = compactConversationHistory(messages, turn, 2);

      // Emit compaction metadata to UI execution telemetry and record in execution metadata
      for (const msg of activeMessages) {
        if (msg.compaction?.truncated) {
          const compKey = `${msg.turn ?? 0}_${msg.tool_call_id || msg.role}_${msg.compaction.originalChars}`;
          if (!emittedCompactionKeys.has(compKey)) {
            emittedCompactionKeys.add(compKey);
            compactionHistory.push(msg.compaction);
            emitEvent({
              type: "context_compaction",
              runId,
              metadata: msg.compaction,
            });
          }
        }
      }

      // 2. Dispatch turn to model gateway with native tools
      // Allocate generous 4096 token budget when disk-modifying actions have already succeeded so comprehensive technical inspection and deliverable summaries are never cut off.
      // If an execution error occurred or only read tools ran, do NOT cap tokens, because the model still needs full token budget to output complete code files or multi-tool calls!
      const turnMaxTokens = (hasExecutedDiskMutations && !lastExecutionHadError) ? 4096 : undefined;

      // Stream free-text responses whenever structured output is not necessary:
      // 1) Non-actionable pure chat / informational turns or when no tools exist
      // 2) Post-tool turns (e.g. key findings after document extraction or final summaries after disk mutations)
      const isPureChatTurn =
        toolDefinitions.length === 0 ||
        semanticIntent?.isActionable === false ||
        semanticIntent?.intentType === "pure_chat" ||
        semanticIntent?.intentType === "general_qa";

      const isTurn1 = turn === 1;
      const isPostToolTurn = hasExecutedTools && !lastExecutionHadError;
      const shouldStreamLive = isPureChatTurn || isPostToolTurn || isTurn1;

      let streamedChunks: string[] = [];
      const tagFilter = shouldStreamLive
        ? new StreamingTagFilter((cleanDelta: string) => {
            streamedChunks.push(cleanDelta);
            emitEvent({
              type: "assistant_message_chunk",
              runId,
              messageId: assistantMessageId,
              delta: cleanDelta,
              modelId: driverModelId,
            });
          })
        : undefined;

      const onChunk = tagFilter ? (delta: string) => tagFilter.process(delta) : undefined;

      const turnResponse = await context.gateway.chatWithTools(
        driverModelId,
        activeMessages,
        toolDefinitions,
        {
          runId,
          temperature: 0.2,
          maxTokens: turnMaxTokens,
          onChunk,
        },
      );

      if (tagFilter) {
        tagFilter.flush();
      }

      if (!turnResponse.ok) {
        throw new Error(turnResponse.error.message);
      }

      const { content, tool_calls } = turnResponse.value;
      if (content) {
        lastContent = content;
        const findings = extractInChatFindings(content);
        if (findings) {
          accumulatedInChatFindings = findings;
          // If chunks were not streamed live to the UI, emit the findings so they appear in chat
          if (streamedChunks.length === 0) {
            emitEvent({
              type: "assistant_message_chunk",
              runId,
              messageId: assistantMessageId,
              delta: findings,
              modelId: driverModelId,
            });
          }
        } else if (turn === 1 && isSubstantiveReportOrFindings(content) && !content.includes("```")) {
          // Fallback: If turn 1 produced substantive report content, preserve it as in-chat summary
          const cleanedTurn1 = cleanPlanPreview(content);
          if (cleanedTurn1.length > 100) {
            accumulatedInChatFindings = cleanedTurn1;
          }
        }
      }

      let effectiveToolCalls: any[] | null = null;
      if (Array.isArray(tool_calls)) {
        effectiveToolCalls = tool_calls.map((c: any) => {
          const name = c.name || c.function?.name || "";
          let args = c.arguments || c.function?.arguments || {};
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              args = {};
            }
          }
          return {
            id: c.id || `call_${randomUUID().slice(0, 8)}`,
            name,
            arguments: typeof args === "object" && args !== null ? args : {},
          };
        });
      }

      // 3. Emit model thinking / scratchpad to UI if present
      if (content) {
        emitEvent({
          type: "agent_thinking",
          runId,
          text: content,
          turn,
        });
      }

      // If tool calls were returned on this turn, any streamed chunks were intermediate scratchpad UNLESS they contained substantive findings.
      // Reset the assistant message in UI only if it was scratchpad filler, so findings remain in the chat.
      if (effectiveToolCalls && effectiveToolCalls.length > 0 && streamedChunks.length > 0) {
        if (!accumulatedInChatFindings) {
          emitEvent({
            type: "assistant_message_reset",
            runId,
            messageId: assistantMessageId,
          });
          assistantMessageId = randomUUID();
          streamedChunks = [];
        }
      }

      // 4. Guardrail: If model lazily output conversational text/code without invoking tools
      // when disk mutations have NOT yet executed in this run:
      if (!hasExecutedDiskMutations && (!effectiveToolCalls || effectiveToolCalls.length === 0)) {
        const semanticTargets = semanticIntent?.targetFiles ?? [];

        // A. File creation extraction: If model provided file code blocks in current content or recent assistant messages
        if (
          !isInformationalInquiry(userPrompt) &&
          outputExpectation.workspaceMutationRequested &&
          dispatcher.getTool("write_file")
        ) {
          let extractedFiles = extractCodeBlocksWithFilenames(content ?? "", semanticTargets);
          if (extractedFiles.length === 0) {
            // Inspect recent assistant messages for code blocks that weren't persisted
            for (let i = messages.length - 1; i >= 0 && i >= messages.length - 4; i--) {
              const m = messages[i];
              if (m.role === "assistant" && typeof m.content === "string" && m.content.includes("```")) {
                const fromMsg = extractCodeBlocksWithFilenames(m.content, semanticTargets);
                if (fromMsg.length > 0) {
                  extractedFiles = fromMsg;
                  break;
                }
              }
            }
          }
          if (extractedFiles.length > 0) {
            effectiveToolCalls = extractedFiles.map((file) => ({
              id: `call_${randomUUID().slice(0, 8)}`,
              name: "write_file",
              arguments: {
                path: file.path,
                content: file.content,
              },
            }));
          }
        }

        // B. Shell command extraction: If model provided shell code blocks
        if (
          !isInformationalInquiry(userPrompt) &&
          (!effectiveToolCalls || effectiveToolCalls.length === 0) &&
          dispatcher.getTool("run_command")
        ) {
          const isCommandIntent = semanticIntent?.intentType === "command_execution";
          const extractedCmds = extractShellCommands(content ?? "");
          if (extractedCmds.length > 0 && isCommandIntent) {
            effectiveToolCalls = extractedCmds.map((cmd) => ({
              id: `call_${randomUUID().slice(0, 8)}`,
              name: "run_command",
              arguments: {
                command: cmd,
              },
            }));
          }
        }

        // C. System Nudges: If model still returned no tool calls on turn 1 despite actionable requests
        if (turn === 1 && (!effectiveToolCalls || effectiveToolCalls.length === 0)) {
          const isSemanticActionable = semanticIntent?.isActionable;
          const hasActionVerb = /\b(?:create|write|add|delete|remove|rm|fix|repair|patch|modify|update|edit|refactor|scaffold|setup|set\s*up|convert|migrate|implement|build|install|npm|run|exec|test)\b/i.test(userPrompt);
          const isCommandIntent =
            isSemanticActionable !== false &&
            (semanticIntent
              ? semanticIntent.intentType === "command_execution"
              : Boolean(dispatcher.getTool("run_command")) &&
                (!dispatcher.getTool("write_file") ||
                  /\b(?:npm|npx|run|install|test|start|build|node|exec)\b/i.test(userPrompt)));
          const isPureChat = !outputExpectation.workspaceMutationRequested && outputExpectation.expectedFiles.length === 0;
          const isSnippetOrChatQuery =
            isPureChat ||
            isInformationalInquiry(userPrompt) ||
            (/\b(?:snippet|example|sample|how\s*to|explain|explanation|walkthrough|function|query|regex|algorithm|tutorial)\b/i.test(userPrompt) &&
            semanticTargets.length === 0 &&
            !/\b(?:save|write\s+(?:it\s+)?to|create\s+(?:a\s+)?file|into\s+[\w.-]+\.\w+|workspace)\b/i.test(userPrompt));

          const hasCodeBlockContent = Boolean(content && content.includes("```"));

          const isUserWorkspaceActive = Boolean(
            context.harness?.isWorkspaceActive?.() ||
              context.harness?.currentWorkspace?.() ||
              context.harness?.getActiveWorkspace?.() ||
              (context.workspaceRoot &&
                context.workspaceRoot.length > 0 &&
                !context.workspaceRoot.includes("intermediate") &&
                !context.workspaceRoot.includes("data/runs")),
          );

          const isWorkspaceCodeTask =
            isUserWorkspaceActive ||
            semanticTargets.length > 0 ||
            /\b(?:workspace|repository|repo|directory|folder|project)\b/i.test(userPrompt);

          const isCodeIntent =
            isSemanticActionable !== false &&
            !isSnippetOrChatQuery &&
            (isWorkspaceCodeTask || !hasCodeBlockContent) &&
            semanticIntent?.intentType !== "general_qa" &&
            semanticIntent?.intentType !== "pure_chat" &&
            (semanticIntent
              ? (semanticIntent.intentType === "code_modification" && (hasActionVerb || semanticTargets.length > 0))
              : Boolean(dispatcher.getTool("write_file")) &&
                (driverModelId === "code-qwen25coder" || hasActionVerb) &&
                !isCommandIntent);

          if (isCommandIntent && dispatcher.getTool("run_command")) {
            if (streamedChunks.length > 0) {
              emitEvent({
                type: "assistant_message_reset",
                runId,
                messageId: assistantMessageId,
              });
              assistantMessageId = randomUUID();
              streamedChunks = [];
            }
            messages.push({
              role: "assistant",
              content,
              turn,
            });
            messages.push({
              role: "user",
              content: `[SYSTEM FEEDBACK]: The user requested executing commands or installing dependencies ("${userPrompt.trim()}"), but no tools were invoked. If you intend to execute these actions on disk, please invoke the \`run_command\` tool (with {"command": "..."}). All commands remain subject to workspace safety policies.`,
              turn,
            });
            continue;
          } else if (isCodeIntent && (dispatcher.getTool("execute_python") || dispatcher.getTool("write_file"))) {
            if (streamedChunks.length > 0) {
              emitEvent({
                type: "assistant_message_reset",
                runId,
                messageId: assistantMessageId,
              });
              assistantMessageId = randomUUID();
              streamedChunks = [];
            }
            messages.push({
              role: "assistant",
              content,
              turn,
            });
            const targetHint =
              semanticTargets.length > 0
                ? ` for ${semanticTargets.join(", ")}`
                : "";
            const isPythonTask =
              Boolean(dispatcher.getTool("execute_python")) &&
              (/\b(?:python|\.py|crash|crashing|script|parser|csv)\b/i.test(userPrompt) ||
                semanticTargets.some((t) => t.endsWith(".py")));
            const toolInstruction = isPythonTask
              ? `If you intend to verify the fix, invoke the native \`execute_python\` tool (with {"code": "..."}) in the sandbox.`
              : `If you intend to write or update workspace files, invoke the native \`write_file\` tool (with {"path": "relative/path/to/file", "content": "..."}).`;
            messages.push({
              role: "user",
              content: `[SYSTEM FEEDBACK]: You did not execute tools or write files to disk${targetHint}. ${toolInstruction}`,
              turn,
            });
            continue;
          } else if (
            semanticIntent?.intentType === "document_drafting" &&
            dispatcher.getTool("generate_deliverable") &&
            (content?.length ?? 0) < 120 &&
            /^(?:generating|drafting|i will|working on|processing|hold on)\b/i.test((content ?? "").trim())
          ) {
            if (streamedChunks.length > 0) {
              emitEvent({
                type: "assistant_message_reset",
                runId,
                messageId: assistantMessageId,
              });
              assistantMessageId = randomUUID();
              streamedChunks = [];
            }
            messages.push({
              role: "assistant",
              content,
              turn,
            });
            messages.push({
              role: "user",
              content: `[SYSTEM FEEDBACK]: You responded with a brief placeholder ("${(content ?? "").trim()}"), but no tools were invoked and no content was produced. If drafting an official document, invoke the native \`generate_deliverable\` tool with complete content, or provide the complete engineering evaluation directly in chat.`,
              turn,
            });
            continue;
          }
        }
      }

      // 5. Pure chat detection / completion: If no tool calls and no synthesized actions, we are done!
      if (!effectiveToolCalls || effectiveToolCalls.length === 0) {
        if (!hasExecutedDiskMutations) {
          const semanticTargets = semanticIntent?.targetFiles ?? [];



          const claimsDiskAction =
            /\b(implemented|created|updated|modified|added|written|patched|converted|migrated|refactored|configured|installed)\b/i.test(
              content ?? "",
            ) &&
            /\b(file|files|middleware|route|routes|component|server|script|code|package\.json|\.js|\.ts|\.py|\.json|typescript|codebase)\b/i.test(
              content ?? "",
            );

          // Only reject if model made a hollow claim without actually producing code or explanation
          const isMerelyEmptyClaim =
            (semanticIntent?.intentType === "code_modification" || semanticIntent?.intentType === "command_execution") &&
            claimsDiskAction &&
            !content?.includes("```") &&
            (content?.length ?? 0) < 250 &&
            !hasExecutedDiskMutations;

          if (isMerelyEmptyClaim) {
            const targetHint = semanticTargets.length > 0 ? ` for ${semanticTargets.join(", ")}` : "";
            finalText = `No files were modified on disk${targetHint}. The model did not execute file tools or output code blocks for disk persistence. Please provide the code or confirm the file target.`;
            return buildResult(finalText, "failed");
          }
        }

        finalText = cleanFinalSummary(content ?? "Task completed.", hasExecutedDiskMutations);

        if (
          hasExecutedDiskMutations &&
          modifiedFiles.size > 0 &&
          Array.from(modifiedFiles).some((f) => f.endsWith(".docx") || f.endsWith(".xlsx"))
        ) {
          const docFile = Array.from(modifiedFiles).find((f) => f.endsWith(".docx") || f.endsWith(".xlsx"));
          if (docFile && !finalText.includes(docFile) && !/official deliverable document/i.test(finalText)) {
            finalText += `\n\n📄 **The official deliverable document has been compiled and saved as [${docFile}].**`;
          }
        }

        if (
          shouldAnnouncePyScript() &&
          hasExecutedDiskMutations &&
          modifiedFiles.size > 0 &&
          Array.from(modifiedFiles).some((f) => f.endsWith(".py"))
        ) {
          const pyFile = Array.from(modifiedFiles).find((f) => f.endsWith(".py"));
          if (pyFile && !finalText.includes(pyFile)) {
            finalText += `\n\n🛠️ **The verified script has been saved as [${pyFile}].**`;
          }
        }

        if (
          accumulatedInChatFindings &&
          !finalText.includes("### Key Findings") &&
          !finalText.includes(accumulatedInChatFindings.slice(0, 40))
        ) {
          finalText = `${accumulatedInChatFindings}\n\n${finalText}`.trim();
        }

        const evalResult = evaluateCompletionOutcome(
          expectedDeliverables,
          modifiedFiles,
          lastExecutionHadError,
          false,
          false,
          {
            expectedMutations: semanticIntent?.workspaceMutationRequested ? semanticIntent.targetFiles : [],
            actualModifiedFiles: modifiedFiles,
          },
        );

        const totalMissing = [
          ...evalResult.missingDeliverables,
          ...(evalResult.missingMutations ?? []),
        ];
        if (evalResult.outcome === "partial" && totalMissing.length > 0) {
          const missingStr = totalMissing.join(", ");
          const partialNotice = `\n\n⚠️ **Notice: Execution partially completed.** The following requested item(s) were not produced/modified: ${missingStr}.`;
          if (!finalText.includes("Execution partially completed")) {
            finalText += partialNotice;
          }
        }

        // If chunks were already streamed live to the UI, check if cleanFinalSummary changed the text.
        // If cleanFinalSummary modified the text (e.g. stripped duplicate code blocks), update the UI cleanly.
        if (streamedChunks.length > 0) {
          if (finalText !== content && finalText.length > 0) {
            emitEvent({
              type: "assistant_message_reset",
              runId,
              messageId: assistantMessageId,
            });
            emitEvent({
              type: "assistant_message_chunk",
              runId,
              messageId: assistantMessageId,
              delta: finalText,
              modelId: driverModelId,
            });
          }
        } else if (finalText) {
          // If chunks were not streamed live (e.g. non-streaming transport), emit the final text
          emitEvent({
            type: "assistant_message_chunk",
            runId,
            messageId: assistantMessageId,
            delta: finalText,
            modelId: driverModelId,
          });
        }

        return buildResult(finalText, evalResult.outcome, evalResult);
      }

      // Loop detection: check if identical tool calls with identical arguments are being repeated consecutively or in alternating cycles
      const currentCallSignature = JSON.stringify(
        effectiveToolCalls.map((c: any) => ({ name: c.name, args: c.arguments })),
      );

      const isConsecutiveRepeat = previousCallSignature !== null && previousCallSignature === currentCallSignature;
      const isAlternatingCycle =
        callHistory.length >= 3 &&
        currentCallSignature === callHistory[callHistory.length - 2] &&
        callHistory[callHistory.length - 1] === callHistory[callHistory.length - 3];

      if (isConsecutiveRepeat || isAlternatingCycle) {
        if (lastExecutionHadError) {
          const modifiedList = modifiedFiles.size > 0
            ? `Files modified so far: ${Array.from(modifiedFiles).join(", ")}.`
            : "No files were modified on disk.";
          const failedToolName = lastExecutionFailedTool || effectiveToolCalls[0]?.name || "tool";
          const errDetail = lastErrorCode ? `[${lastErrorCode}] ${lastErrorMessage}` : lastErrorMessage;
          const failureSummary = `Execution stopped: The model repeatedly encountered errors invoking \`${failedToolName}\` (${errDetail}). ${modifiedList} Please check the workspace or specify the file targets.`;
          emitEvent({
            type: "error",
            runId,
            code: "tool_loop_detected",
            message: failureSummary,
          });
          return buildResult(failureSummary, "failed");
        }

        finalText = cleanFinalSummary(content ?? "Task completed.", hasExecutedDiskMutations);
        if (
          hasExecutedDiskMutations &&
          modifiedFiles.size > 0 &&
          Array.from(modifiedFiles).some((f) => f.endsWith(".docx") || f.endsWith(".xlsx"))
        ) {
          const docFile = Array.from(modifiedFiles).find((f) => f.endsWith(".docx") || f.endsWith(".xlsx"));
          if (docFile && !finalText.includes(docFile) && !/official deliverable document/i.test(finalText)) {
            finalText += `\n\n📄 **The official deliverable document has been compiled and saved as [${docFile}].**`;
          }
        }
        if (
          shouldAnnouncePyScript() &&
          hasExecutedDiskMutations &&
          modifiedFiles.size > 0 &&
          Array.from(modifiedFiles).some((f) => f.endsWith(".py"))
        ) {
          const pyFile = Array.from(modifiedFiles).find((f) => f.endsWith(".py"));
          if (pyFile && !finalText.includes(pyFile)) {
            finalText += `\n\n🛠️ **The verified script has been saved as [${pyFile}].**`;
          }
        }
        if (
          accumulatedInChatFindings &&
          !finalText.includes("### Key Findings") &&
          !finalText.includes(accumulatedInChatFindings.slice(0, 40))
        ) {
          finalText = `${accumulatedInChatFindings}\n\n${finalText}`.trim();
        }

        const evalResult = evaluateCompletionOutcome(
          expectedDeliverables,
          modifiedFiles,
          lastExecutionHadError,
          false,
          false,
        );
        if (evalResult.outcome === "partial" && evalResult.missingDeliverables.length > 0) {
          const missingStr = evalResult.missingDeliverables.join(", ");
          const partialNotice = `\n\n⚠️ **Notice: Execution partially completed.** The following requested deliverable(s) were not produced: ${missingStr}.`;
          if (!finalText.includes("Execution partially completed")) {
            finalText += partialNotice;
          }
        }
        return buildResult(finalText, evalResult.outcome, evalResult);
      }
      previousCallSignature = currentCallSignature;
      callHistory.push(currentCallSignature);
      if (callHistory.length > 8) {
        callHistory.shift();
      }

      // 6. Operation-level authorization check (P0-06 §A, §B):
      // Only pause for confirmation if there are mutating calls that are out of authorized scope
      const READ_ONLY_TOOLS = new Set([
        "read_file",
        "list_dir",
        "search",
        "retrieve_sop",
        "retrieve_knowledge",
        "extract_document",
        "ocr_extract",
        "inspect_drawing",
        "get_file_info",
      ]);

      const mutatingCalls = (effectiveToolCalls || []).filter((c: any) => !READ_ONLY_TOOLS.has(c.name));
      const unauthorizedMutatingCalls = mutatingCalls.filter((c: any) => {
        return !policyGuard.isAuthorized(runId, c.name as any, c.arguments);
      });

      if (unauthorizedMutatingCalls.length > 0) {
        if (onPlanConfirmationRequired) {
          const actionsList = unauthorizedMutatingCalls
            .map((c: any) => formatToolActionSummary(c.name, c.arguments))
            .join("\n");
          const cleanedContent = cleanPlanPreview(content ?? "");
          const isSubstantive = isSubstantiveReportOrFindings(cleanedContent);
          const hasCompletedInChatSummary = isSubstantive || Boolean(accumulatedInChatFindings);
          const planDescription =
            !isSubstantive && cleanedContent && cleanedContent.length <= 250
              ? `### Plan Overview\n${cleanedContent}\n\n### Proposed Operations\n${actionsList}`
              : deriveFormalPlan(userPrompt, unauthorizedMutatingCalls, hasCompletedInChatSummary);
          const approved = await onPlanConfirmationRequired(planDescription, unauthorizedMutatingCalls);
          if (!approved) {
            emitEvent({
              type: "error",
              runId,
              code: "action_rejected",
              message: "Action was rejected by user. Execution stopped.",
            });
            return buildResult("Action was rejected by user. Execution stopped.", "cancelled");
          }

          // Grant explicit scopes bound strictly to the approved calls and targets (P0-06 §B)
          for (const call of unauthorizedMutatingCalls) {
            const targetPath = extractPathArg(call.arguments);
            const command = extractCommandArg(call.arguments);
            policyGuard.grantScope({
              runId,
              operation: call.name as any,
              targetPath: targetPath || undefined,
              command: command || undefined,
            });
          }
        } else if (policyGuard.isEnforcingExplicit(runId)) {
          emitEvent({
            type: "error",
            runId,
            code: "action_rejected",
            message: `Mutating operation '${unauthorizedMutatingCalls[0].name}' requires authorization.`,
          });
          return buildResult(`Mutating operation '${unauthorizedMutatingCalls[0].name}' requires authorization.`, "cancelled");
        }
      }

      // 7. Record assistant's tool-calling turn
      messages.push({
        role: "assistant",
        content,
        tool_calls: effectiveToolCalls,
        turn,
      });

      // 8. Execute tool calls concurrently
      if (options.isCancelled?.()) {
        return buildResult("Run cancelled by user.", "cancelled");
      }

      context.lastAssistantContent = lastContent ?? undefined;
      const executed = await dispatcher.dispatchConcurrent(effectiveToolCalls, context);
      if (executed.length > 0) {
        hasExecutedTools = true;
        let anyError = false;
        for (const exec of executed) {
          if (!exec.result.ok) {
            anyError = true;
            lastExecutionFailedTool = exec.name;
            lastErrorMessage = exec.result.error.message;
            lastErrorCode = exec.result.error.code;
          } else {
            if (exec.name === "write_file" || exec.name === "delete_file") {
              const p = (effectiveToolCalls.find((c: any) => c.id === exec.id)?.arguments as any)?.path;
              if (p) modifiedFiles.add(p);
              hasExecutedDiskMutations = true;
            } else if (exec.name === "run_command") {
              const cmd = (effectiveToolCalls.find((c: any) => c.id === exec.id)?.arguments as any)?.command;
              if (cmd) executedCommands.push(cmd);
              hasExecutedDiskMutations = true;
            } else if (exec.name === "generate_deliverable") {
              if (Array.isArray(exec.result.artifacts) && exec.result.artifacts.length > 0) {
                hasExecutedDiskMutations = true;
                for (const art of exec.result.artifacts) {
                  if (art.filename) modifiedFiles.add(art.filename);
                }
              } else if (exec.result.ok) {
                const callArgs = (effectiveToolCalls.find((c: any) => c.id === exec.id)?.arguments as any);
                const docName = callArgs?.filename || callArgs?.path;
                if (docName) {
                  hasExecutedDiskMutations = true;
                  modifiedFiles.add(docName);
                }
              }
            } else if (exec.name === "execute_python") {
              hasExecutedDiskMutations = true;
              if (Array.isArray(exec.result.artifacts)) {
                for (const art of exec.result.artifacts) {
                  if (art.filename) modifiedFiles.add(art.filename);
                }
              }
            }
          }
        }
        lastExecutionHadError = anyError;
      }

      // 9. Record each tool's result in the conversation history
      for (const exec of executed) {
        const callObj = effectiveToolCalls?.find((c: any) => c.id === exec.id);
        const source = extractSourceArg(exec.name, callObj?.arguments ?? exec.args);
        messages.push({
          role: "tool",
          tool_call_id: exec.id,
          toolName: exec.name,
          source,
          content: exec.result.output,
          rawContent: exec.result.output,
          turn,
        });
      }
    }

    // Hit maxTurns without returning text
    const evalResult = evaluateCompletionOutcome(
      expectedDeliverables,
      modifiedFiles,
      lastExecutionHadError,
      true, // isMaxTurnsReached
      false, // isCancelled
      {
        expectedMutations: semanticIntent?.workspaceMutationRequested ? semanticIntent.targetFiles : [],
        actualModifiedFiles: modifiedFiles,
      },
    );

    let overflowText = cleanFinalSummary(
      lastContent || `Completed ${turn} operations before reaching turn limit.`,
      hasExecutedDiskMutations,
    );
    if (
      hasExecutedDiskMutations &&
      modifiedFiles.size > 0 &&
      Array.from(modifiedFiles).some((f) => f.endsWith(".docx") || f.endsWith(".xlsx"))
    ) {
      const docFile = Array.from(modifiedFiles).find((f) => f.endsWith(".docx") || f.endsWith(".xlsx"));
      if (docFile && !overflowText.includes(docFile) && !/official deliverable document/i.test(overflowText)) {
        overflowText += `\n\n📄 **The official deliverable document has been compiled and saved as [${docFile}].**`;
      }
    }
    if (
      shouldAnnouncePyScript() &&
      hasExecutedDiskMutations &&
      modifiedFiles.size > 0 &&
      Array.from(modifiedFiles).some((f) => f.endsWith(".py"))
    ) {
      const pyFile = Array.from(modifiedFiles).find((f) => f.endsWith(".py"));
      if (pyFile && !overflowText.includes(pyFile)) {
        overflowText += `\n\n🛠️ **The verified script has been saved as [${pyFile}].**`;
      }
    }
    if (
      accumulatedInChatFindings &&
      !overflowText.includes("### Key Findings") &&
      !overflowText.includes(accumulatedInChatFindings.slice(0, 40))
    ) {
      overflowText = `${accumulatedInChatFindings}\n\n${overflowText}`.trim();
    }
    overflowText += `\n\n⚠️ **Notice: Maximum execution turn limit (${maxTurns} turns) reached.** The task was halted before full completion. Work performed up to this point is preserved.`;
    return buildResult(overflowText, "limit_exceeded", evalResult);
  }
}
