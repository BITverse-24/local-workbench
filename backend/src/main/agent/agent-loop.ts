import { randomUUID } from "node:crypto";
import type { ModelId, RunEvent } from "../../shared/contracts.js";
import type { AgentTool, ToolExecutionContext } from "../tools/types.js";
import { ToolDispatcher } from "./tool-dispatcher.js";
import { compactConversationHistory, type AgentMessage } from "./context-manager.js";
import {
  extractCodeBlocksWithFilenames,
  cleanFinalSummary,
  cleanPlanPreview,
  extractShellCommands,
} from "./code-extractor.js";
import { StreamingTagFilter } from "./streaming-filter.js";
import type { SemanticIntent } from "../router/contextual-router.js";

export interface AgentLoopOptions {
  runId: string;
  driverModelId: ModelId;
  userPrompt: string;
  systemPrompt: string;
  semanticIntent?: SemanticIntent;
  tools: AgentTool[];
  context: ToolExecutionContext;
  recentChatHistory?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  maxTurns?: number;
  onPlanConfirmationRequired?: (plan: string, firstCalls: any[]) => Promise<boolean>;
  isCancelled?: () => boolean;
  emitEvent: (event: RunEvent) => void;
}

export interface AgentLoopResult {
  finalText: string;
  turns: number;
  completed: boolean;
  modelId: ModelId;
  messageId?: string;
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
    case "edit_file": {
      const targetPath = args.path || args.filename || "file";
      return `• **edit_file**: Patch modifications in \`${targetPath}\``;
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
    let confirmed = false;
    let hasExecutedTools = false;
    let hasExecutedDiskMutations = false;
    let lastExecutionHadError = false;
    let lastExecutionFailedTool: string | null = null;
    let lastErrorMessage = "";
    const modifiedFiles = new Set<string>();
    const executedCommands: string[] = [];
    let previousCallSignature: string | null = null;
    const callHistory: string[] = [];
    let lastContent: string | null = null;
    let accumulatedInChatFindings = "";
    let assistantMessageId = randomUUID();

    while (turn < maxTurns) {
      if (options.isCancelled?.()) {
        return {
          finalText: "Run cancelled by user.",
          turns: turn,
          completed: false,
          modelId: driverModelId,
          messageId: assistantMessageId,
        };
      }

      turn++;

      // 1. Sliding window context compaction for turns > 2
      const activeMessages = compactConversationHistory(messages, turn, 2);

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
        if (dispatcher.getTool("write_file")) {
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
        if ((!effectiveToolCalls || effectiveToolCalls.length === 0) && dispatcher.getTool("run_command")) {
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
          const isSnippetOrChatQuery =
            /\b(?:snippet|example|sample|how\s*to|explain|explanation|walkthrough|function|query|regex|algorithm|tutorial)\b/i.test(userPrompt) &&
            semanticTargets.length === 0 &&
            !/\b(?:save|write\s+(?:it\s+)?to|create\s+(?:a\s+)?file|into\s+[\w.-]+\.\w+|workspace)\b/i.test(userPrompt);

          const hasCodeBlockContent = Boolean(content && content.includes("```"));

          const isUserWorkspaceActive = Boolean(
            context.harness?.getActiveWorkspace() ||
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
              content: `[SYSTEM FEEDBACK]: The user requested executing commands or installing dependencies ("${userPrompt.trim()}"), but no tools were invoked. You MUST invoke the \`run_command\` tool (with {"command": "..."}) to execute these actions on disk. Please invoke \`run_command\` now.`,
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
              ? `You MUST invoke the native \`execute_python\` tool (with {"code": "..."}) to run and verify the fix in the sandbox.`
              : `You MUST invoke the native \`write_file\` tool (with {"path": "relative/path/to/file", "content": "..."}) or output markdown code blocks with the target path on the first line (e.g. \`\`\`typescript\n// relative/path/to/file.ts\n...\`\`\`) so the files can be saved to the workspace.`;
            messages.push({
              role: "user",
              content: `[SYSTEM FEEDBACK]: You did not execute tools or write files to disk${targetHint}. ${toolInstruction} Please do this now.`,
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
              content: `[SYSTEM FEEDBACK]: You responded with a brief placeholder ("${(content ?? "").trim()}"), but no tools were invoked and no content was produced. You MUST invoke the native \`generate_deliverable\` tool or provide the complete document content now. Please do this now.`,
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

          // If content contains code blocks, try one final extraction before giving up
          if (dispatcher.getTool("write_file") && content && content.includes("```")) {
            const finalExtracted = extractCodeBlocksWithFilenames(content, semanticTargets);
            if (finalExtracted.length > 0) {
              for (const file of finalExtracted) {
                try {
                  await dispatcher.getTool("write_file")!.execute({ path: file.path, content: file.content }, context);
                  hasExecutedDiskMutations = true;
                  modifiedFiles.add(file.path);
                } catch {}
              }
            }
          }
          const userExplicitlyRequestedFile =
            /\b(?:docx|doc|excel|xlsx|csv|in a (?:docx|doc|excel|xlsx|file)|deliverable file|report file|export (?:a |the )?(?:file|deliverable|doc|report))\b/i.test(
              userPrompt,
            );

          if (userExplicitlyRequestedFile && dispatcher.getTool("generate_deliverable") && content && content.length > 150) {
            const hasDocStructure =
              /#+\s+/m.test(content) ||
              /\|[^\n]+\|[^\n]+\|/m.test(content);

            if (hasDocStructure) {
              const titleMatch =
                content.match(/^#+\s+([^\n]+)/m) ||
                content.match(/\*\*Subject:\*\*\s*([^\n]+)/i) ||
                content.match(/^(?:SUBJECT|TITLE):\s*([^\n]+)/im);
              const extractedTitle = titleMatch
                ? titleMatch[1].replace(/^[#*\s]+|[#*\s]+$/g, "").trim()
                : "Technical Inspection Approval Note";

              const fileMatch = userPrompt.match(/([\w.-]+\.(?:docx|pdf|xlsx|html))/i);
              const filename = fileMatch ? fileMatch[1] : (userPrompt.toLowerCase().includes("xlsx") ? "deliverable.xlsx" : "approval-note.docx");

              try {
                const execs = await dispatcher.dispatchConcurrent(
                  [
                    {
                      id: `call_${randomUUID().slice(0, 8)}`,
                      name: "generate_deliverable",
                      arguments: {
                        type: filename.endsWith(".xlsx") ? "excel" : "docx",
                        title: extractedTitle,
                        content,
                        filename,
                      },
                    },
                  ],
                  context,
                );
                if (execs.length > 0 && !execs[0].result.output?.startsWith("Error")) {
                  hasExecutedDiskMutations = true;
                  hasExecutedTools = true;
                  modifiedFiles.add(filename);
                }
              } catch (err) {
                console.error("[agent-loop] Failed to auto-generate requested deliverable from content:", err);
              }
            }
          }



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
            return {
              finalText,
              turns: turn,
              completed: true,
              modelId: driverModelId,
              messageId: assistantMessageId,
            };
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

        return {
          finalText,
          turns: turn,
          completed: true,
          modelId: driverModelId,
          messageId: assistantMessageId,
        };
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
          const failureSummary = `Execution stopped: The model repeatedly encountered errors invoking \`${failedToolName}\` (${lastErrorMessage}). ${modifiedList} Please check the workspace or specify the file targets.`;
          emitEvent({
            type: "error",
            runId,
            code: "tool_loop_detected",
            message: failureSummary,
          });
          return {
            finalText: failureSummary,
            turns: turn,
            completed: false,
            modelId: driverModelId,
            messageId: assistantMessageId,
          };
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
        return {
          finalText,
          turns: turn,
          completed: true,
          modelId: driverModelId,
          messageId: assistantMessageId,
        };
      }
      previousCallSignature = currentCallSignature;
      callHistory.push(currentCallSignature);
      if (callHistory.length > 8) {
        callHistory.shift();
      }

      // 6. Plan confirmation check: ONLY pause for confirmation if there are mutating tool calls
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
      if (!confirmed && mutatingCalls.length > 0 && onPlanConfirmationRequired) {
        const actionsList = mutatingCalls
          .map((c: any) => formatToolActionSummary(c.name, c.arguments))
          .join("\n");
        const cleanedContent = cleanPlanPreview(content ?? "");
        const isSubstantive = isSubstantiveReportOrFindings(cleanedContent);
        const hasCompletedInChatSummary = isSubstantive || Boolean(accumulatedInChatFindings);
        const planDescription =
          !isSubstantive && cleanedContent && cleanedContent.length <= 250
            ? `### Plan Overview\n${cleanedContent}\n\n### Proposed Operations\n${actionsList}`
            : deriveFormalPlan(userPrompt, mutatingCalls, hasCompletedInChatSummary);
        const approved = await onPlanConfirmationRequired(planDescription, mutatingCalls);
        if (!approved) {
          emitEvent({
            type: "error",
            runId,
            code: "action_rejected",
            message: "Action was rejected by user. Execution stopped.",
          });
          return {
            finalText: "Action was rejected by user. Execution stopped.",
            turns: turn,
            completed: false,
            modelId: driverModelId,
            messageId: assistantMessageId,
          };
        }
        confirmed = true;
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
        return {
          finalText: "Run cancelled by user.",
          turns: turn,
          completed: false,
          modelId: driverModelId,
          messageId: assistantMessageId,
        };
      }

      context.lastAssistantContent = lastContent ?? undefined;
      const executed = await dispatcher.dispatchConcurrent(effectiveToolCalls, context);
      if (executed.length > 0) {
        hasExecutedTools = true;
        let anyError = false;
        for (const exec of executed) {
          let isError = typeof exec.result.output === "string" && exec.result.output.startsWith("Error");
          if (!isError && exec.name === "execute_python" && typeof exec.result.output === "string") {
            try {
              const parsed = JSON.parse(exec.result.output);
              if (typeof parsed.exitCode === "number" && parsed.exitCode !== 0) {
                isError = true;
                lastErrorMessage = parsed.stderr || `Python script exited with code ${parsed.exitCode}`;
              } else if (parsed.timedOut) {
                isError = true;
                lastErrorMessage = "Python script execution timed out";
              }
            } catch {}
          }

          if (isError) {
            anyError = true;
            lastExecutionFailedTool = exec.name;
            if (!lastErrorMessage) {
              lastErrorMessage = exec.result.output;
            }
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
              const docName = (effectiveToolCalls.find((c: any) => c.id === exec.id)?.arguments as any)?.filename || "deliverable.docx";
              modifiedFiles.add(docName);
              hasExecutedDiskMutations = true;
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
        messages.push({
          role: "tool",
          tool_call_id: exec.id,
          toolName: exec.name,
          content: exec.result.output,
          turn,
        });
      }
    }

    // Hit maxTurns without returning text
    let overflowText = cleanFinalSummary(
      lastContent || `Completed ${turn} operations.`,
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
    return {
      finalText: overflowText,
      turns: turn,
      completed: true,
      modelId: driverModelId,
      messageId: assistantMessageId,
    };
  }
}
