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
import {
  hasActionVerb,
  hasContainerNoun,
  hasCommandActionVerb,
  hasCommandTargetNoun,
  normalizeTokens,
} from "../router/intent-classifier.js";

export interface AgentLoopOptions {
  runId: string;
  driverModelId: ModelId;
  userPrompt: string;
  systemPrompt: string;
  tools: AgentTool[];
  context: ToolExecutionContext;
  recentChatHistory?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  maxTurns?: number;
  devWorkload?: boolean;
  onPlanConfirmationRequired?: (plan: string, firstCalls: any[]) => Promise<boolean>;
  emitEvent: (event: RunEvent) => void;
}

export interface AgentLoopResult {
  finalText: string;
  turns: number;
  completed: boolean;
  modelId: ModelId;
}

export class AgentLoop {
  async run(options: AgentLoopOptions): Promise<AgentLoopResult> {
    const {
      runId,
      driverModelId,
      userPrompt,
      systemPrompt,
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
    let previousCallSignature: string | null = null;
    let lastContent: string | null = null;

    while (turn < maxTurns) {
      turn++;

      // 1. Sliding window context compaction for turns > 2
      const activeMessages = compactConversationHistory(messages, turn, 2);

      // 2. Dispatch turn to model gateway with native tools
      const turnResponse = await context.gateway.chatWithTools(
        driverModelId,
        activeMessages,
        toolDefinitions,
        {
          runId,
          temperature: 0.2,
          devWorkload,
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
      // when the user requested creating files, setting up projects, or running commands/tests:
      // CRITICAL: Only synthesize tool calls or nudge if tools have NOT yet executed in this run!
      // Once tools have executed, any subsequent text without tool calls is the model's completion summary!
      if (!hasExecutedTools && (!effectiveToolCalls || effectiveToolCalls.length === 0)) {
        // A. File creation extraction: If model provided file code blocks
        if (dispatcher.getTool("write_file")) {
          const extractedFiles = extractCodeBlocksWithFilenames(content ?? "");
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

        // B. Shell command extraction: If model provided shell code blocks for an execution/install request
        if ((!effectiveToolCalls || effectiveToolCalls.length === 0) && dispatcher.getTool("run_command")) {
          const extractedCmds = extractShellCommands(content ?? "");
          const promptTokens = normalizeTokens(userPrompt);
          const promptLower = userPrompt.toLowerCase();
          const isCmdReq =
            hasCommandActionVerb(promptLower, promptTokens) ||
            hasCommandTargetNoun(promptLower, promptTokens);

          if (extractedCmds.length > 0 && isCmdReq) {
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
        if ((!effectiveToolCalls || effectiveToolCalls.length === 0) && turn === 1) {
          const promptTokens = normalizeTokens(userPrompt);
          const promptLower = userPrompt.toLowerCase();
          const combinedLower = promptLower + " " + (content ?? "").toLowerCase();
          const combinedTokens = normalizeTokens(combinedLower);

          const isCommandRequest =
            Boolean(dispatcher.getTool("run_command")) &&
            (hasCommandActionVerb(promptLower, promptTokens) ||
              hasCommandTargetNoun(promptLower, promptTokens));

          const hasUserAction = hasActionVerb(promptLower, promptTokens);
          const hasContentAction =
            /\b(created|implemented|added|written|generated|modified|updated|edited|patched)\b/i.test(
              content ?? "",
            );
          const hasContainer = hasContainerNoun(combinedLower, combinedTokens);

          const isFileCreationRequest =
            Boolean(dispatcher.getTool("write_file")) &&
            (hasUserAction || hasContentAction) &&
            hasContainer;

          if (isCommandRequest) {
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
          } else if (isFileCreationRequest) {
            messages.push({
              role: "assistant",
              content,
              turn,
            });
            messages.push({
              role: "user",
              content: `[SYSTEM FEEDBACK]: You provided code or conversational text, but did not execute tools. DO NOT dump code in chat or output pseudo CLI commands. You MUST invoke the native \`write_file\` tool (with {"path": "relative/path/to/file", "content": "..."}) to write files directly to disk. Please call \`write_file\` now.`,
              turn,
            });
            continue;
          }
        }
      }

      // 5. Pure chat detection / completion: If no tool calls and no synthesized actions, we are done!
      if (!effectiveToolCalls || effectiveToolCalls.length === 0) {
        finalText = cleanFinalSummary(content ?? "Task completed.", hasExecutedTools);
        return {
          finalText,
          turns: turn,
          completed: true,
          modelId: driverModelId,
        };
      }

      // Loop detection: check if identical tool calls with identical arguments are being repeated consecutively
      const currentCallSignature = JSON.stringify(
        effectiveToolCalls.map((c: any) => ({ name: c.name, args: c.arguments })),
      );
      if (previousCallSignature && previousCallSignature === currentCallSignature) {
        finalText = cleanFinalSummary(content ?? "Task completed.", hasExecutedTools);
        return {
          finalText,
          turns: turn,
          completed: true,
          modelId: driverModelId,
        };
      }
      previousCallSignature = currentCallSignature;

      // 6. Single-gate confirmation check on turn 1
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
      const executed = await dispatcher.dispatchConcurrent(effectiveToolCalls, context);
      if (executed.length > 0) {
        hasExecutedTools = true;
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
      hasExecutedTools,
    );
    return {
      finalText: overflowText,
      turns: turn,
      completed: true,
      modelId: driverModelId,
    };
  }
}
