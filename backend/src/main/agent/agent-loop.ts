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
  devWorkload?: boolean;
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
      devWorkload = false,
      onPlanConfirmationRequired,
      emitEvent,
    } = options;

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
    let lastErrorMessage = "";
    const modifiedFiles = new Set<string>();
    const executedCommands: string[] = [];
    let previousCallSignature: string | null = null;
    let lastContent: string | null = null;
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
      // Only cap maxTokens to 350 when disk-modifying actions have already succeeded and the model is formulating its final summary.
      // If only inspection/read tools (search, read_file) ran, do NOT cap tokens, because the model still needs full token budget to output complete code files or multi-tool calls!
      const turnMaxTokens = hasExecutedDiskMutations ? 350 : undefined;

      // Stream free-text responses whenever structured output is not necessary:
      // 1) Post-disk mutation turns (final summary)
      // 2) Non-actionable pure chat / informational turns or when no tools exist
      const isFreeTextTurn =
        hasExecutedDiskMutations ||
        toolDefinitions.length === 0 ||
        semanticIntent?.isActionable === false ||
        semanticIntent?.intentType === "pure_chat" ||
        semanticIntent?.intentType === "general_qa";

      const onChunk = isFreeTextTurn
        ? (delta: string) => {
            emitEvent({
              type: "assistant_message_chunk",
              runId,
              messageId: assistantMessageId,
              delta,
              modelId: driverModelId,
            });
          }
        : undefined;

      const turnResponse = await context.gateway.chatWithTools(
        driverModelId,
        activeMessages,
        toolDefinitions,
        {
          runId,
          temperature: 0.2,
          maxTokens: turnMaxTokens,
          devWorkload,
          onChunk,
        },
      );

      if (!turnResponse.ok) {
        throw new Error(turnResponse.error.message);
      }

      const { content, tool_calls } = turnResponse.value;
      if (content) {
        lastContent = content;
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

      let effectiveToolCalls: any[] | null = tool_calls;

      // 4. Guardrail: If model lazily output conversational text/code without invoking tools
      // when disk mutations have NOT yet executed in this run:
      if (!hasExecutedDiskMutations && (!effectiveToolCalls || effectiveToolCalls.length === 0)) {
        // A. File creation extraction: If model provided file code blocks in current content or recent assistant messages
        if (dispatcher.getTool("write_file")) {
          let extractedFiles = extractCodeBlocksWithFilenames(content ?? "");
          if (extractedFiles.length === 0) {
            // Inspect recent assistant messages for code blocks that weren't persisted
            for (let i = messages.length - 1; i >= 0 && i >= messages.length - 4; i--) {
              const m = messages[i];
              if (m.role === "assistant" && typeof m.content === "string" && m.content.includes("```")) {
                const fromMsg = extractCodeBlocksWithFilenames(m.content);
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
          const semanticTargets = semanticIntent?.targetFiles ?? [];
          const isCommandIntent =
            semanticIntent
              ? semanticIntent.intentType === "command_execution"
              : Boolean(dispatcher.getTool("run_command")) &&
                (!dispatcher.getTool("write_file") ||
                  /\b(?:npm|npx|run|install|test|start|build|node|exec)\b/i.test(userPrompt));
          const isCodeIntent =
            semanticIntent
              ? semanticIntent.intentType === "code_modification" ||
                (isSemanticActionable && semanticTargets.length > 0)
              : Boolean(dispatcher.getTool("write_file")) &&
                (driverModelId === "code-qwen25coder" || !isCommandIntent);

          if (isCommandIntent && dispatcher.getTool("run_command")) {
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
          } else if (isCodeIntent && dispatcher.getTool("write_file")) {
            messages.push({
              role: "assistant",
              content,
              turn,
            });
            const targetHint =
              semanticTargets.length > 0
                ? ` for ${semanticTargets.join(", ")}`
                : "";
            messages.push({
              role: "user",
              content: `[SYSTEM FEEDBACK]: You did not execute tools or write files to disk${targetHint}. You MUST invoke the native \`write_file\` tool (with {"path": "relative/path/to/file", "content": "..."}) or output markdown code blocks with the target path on the first line (e.g. \`\`\`typescript\n// relative/path/to/file.ts\n...\`\`\`) so the files can be saved to the workspace. Please do this now.`,
              turn,
            });
            continue;
          }
        }
      }

      // 5. Pure chat detection / completion: If no tool calls and no synthesized actions, we are done!
      if (!effectiveToolCalls || effectiveToolCalls.length === 0) {
        if (!hasExecutedDiskMutations) {
          const isSemanticActionable = semanticIntent?.isActionable;
          const semanticTargets = semanticIntent?.targetFiles ?? [];

          const claimsDiskAction =
            /\b(implemented|created|updated|modified|added|written|patched|converted|migrated|refactored|configured|installed)\b/i.test(
              content ?? "",
            ) &&
            /\b(file|files|middleware|route|routes|component|server|script|code|package\.json|\.js|\.ts|\.py|\.json|typescript|codebase)\b/i.test(
              content ?? "",
            );

          const isActionRequest =
            semanticIntent
              ? isSemanticActionable ||
                semanticIntent.intentType === "code_modification" ||
                semanticIntent.intentType === "command_execution"
              : driverModelId === "code-qwen25coder" && toolDefinitions.length > 0;

          if (claimsDiskAction || (isActionRequest && semanticTargets.length > 0)) {
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
        return {
          finalText,
          turns: turn,
          completed: true,
          modelId: driverModelId,
          messageId: assistantMessageId,
        };
      }

      // Loop detection: check if identical tool calls with identical arguments are being repeated consecutively
      const currentCallSignature = JSON.stringify(
        effectiveToolCalls.map((c: any) => ({ name: c.name, args: c.arguments })),
      );
      if (previousCallSignature && previousCallSignature === currentCallSignature) {
        if (lastExecutionHadError) {
          const modifiedList = modifiedFiles.size > 0
            ? `Files modified so far: ${Array.from(modifiedFiles).join(", ")}.`
            : "No files were modified on disk.";
          const failureSummary = `Execution stopped: The model repeatedly encountered errors invoking \`${effectiveToolCalls[0]?.name}\` (${lastErrorMessage}). ${modifiedList} Please check the workspace or specify the file targets.`;
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
        return {
          finalText,
          turns: turn,
          completed: true,
          modelId: driverModelId,
          messageId: assistantMessageId,
        };
      }
      previousCallSignature = currentCallSignature;

      // 6. Single-gate plan confirmation check on turn 1
      if (turn === 1 && !confirmed && onPlanConfirmationRequired) {
        const actionsList = effectiveToolCalls
          .map((c: any) => {
            const detail = c.arguments?.command
              ? `\`${c.arguments.command}\``
              : c.arguments?.path
              ? `\`${c.arguments.path}\``
              : Object.keys(c.arguments || {}).length > 0
              ? `\`${JSON.stringify(c.arguments)}\``
              : "";
            return detail ? `• **${c.name}**: ${detail}` : `• **${c.name}**`;
          })
          .join("\n");
        const cleanedContent = cleanPlanPreview(content ?? "");
        const planDescription = cleanedContent
          ? `${cleanedContent}\n\n**Proposed Operations**:\n${actionsList}`
          : `**Proposed Operations**:\n${actionsList}`;
        const approved = await onPlanConfirmationRequired(planDescription, effectiveToolCalls);
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

      // If tools are being dispatched, ensure subsequent summary turn gets a fresh messageId
      assistantMessageId = randomUUID();

      const executed = await dispatcher.dispatchConcurrent(effectiveToolCalls, context);
      if (executed.length > 0) {
        hasExecutedTools = true;
        let anyError = false;
        for (const exec of executed) {
          const isError = typeof exec.result.output === "string" && exec.result.output.startsWith("Error");
          if (isError) {
            anyError = true;
            lastErrorMessage = exec.result.output;
          } else {
            if (exec.name === "write_file" || exec.name === "delete_file") {
              const p = (effectiveToolCalls.find((c: any) => c.id === exec.id)?.arguments as any)?.path;
              if (p) modifiedFiles.add(p);
              hasExecutedDiskMutations = true;
            } else if (exec.name === "run_command") {
              const cmd = (effectiveToolCalls.find((c: any) => c.id === exec.id)?.arguments as any)?.command;
              if (cmd) executedCommands.push(cmd);
              hasExecutedDiskMutations = true;
            } else if (exec.name === "generate_deliverable" || exec.name === "execute_python") {
              hasExecutedDiskMutations = true;
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
    const overflowText = cleanFinalSummary(
      lastContent || `Completed ${turn} operations.`,
      hasExecutedDiskMutations,
    );
    return {
      finalText: overflowText,
      turns: turn,
      completed: true,
      modelId: driverModelId,
      messageId: assistantMessageId,
    };
  }
}
