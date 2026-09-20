import { randomUUID } from "node:crypto";
import type { ModelId, RunEvent } from "../../shared/contracts.js";
import type { AgentTool, ToolExecutionContext } from "../tools/types.js";
import { ToolDispatcher } from "./tool-dispatcher.js";
import { compactConversationHistory, type AgentMessage } from "./context-manager.js";
import { extractCodeBlocksWithFilenames } from "./code-extractor.js";

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
      maxTurns = 12,
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
      // when the user requested creating or setting up files in the workspace:
      if ((!effectiveToolCalls || effectiveToolCalls.length === 0) && dispatcher.getTool("write_file")) {
        const extracted = extractCodeBlocksWithFilenames(content ?? "");
        if (extracted.length > 0) {
          effectiveToolCalls = extracted.map((file) => ({
            id: `call_${randomUUID().slice(0, 8)}`,
            name: "write_file",
            arguments: {
              path: file.path,
              content: file.content,
            },
          }));
        } else if (
          turn === 1 &&
          /\b(create|write|setup|set up|scaffold|build|make|add|generate|init|initialize)\b/i.test(userPrompt) &&
          /\b(file|files|app|application|project|code|server|api|repo|directory|folder|script|express|react|node|python)\b/i.test(userPrompt)
        ) {
          // Nudge model to invoke write_file
          messages.push({
            role: "assistant",
            content,
            turn,
          });
          messages.push({
            role: "user",
            content: `[SYSTEM FEEDBACK]: You answered with conversational instructions or text, but the user requested creating or setting up files in the workspace. No files were written to disk. You MUST invoke the \`write_file\` tool (with {"path": "relative/path/to/file", "content": "..."}) for each file to create them on disk. Please call \`write_file\` now.`,
            turn,
          });
          continue;
        }
      }

      // 5. Pure chat detection: If no tool calls and no synthesized actions, we are done!
      if (!effectiveToolCalls || effectiveToolCalls.length === 0) {
        finalText = content ?? "Task completed.";
        return {
          finalText,
          turns: turn,
          completed: true,
          modelId: driverModelId,
        };
      }

      // 6. Single-gate confirmation check on turn 1
      if (turn === 1 && !confirmed && onPlanConfirmationRequired) {
        const planDescription = content || `Executing ${effectiveToolCalls.length} initial actions.`;
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

      // 8. Record each tool's result in the conversation history
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
    const overflowText = `Completed ${maxTurns} operations. Reached maximum turn limit.`;
    return {
      finalText: overflowText,
      turns: turn,
      completed: true,
      modelId: driverModelId,
    };
  }
}
