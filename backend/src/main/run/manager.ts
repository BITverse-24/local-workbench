import { randomUUID } from "node:crypto";
import { createChat } from "../persistence/chats.js";
import { addMessage } from "../persistence/messages.js";
import { getDb } from "../persistence/db.js";
import type {
  AttachmentReference,
  ChatModelRequest,
  CodeModelRequest,
  CodeSummarizeRequest,
  ModelResponse,
  PendingAction,
  RunEvent,
  RunState,
} from "../../shared/contracts.js";
import { ModelGateway, requestBase } from "../gateway/model-gateway.js";
import { CODE_SYSTEM_PROMPT } from "./prompts.js";
import { createRun, getState, listRuns, recordError, recordRouting, transition } from "./store.js";
import {
  absoluteDataPath,
  createRunDirectories,
  registerAttachment as saveAttachment,
  writeRunFile,
} from "./filesystem.js";
import { createConfirmation, cancelPending, decide } from "../confirmation/store.js";
import { routeTask } from "../router/deterministic-router.js";
import {
  validateChat,
  validateCode,
  validateCodeSummary,
  validationMessage,
} from "../validators/responses.js";
import { executePython } from "../tools/python.js";
import { generateXlsx } from "../tools/artifacts.js";

type AttachmentRow = AttachmentReference & { runId: string; chatId: string };
type Continuation = () => Promise<void>;
export interface RegisterAttachmentInput {
  chatId?: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  base64OrBuffer: string | Buffer;
}
export interface StartRunInput {
  userText: string;
  attachmentToken?: string;
  runId?: string;
  chatId?: string;
}
export interface ConfirmInput {
  runId: string;
  actionId: string;
  approved: boolean;
}
export class RunManager {
  private readonly attachments = new Map<string, AttachmentRow>();
  private readonly continuations = new Map<string, Continuation>();
  constructor(
    private readonly gateway = new ModelGateway(),
    private readonly emit: (event: RunEvent) => void = () => undefined,
  ) {}
  registerAttachment(input: RegisterAttachmentInput): {
    runId: string;
    attachment: AttachmentReference;
  } {
    const chatId = input.chatId ?? createChat("Attachment run");
    const runId = createRun(chatId, `Attachment: ${input.filename}`);
    createRunDirectories(runId);
    const attachment = saveAttachment(runId, input);
    this.attachments.set(attachment.attachmentId, { ...attachment, runId, chatId });
    const db = getDb();
    db.prepare(
      "INSERT INTO attachments(attachment_id, chat_id, run_id, filename, media_type, size_bytes, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      attachment.attachmentId,
      chatId,
      runId,
      attachment.filename,
      attachment.mediaType,
      attachment.sizeBytes,
      attachment.relativePath,
      new Date().toISOString(),
    );
    db.prepare("UPDATE runs SET attachment_id=? WHERE id=?").run(attachment.attachmentId, runId);
    return { runId, attachment };
  }
  async start(input: StartRunInput): Promise<{ runId: string }> {
    const text = input.userText ?? "";
    if (text.length > 8000 || /(?:^[A-Za-z]:[\\/]|^\/|\\.\.)/.test(text) || (!text.trim() && !input.attachmentToken))
      throw new Error("invalid run input");
    const attachment = input.attachmentToken ? this.attachment(input.attachmentToken) : undefined;
    const effectiveChatId = input.chatId ?? attachment?.chatId ?? createChat("New run");
    const runId = input.runId ?? attachment?.runId ?? createRun(effectiveChatId, input.userText);
    createRunDirectories(runId);
    void this.execute(runId, input.userText, attachment).catch((error) => this.fail(runId, error));
    return { runId };
  }
  async confirm(input: ConfirmInput): Promise<void> {
    try {
      decide(input.runId, input.actionId, input.approved);
      const continuation = this.continuations.get(input.actionId);
      if (!continuation) throw new Error("confirmation continuation not found");
      this.continuations.delete(input.actionId);
      await continuation();
    } catch (error) {
      this.fail(input.runId, error);
      throw error;
    }
  }
  cancel(runId: string): void {
    if (["completed", "failed", "cancelled"].includes(getState(runId))) return;
    cancelPending(runId);
    transition(runId, "cancelled");
    this.emit({ type: "run_state", runId, state: "cancelled" });
  }
  history(limit?: number) {
    return listRuns(limit);
  }
  artifact(runId: string, artifactId: string) {
    const row = getDb()
      .prepare(
        "SELECT artifact_id as artifactId, run_id as runId, kind, filename, relative_path as relativePath, size_bytes as sizeBytes, created_at as createdAt FROM artifacts WHERE artifact_id=? AND run_id=?",
      )
      .get(artifactId, runId);
    if (!row) throw new Error("artifact not found");
    return row;
  }
  async health() {
    return this.gateway.health();
  }
  private attachment(token: string): AttachmentRow {
    const cached = this.attachments.get(token);
    if (cached) return cached;
    const row = getDb()
      .prepare(
        "SELECT attachment_id as attachmentId, chat_id as chatId, run_id as runId, filename, media_type as mediaType, size_bytes as sizeBytes, relative_path as relativePath FROM attachments WHERE attachment_id=?",
      )
      .get(token) as AttachmentRow | undefined;
    if (!row) throw new Error("attachment token not found");
    this.attachments.set(token, row);
    return row;
  }
  private state(runId: string, state: RunState) {
    transition(runId, state);
    this.emit({ type: "run_state", runId, state });
  }
  private route(runId: string, text: string, attachment?: AttachmentRow) {
    const route = routeTask(text, attachment);
    const requestId = randomUUID();
    recordRouting(runId, requestId, route.taskType, route.modelId, route.reason);
    this.emit({ type: "routing", runId, ...route });
    return route;
  }
  private tool(runId: string, tool: unknown, summary: string) {
    this.emit({ type: "tool_call", runId, tool: tool as never, summary });
  }
  private result(runId: string, tool: unknown, summary: string) {
    this.emit({ type: "tool_result", runId, tool: tool as never, summary });
  }
  private chatIdForRun(runId: string): string {
    const row = getDb().prepare("SELECT chat_id as chatId FROM runs WHERE id=?").get(runId) as
      | { chatId: string }
      | undefined;
    if (!row) throw new Error("run not found");
    return row.chatId;
  }
  private persistAssistant(runId: string, text: string, modelId: string): string {
    const chatId = this.chatIdForRun(runId);
    const { id } = addMessage({ chat_id: chatId, role: "assistant", content: text, run_id: runId, model_id: modelId });
    this.emit({ type: "assistant_message", runId, messageId: id, text, modelId: modelId as never });
    return id;
  }
  private async execute(runId: string, text: string, attachment?: AttachmentRow): Promise<void> {
    this.state(runId, "classifying");
    const route = this.route(runId, text, attachment);
    this.state(runId, "planning");
    this.emit({
      type: "plan_step",
      runId,
      index: 0,
      text:
        route.taskType === "vision"
          ? "Extract the inspection findings and ground an approval note."
          : route.taskType === "code"
            ? "Generate and verify a Python data transformation."
            : "Draft a response.",
    });
    this.state(runId, "acting");
    if (route.taskType === "vision") throw new Error("vision flow is deferred in this build");
    if (route.taskType === "code" && attachment) return this.flowB(runId, text, attachment);
    if (route.taskType === "draft") return this.flowDraft(runId, text);
    throw new Error("an attachment is required for the locked flow");
  }
  private async flowDraft(runId: string, text: string): Promise<void> {
    this.tool(runId, "draft_note", "drafting response");
    const base = requestBase(runId, "draft", "draft-qwen3", "chat-result", "You are a helpful assistant. Respond concisely with a JSON object shaped {\"text\": string}.", text, 45000, 1024);
    const request: ChatModelRequest = {
      ...base,
      taskType: "draft",
      modelId: "draft-qwen3",
      responseFormat: "chat-result",
    };
    const response = await this.gateway.execute(request);
    if (!response.ok) throw new Error(response.error.message);
    const chat = validateChat((response.value as ModelResponse).result);
    if (!chat.ok) throw new Error(validationMessage("chat reply", chat.error));
    this.result(runId, "draft_note", "draft validated");
    this.persistAssistant(runId, chat.value.text, "draft-qwen3");
    this.complete(runId);
  }
  private async flowB(runId: string, text: string, attachment: AttachmentRow): Promise<void> {
    this.tool(runId, "read_file", "reading CSV attachment");
    const csv = Buffer.from(await (await import("node:fs/promises")).readFile(absoluteDataPath(attachment.relativePath))).toString("utf8");
    const rows = csv.trim().split(/\r?\n/).length - 1;
    this.result(runId, "read_file", `${rows} CSV rows read`);
    const base = requestBase(runId, "code", "code-qwen25coder", "code-result", CODE_SYSTEM_PROMPT, text, 60000, 4096);
    const request: CodeModelRequest = {
      ...base,
      taskType: "code",
      modelId: "code-qwen25coder",
      responseFormat: "code-result",
      task: text,
      inputFile: {
        attachmentId: attachment.attachmentId,
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        rowCount: rows,
      },
      allowedLanguage: "python",
      executionRules: ["task.py only", "no network", "no shell", "read input and write output only"],
    };
    const response = await this.gateway.execute(request);
    if (!response.ok) throw new Error(response.error.message);
    const code = validateCode((response.value as ModelResponse).result);
    if (!code.ok) throw new Error(validationMessage("generated code", code.error));
    writeRunFile(runId, "intermediate", "task.py", code.value.source);
    await this.awaitConfirmation(runId, "execute_python", async () => {
      const execution = await executePython(runId, code.value.source, [attachment.filename]);
      getDb()
        .prepare(
          "INSERT OR REPLACE INTO execution_results(run_id, exit_code, timed_out, duration_ms, stdout_capped, stderr_capped, output_files) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          runId,
          execution.exitCode,
          execution.timedOut ? 1 : 0,
          execution.durationMs,
          execution.stdout,
          execution.stderr,
          JSON.stringify(execution.outputFiles),
        );
      if (
        execution.exitCode !== 0 ||
        execution.timedOut ||
        !/OUT_OF_RANGE\s+7\/240\s+\(high=5,\s+low=2\)/.test(execution.stdout)
      )
        throw new Error("execution result did not verify the locked expected output");
      this.result(runId, "execute_python", "verified OUT_OF_RANGE 7/240 (high=5, low=2)");
      await this.awaitConfirmation(runId, "generate_xlsx", async () => {
        const artifact = await generateXlsx(runId, execution);
        this.persistArtifact(artifact as never);
        this.emit({ type: "artifact_ready", runId, artifact: artifact as never });
        const summaryBase = requestBase(
          runId,
          "code",
          "code-qwen25coder",
          "code-summary",
          "Summarize only actual execution results. Return the summary as a single JSON object.",
          text,
          60000,
          1024,
        );
        const summaryRequest: CodeSummarizeRequest = {
          ...summaryBase,
          taskType: "code",
          modelId: "code-qwen25coder",
          responseFormat: "code-summary",
          phase: "summarize",
          task: text,
          execution,
        };
        const summary = await this.gateway.execute(summaryRequest);
        if (!summary.ok) throw new Error(summary.error.message);
        const summaryResult = validateCodeSummary((summary.value as ModelResponse).result);
        if (!summaryResult.ok || !summaryResult.value.verified) throw new Error(summaryResult.ok ? "execution summary failed validation" : validationMessage("execution summary", summaryResult.error));
        this.persistAssistant(runId, (summaryResult.value as { summary: string }).summary, "code-qwen25coder");
        this.complete(runId);
      });
    });
  }
  private async awaitConfirmation(
    runId: string,
    kind: PendingAction["kind"],
    continuation: Continuation,
  ): Promise<void> {
    const action = createConfirmation(runId, kind);
    this.continuations.set(action.actionId, continuation);
    this.state(runId, "awaiting_confirmation");
    this.emit({ type: "confirmation_required", runId, action });
  }
  private complete(runId: string) {
    this.state(runId, "completed");
  }
  private fail(runId: string, error: unknown) {
    try {
      if (["completed", "cancelled", "failed"].includes(getState(runId))) return;
      const message = error instanceof Error ? error.message : "run failed";
      recordError(runId, "invalid_model_response", message);
      transition(runId, "failed");
      this.emit({ type: "error", runId, code: "invalid_model_response", message, retryable: false });
    } catch {}
  }
  private persistArtifact(artifact: {
    artifactId: string;
    runId: string;
    kind: string;
    filename: string;
    relativePath: string;
    sizeBytes: number;
    createdAt: string;
  }) {
    getDb()
      .prepare(
        "INSERT INTO artifacts(artifact_id, run_id, kind, filename, relative_path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(artifact.artifactId, artifact.runId, artifact.kind, artifact.filename, artifact.relativePath, artifact.sizeBytes, artifact.createdAt);
  }
}
