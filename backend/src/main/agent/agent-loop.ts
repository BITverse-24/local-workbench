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
      const kind = args.kind ? `${String(args.kind).toUpperCase()} ` : "";
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
 * Derives a formal, task-based plan when the model did not supply clean plan text.
 */
export function deriveFormalPlan(userPrompt: string, mutatingCalls: any[]): string {
  const actionsList = mutatingCalls
    .map((c: any) => formatToolActionSummary(c.name, c.arguments))
    .join("\n");

  const promptLower = userPrompt.toLowerCase();
  let objective = "";
  if (/\b(fix|repair|crash|crashing|broken|bug|error|traceback)\b/i.test(promptLower)) {
    objective = "Diagnose and repair reported script/code defects, then verify execution inside the isolated sandbox.";
  } else if (/\b(convert|migrate|refactor|typescript|ts)\b/i.test(promptLower)) {
    objective = "Perform codebase refactor and migration to target specifications with verified integrity.";
  } else if (/\b(install|deps|build|run|test|start)\b/i.test(promptLower)) {
    objective = "Execute requested environment setup and verification commands.";
  } else if (/\b(create|add|write|scaffold|implement)\b/i.test(promptLower)) {
    objective = "Implement requested application components and write required files to the workspace.";
  } else {
    const cleanPrompt = userPrompt.replace(/\s+/g, " ").trim();
    objective = cleanPrompt.length > 120 ? `${cleanPrompt.slice(0, 117)}...` : cleanPrompt;
  }

  return `### Objective\n${objective}\n\n### Proposed Operations\n${actionsList}`;
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
      // If an execution error occurred or only read tools ran, do NOT cap tokens, because the model still needs full token budget to output complete code files or multi-tool calls!
      const turnMaxTokens = (hasExecutedDiskMutations && !lastExecutionHadError) ? 350 : undefined;

      // Stream free-text responses whenever structured output is not necessary:
      // 1) Non-actionable pure chat / informational turns or when no tools exist
      const isPureChatTurn =
        toolDefinitions.length === 0 ||
        semanticIntent?.isActionable === false ||
        semanticIntent?.intentType === "pure_chat" ||
        semanticIntent?.intentType === "general_qa";

      let bufferedChunks: string[] = [];
      const onChunk = isPureChatTurn
        ? (delta: string) => {
            emitEvent({
              type: "assistant_message_chunk",
              runId,
              messageId: assistantMessageId,
              delta,
              modelId: driverModelId,
            });
          }
        : (hasExecutedDiskMutations && !lastExecutionHadError)
        ? (delta: string) => {
            bufferedChunks.push(delta);
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
          const isCodeIntent =
            isSemanticActionable !== false &&
            semanticIntent?.intentType !== "general_qa" &&
            semanticIntent?.intentType !== "pure_chat" &&
            (semanticIntent
              ? (semanticIntent.intentType === "code_modification" && (hasActionVerb || semanticTargets.length > 0))
              : Boolean(dispatcher.getTool("write_file")) &&
                (driverModelId === "code-qwen25coder" || hasActionVerb) &&
                !isCommandIntent);

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
          } else if (isCodeIntent && (dispatcher.getTool("execute_python") || dispatcher.getTool("write_file"))) {
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

          const claimsDiskAction =
            /\b(implemented|created|updated|modified|added|written|patched|converted|migrated|refactored|configured|installed)\b/i.test(
              content ?? "",
            ) &&
            /\b(file|files|middleware|route|routes|component|server|script|code|package\.json|\.js|\.ts|\.py|\.json|typescript|codebase)\b/i.test(
              content ?? "",
            );

          // Only reject if model made a hollow claim without actually producing code or explanation
          const isMerelyEmptyClaim =
            claimsDiskAction &&
            !content?.includes("```") &&
            (content?.length ?? 0) < 150 &&
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

        // If chunks were buffered during this summary turn, emit them now (or emit the cleaned summary)
        if (bufferedChunks.length > 0) {
          if (finalText === content) {
            for (const chunk of bufferedChunks) {
              emitEvent({
                type: "assistant_message_chunk",
                runId,
                messageId: assistantMessageId,
                delta: chunk,
                modelId: driverModelId,
              });
            }
          } else {
            emitEvent({
              type: "assistant_message_chunk",
              runId,
              messageId: assistantMessageId,
              delta: finalText,
              modelId: driverModelId,
            });
          }
        }

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
        const planDescription = cleanedContent
          ? `### Plan Overview\n${cleanedContent}\n\n### Proposed Operations\n${actionsList}`
          : deriveFormalPlan(userPrompt, mutatingCalls);
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
