import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AIResult,
  AgentToolCall,
  AgentToolDefinition,
  AgentTurnResponse,
  ModelHealth,
  ModelId,
  ModelRegistryEntry,
  ModelRequest,
  ModelResponse,
} from "../../shared/contracts.js";
import type { ModelClient } from "../models/ports.js";
import {
  defaultLocalRegistry,
  isDevOpenRouterActive,
  loadDevOpenRouterRegistry,
  loadProductionRegistryFromDb,
  loadProductionRegistryEntriesFromDb,
  loadRegistry,
  resolveModel,
} from "./registry.js";
import { normalizeResponse, parseProviderContent, providerError } from "./normalizer.js";
import { absoluteDataPath, createRunDirectories, runRoot } from "../run/filesystem.js";
import { assertUploadableSize, createPlaceholderImagesFromText, extractPdfText, extractSvgText, prepareImage, renderPdfToImages } from "../run/images.js";
import {
  logGatewayError,
  logGeneratedCode,
  logModelRequest,
  logModelResponse,
  logModelSummary,
  logVisionFindings,
} from "../logger.js";

function gatewayConsole(level: "log" | "warn" | "error", request: { requestId: string; runId: string; taskType: string; modelId: string }, message: string, extra?: unknown) {
  const prefix = `[model-gateway:${request.taskType}:${request.modelId}:${request.requestId.slice(0, 8)}]`;
  const line = extra !== undefined ? `${prefix} ${message} ${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 4000)}` : `${prefix} ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function persistGatewayTrace(runId: string, requestId: string, entry: Record<string, unknown>) {
  try {
    createRunDirectories(runId);
    const root = runRoot(runId);
    const logsDir = path.join(root, "logs");
    mkdirSync(logsDir, { recursive: true });
    const payload = { timestamp: new Date().toISOString(), requestId, runId, ...entry };
    // Full JSON per-request file — never truncated, contains everything the model returned.
    const perRequestPath = path.join(logsDir, `model-${(entry["taskType"] as string) ?? "unknown"}-${requestId}.json`);
    try {
      writeFileSync(perRequestPath, JSON.stringify(payload, null, 2), { flag: "w" });
    } catch {
      // fallback to append if write fails due to wx semantics elsewhere
      writeFileSync(perRequestPath, JSON.stringify(payload, null, 2));
    }
    // JSONL audit trail — one line per trace event for easy tailing.
    const auditPath = path.join(logsDir, "model-gateway.log");
    appendFileSync(auditPath, `${JSON.stringify(payload)}\n`);
  } catch (e) {
    console.warn(`[model-gateway] failed to persist trace for ${requestId}:`, e instanceof Error ? e.message : String(e));
  }
}

export interface GatewayTransport {
  request(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    timeoutMs: number,
  ): Promise<{ status: number; text(): Promise<string> }>;

  streamRequest?(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    timeoutMs: number,
    onChunk: (delta: string) => void,
  ): Promise<{ status: number; text(): Promise<string> }>;
}

const nativeTransport: GatewayTransport = {
  async request(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  },

  async streamRequest(url, init, timeoutMs, onChunk) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status < 200 || response.status >= 300 || !response.body) {
        return response;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let accumulatedText = "";
      const accumulatedToolCalls: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }> = [];
      let finishReason: string | null = null;
      let usage: any = undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;
            if (trimmed === "data: [DONE]") continue;
            if (trimmed.startsWith("data: ")) {
              const jsonStr = trimmed.slice(6);
              try {
                const parsed = JSON.parse(jsonStr);
                if (parsed.usage) {
                  usage = parsed.usage;
                }
                const choice = parsed.choices?.[0];
                if (choice) {
                  if (choice.finish_reason) {
                    finishReason = choice.finish_reason;
                  }
                  const delta = choice.delta;
                  if (delta) {
                    if (typeof delta.content === "string" && delta.content.length > 0) {
                      accumulatedText += delta.content;
                      onChunk(delta.content);
                    }
                    if (Array.isArray(delta.tool_calls)) {
                      for (const tc of delta.tool_calls) {
                        const idx = typeof tc.index === "number" ? tc.index : accumulatedToolCalls.length;
                        if (!accumulatedToolCalls[idx]) {
                          accumulatedToolCalls[idx] = {
                            id: tc.id ?? `call_${idx}`,
                            type: tc.type ?? "function",
                            function: {
                              name: tc.function?.name ?? "",
                              arguments: tc.function?.arguments ?? "",
                            },
                          };
                        } else {
                          if (tc.id) accumulatedToolCalls[idx].id = tc.id;
                          if (tc.type) accumulatedToolCalls[idx].type = tc.type;
                          if (tc.function?.name) {
                            accumulatedToolCalls[idx].function.name += tc.function.name;
                          }
                          if (tc.function?.arguments) {
                            accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                          }
                        }
                      }
                    }
                  }
                }
              } catch {
                // Incomplete or malformed SSE line, skip
              }
            }
          }
        }
      } catch (streamErr: any) {
        if (streamErr.name === "AbortError") throw streamErr;
      }

      const messageObj: Record<string, any> = {
        role: "assistant",
        content: accumulatedText.length > 0 ? accumulatedText : (accumulatedToolCalls.length > 0 ? null : ""),
      };
      if (accumulatedToolCalls.length > 0) {
        messageObj.tool_calls = accumulatedToolCalls;
      }

      const syntheticEnvelope = JSON.stringify({
        choices: [
          {
            message: messageObj,
            finish_reason: finishReason ?? (accumulatedToolCalls.length > 0 ? "tool_calls" : "stop"),
          },
        ],
        usage,
      });

      return {
        status: response.status,
        async text() {
          return syntheticEnvelope;
        },
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
/**
 * Normalizes conversation history into strictly compliant OpenAI / OpenRouter messages format.
 *
 * Requirements for native tools:
 * 1. role: "system" | "user" | "assistant" | "tool"
 * 2. assistant messages:
 *    - content: string or null
 *    - tool_calls?: Array<{
 *        id: string;
 *        type: "function";
 *        function: {
 *          name: string;
 *          arguments: string; // Must be JSON-stringified
 *        };
 *      }>
 * 3. tool messages:
 *    - role: "tool"
 *    - tool_call_id: string
 *    - content: string
 * 4. Strips internal metadata: `turn`, `toolName`, `args`, etc.
 */
export function formatMessagesForNativeTools(
  messages: Array<{ role: string; content?: any; tool_calls?: any[]; tool_call_id?: string; [key: string]: any }>,
): Array<Record<string, any>> {
  return messages.map((m) => {
    if (m.role === "assistant") {
      const formatted: Record<string, any> = {
        role: "assistant",
        content: typeof m.content === "string" && m.content.trim().length > 0 ? m.content : null,
      };

      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        formatted.tool_calls = m.tool_calls.map((tc: any) => {
          if (tc.type === "function" && tc.function && typeof tc.function.name === "string") {
            return {
              id: String(tc.id ?? randomUUID()),
              type: "function",
              function: {
                name: tc.function.name,
                arguments:
                  typeof tc.function.arguments === "string"
                    ? tc.function.arguments
                    : JSON.stringify(tc.function.arguments ?? {}),
              },
            };
          }

          return {
            id: String(tc.id ?? randomUUID()),
            type: "function",
            function: {
              name: String(tc.name ?? tc.function?.name ?? "unknown"),
              arguments:
                typeof tc.arguments === "string"
                  ? tc.arguments
                  : JSON.stringify(tc.arguments ?? tc.function?.arguments ?? {}),
            },
          };
        });
      }

      return formatted;
    }

    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: String(m.tool_call_id ?? ""),
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      };
    }

    return {
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    };
  });
}

/**
 * Normalizes messages for providers or models where `tools` parameter is rejected or unsupported.
 * Converts `tool` role messages to `user` role results, and assistant tool_calls to text.
 */
export function formatMessagesForFallback(
  messages: Array<{ role: string; content?: any; tool_calls?: any[]; tool_call_id?: string; toolName?: string; [key: string]: any }>,
  systemPromptAddition: string,
): Array<Record<string, any>> {
  return messages.map((m, idx) => {
    if (idx === 0 && m.role === "system") {
      return {
        role: "system",
        content: `${m.content ?? ""}${systemPromptAddition}`,
      };
    }

    if (m.role === "assistant") {
      let content = typeof m.content === "string" ? m.content : "";
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const calls = m.tool_calls.map((tc: any) => ({
          name: tc.name ?? tc.function?.name,
          arguments: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : (tc.arguments ?? tc.function?.arguments ?? {}),
        }));
        content = content
          ? `${content}\n${JSON.stringify({ tool_calls: calls })}`
          : JSON.stringify({ content: null, tool_calls: calls });
      }
      return {
        role: "assistant",
        content,
      };
    }

    if (m.role === "tool") {
      const toolIdentifier = m.toolName || m.tool_call_id || "tool";
      return {
        role: "user",
        content: `[Tool Result for ${toolIdentifier}]:\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")}`,
      };
    }

    return {
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    };
  });
}
 
export function parseToolCallArguments(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return {};

  const str = raw.trim();
  if (!str) return {};

  // 1. Direct standard JSON.parse
  try {
    const parsed = JSON.parse(str);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    if (typeof parsed === "string" && parsed.trim().startsWith("{")) {
      const doubleParsed = JSON.parse(parsed.trim());
      if (typeof doubleParsed === "object" && doubleParsed !== null && !Array.isArray(doubleParsed)) {
        return doubleParsed;
      }
    }
  } catch {}

  // 2. Repair raw newlines and tabs inside string literals (common when LLMs emit code inside JSON)
  try {
    const repaired = str.replace(/"((?:\\.|[^"\\])*)"/gs, (match) => {
      return match.replace(/\r\n|\n|\r/g, "\\n").replace(/\t/g, "\\t");
    });
    const parsed = JSON.parse(repaired);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}

  // 3. Regex extraction of key fields if JSON is truncated or has syntax flaws
  const result: Record<string, unknown> = { raw: str };
  const pathMatch = str.match(/["']?(?:path|filePath|file_path|filename|fileName|file|target)["']?\s*:\s*["']([^"'\r\n]+)["']/i);
  if (pathMatch && pathMatch[1]) {
    result.path = pathMatch[1].trim();
  }

  const contentMatch = str.match(/["']?(?:content|code|body|fileContent|text)["']?\s*:\s*["']([\s\S]*?)(?:["']\s*(?:,\s*["']|\})|$)/);
  if (contentMatch && contentMatch[1]) {
    result.content = contentMatch[1]
      .replace(/["']\s*\}?\s*$/, "")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  }

  const commandMatch = str.match(/["']?(?:command|cmd|shell_command|script|exec)["']?\s*:\s*["']([^"'\r\n]+)["']/i);
  if (commandMatch && commandMatch[1]) {
    result.command = commandMatch[1].trim();
  }

  const queryMatch = str.match(/["']?(?:query|search_query|pattern)["']?\s*:\s*["']([^"'\r\n]+)["']/i);
  if (queryMatch && queryMatch[1]) {
    result.query = queryMatch[1].trim();
  }

  return result;
}

export function extractEmbeddedToolCalls(rawContent: string): { toolCalls: AgentToolCall[]; cleanedContent: string | null } {
  const toolCalls: AgentToolCall[] = [];
  let cleaned = rawContent;

  // 1. Match <tool_call>...</tool_call> blocks (common in Qwen 2.5 Coder, Hermes, etc.)
  const xmlPattern = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = xmlPattern.exec(rawContent)) !== null) {
    const jsonCandidate = match[1].trim();
    try {
      const parsed = JSON.parse(jsonCandidate);
      if (parsed && typeof parsed.name === "string") {
        const args = parseToolCallArguments(parsed.arguments ?? parsed.parameters ?? {});
        toolCalls.push({
          id: parsed.id || `call_${randomUUID().slice(0, 8)}`,
          name: parsed.name,
          arguments: args,
        });
      }
    } catch {
      // Try repair / extraction directly on candidate string
      const args = parseToolCallArguments(jsonCandidate);
      const nameMatch = jsonCandidate.match(/["']?name["']?\s*:\s*["']([^"'\r\n]+)["']/i);
      if (nameMatch && nameMatch[1]) {
        toolCalls.push({
          id: `call_${randomUUID().slice(0, 8)}`,
          name: nameMatch[1].trim(),
          arguments: args,
        });
      }
    }
  }

  if (toolCalls.length > 0) {
    cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim();
    return { toolCalls, cleanedContent: cleaned.length > 0 ? cleaned : null };
  }

  // 2. Match JSON object with name & arguments or tool_calls
  const trimmed = rawContent.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.name === "string" && (parsed.arguments || parsed.parameters)) {
        const args = parseToolCallArguments(parsed.arguments ?? parsed.parameters ?? {});
        toolCalls.push({
          id: parsed.id || `call_${randomUUID().slice(0, 8)}`,
          name: parsed.name,
          arguments: args,
        });
        return { toolCalls, cleanedContent: null };
      } else if (Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          if (tc && typeof tc.name === "string") {
            const args = parseToolCallArguments(tc.arguments ?? tc.parameters ?? {});
            toolCalls.push({
              id: tc.id || `call_${randomUUID().slice(0, 8)}`,
              name: tc.name,
              arguments: args,
            });
          }
        }
        if (toolCalls.length > 0) {
          const c = parsed.content ? String(parsed.content).trim() : null;
          return { toolCalls, cleanedContent: c && c.length > 0 ? c : null };
        }
      }
    } catch {}
  }

  return { toolCalls: [], cleanedContent: rawContent };
}

export interface VisionUploadInfo { originalBytes: number; finalBytes: number; resized: boolean; mediaType: string; }
export class ModelGateway implements ModelClient {
  readonly dbRegistry: Map<string, ModelRegistryEntry>;
  readonly devRegistry: Map<string, ModelRegistryEntry>;
  private readonly endpointPool = new Map<string, ModelRegistryEntry[]>();
  private roundRobinCounter = 0;
  private devModeOverride: boolean | null = null;
  externalRequestCount = 0;
  lastVisionUpload?: VisionUploadInfo;

  constructor(
    private readonly transport: GatewayTransport = nativeTransport,
    initialRegistry?: Map<string, ModelRegistryEntry> | ModelRegistryEntry[],
    devRegistry?: Map<string, ModelRegistryEntry>,
  ) {
    this.dbRegistry = new Map();
    try {
      this.devRegistry = devRegistry ?? (loadDevOpenRouterRegistry() as Map<string, ModelRegistryEntry>);
    } catch {
      this.devRegistry = new Map();
    }

    if (initialRegistry) {
      this.updateRegistry(initialRegistry);
    } else {
      const entries = loadProductionRegistryEntriesFromDb();
      this.updateRegistry(entries);
    }
  }

  /**
   * Register multiple instances / endpoints for a given model ID (worker pool).
   */
  registerModelInstances(modelId: ModelId | string, instances: ModelRegistryEntry[]): void {
    if (!instances || instances.length === 0) return;
    this.endpointPool.set(modelId, instances);
    // Keep primary in dbRegistry for backward compatibility
    this.dbRegistry.set(modelId, instances[0]);
  }

  /**
   * Get all registered worker instances for a given model ID.
   */
  getModelInstances(modelId: ModelId | string): ModelRegistryEntry[] {
    return this.endpointPool.get(modelId) ?? (this.registry.has(modelId) ? [this.registry.get(modelId)!] : []);
  }

  /**
   * Select next healthy endpoint for the requested model using round-robin load balancing.
   */
  resolveNextEndpoint(modelId: ModelId | string, isDev = false): ModelRegistryEntry | undefined {
    const activeRegistry = isDev && this.devRegistry.size > 0 ? this.devRegistry : this.dbRegistry;
    if (isDev) {
      return activeRegistry.get(modelId) ?? this.dbRegistry.get(modelId);
    }

    const instances = this.endpointPool.get(modelId);
    if (instances && instances.length > 0) {
      const enabledInstances = instances.filter((inst) => inst.enabled);
      if (enabledInstances.length > 0) {
        const selected = enabledInstances[this.roundRobinCounter % enabledInstances.length];
        this.roundRobinCounter++;
        return selected;
      }
    }

    return activeRegistry.get(modelId);
  }

  private rebuildEndpointPool(): void {
    this.endpointPool.clear();
    for (const [id, entry] of this.dbRegistry.entries()) {
      if (!this.endpointPool.has(id)) {
        this.endpointPool.set(id, [entry]);
      }
    }
  }

  get registry(): Map<string, ModelRegistryEntry> {
    return this.isDevRoutingActive() ? this.devRegistry : this.dbRegistry;
  }

  setDevMode(enabled: boolean | null): void {
    this.devModeOverride = enabled;
  }

  isDevRoutingActive(request?: ModelRequest): boolean {
    if (request?.devWorkload !== undefined) return request.devWorkload;
    if (this.devModeOverride !== null) return this.devModeOverride;
    return isDevOpenRouterActive();
  }

  /** Dynamically replace production DB registry entries in memory without requiring application restart. */
  updateRegistry(entries: ModelRegistryEntry[] | Map<string, ModelRegistryEntry>): void {
    this.dbRegistry.clear();
    this.endpointPool.clear();

    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!this.dbRegistry.has(entry.id)) {
          this.dbRegistry.set(entry.id, entry);
        }
        const list = this.endpointPool.get(entry.id) ?? [];
        list.push(entry);
        this.endpointPool.set(entry.id, list);
      }
    } else {
      for (const [k, v] of entries) {
        this.dbRegistry.set(k, v);
        this.endpointPool.set(k, [v]);
      }
    }
  }

  updateDbRegistry(entries: ModelRegistryEntry[] | Map<string, ModelRegistryEntry>): void {
    this.updateRegistry(entries);
  }

  /** `ModelClient` surface: delegates to `execute`. */
  async complete(request: ModelRequest): Promise<AIResult<ModelResponse>> {
    return this.execute(request);
  }

  async execute(request: ModelRequest): Promise<AIResult<ModelResponse>> {
    const isDev = this.isDevRoutingActive(request);
    let model: ModelRegistryEntry | undefined = this.resolveNextEndpoint(request.modelId, isDev);
    if (!model) {
      const activeRegistry = isDev && this.devRegistry.size > 0 ? this.devRegistry : this.dbRegistry;
      try {
        model = resolveModel(activeRegistry as Map<any, ModelRegistryEntry>, request.modelId, request.taskType);
      } catch {
        if (isDev && this.dbRegistry.has(request.modelId)) {
          try {
            model = resolveModel(this.dbRegistry as Map<any, ModelRegistryEntry>, request.modelId, request.taskType);
          } catch {
            return { ok: false, error: { kind: "ai-error", code: "model_unavailable", message: "configured model is unavailable", retryable: false, requestId: request.requestId, runId: request.runId, taskType: request.taskType, modelId: request.modelId } };
          }
        } else {
          return { ok: false, error: { kind: "ai-error", code: "model_unavailable", message: "configured model is unavailable", retryable: false, requestId: request.requestId, runId: request.runId, taskType: request.taskType, modelId: request.modelId } };
        }
      }
    }

    if (isDev) {
      gatewayConsole("log", request, `DEV WORKLOAD: Dispatching to OpenRouter (${model.model} at ${model.baseUrl})`);
    } else {
      gatewayConsole("log", request, `DB ENDPOINT: Dispatching to ${model.baseUrl} (${model.model}, role: ${request.taskType})`);
    }

    const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
    if (model.runtime === "openrouter" && !key) return { ok: false, error: { kind: "ai-error", code: "model_rejected_request", message: `missing environment credential ${model.apiKeyEnv}`, retryable: false, requestId: request.requestId, runId: request.runId, taskType: request.taskType, modelId: request.modelId } };
    const maybeVision = request as unknown as { taskType: string; attachment?: { mediaType: string; relativePath: string; filename?: string; selectedPages?: number[] } };
    const isVision = maybeVision.taskType === "vision" && !!maybeVision.attachment;
    // PDFs are now parsed into per-page compressed JPEGs (1024px max edge, JPEG 80)
    // and sent as multiple image_url parts to keep total tokens <4096.
    // 2 pages at 1024px = ~3072 image tokens + ~524 prompt = ~3596 < 4096.
    // Images are still downscaled via prepareImage; PDFs previously went as
    // file parts and blew up server-side rasterization token count.
    this.lastVisionUpload = undefined;
    const visionParts = isVision
      ? await (async () => {
          const att = maybeVision.attachment!;
          const raw = await readFile(absoluteDataPath(att.relativePath));
          if (att.mediaType === "image/svg+xml" || att.filename?.toLowerCase().endsWith(".svg")) {
            const svgText = extractSvgText(raw);
            const placeholderImages = await createPlaceholderImagesFromText(svgText || "SVG Vector Drawing");
            const prepared = placeholderImages[0];
            assertUploadableSize(prepared.finalBytes);
            this.lastVisionUpload = {
              originalBytes: raw.length,
              finalBytes: prepared.finalBytes,
              resized: true,
              mediaType: prepared.mediaType,
            };
            return [
              {
                type: "image_url",
                image_url: { url: `data:${prepared.mediaType};base64,${prepared.buffer.toString("base64")}` },
              },
            ];
          }
          if (att.mediaType.startsWith("image/")) {
            const prepared = await prepareImage(raw, att.mediaType);
            assertUploadableSize(prepared.finalBytes);
            this.lastVisionUpload = {
              originalBytes: prepared.originalBytes,
              finalBytes: prepared.finalBytes,
              resized: prepared.resized,
              mediaType: prepared.mediaType,
            };
            return [
              {
                type: "image_url",
                image_url: { url: `data:${prepared.mediaType};base64,${prepared.buffer.toString("base64")}` },
              },
            ];
          }
          if (att.mediaType === "application/pdf") {
            const pdfImages = await renderPdfToImages(raw, att.selectedPages);
            if (pdfImages.length) {
              const parts = [];
              let totalBytes = 0;
              for (const prepared of pdfImages) {
                assertUploadableSize(prepared.finalBytes);
                totalBytes += prepared.finalBytes;
                parts.push({
                  type: "image_url",
                  image_url: { url: `data:${prepared.mediaType};base64,${prepared.buffer.toString("base64")}` },
                });
              }
              // Track aggregate for logging (first page stats as representative)
              this.lastVisionUpload = {
                originalBytes: raw.length,
                finalBytes: totalBytes,
                resized: true,
                mediaType: "image/jpeg",
              };
              return parts;
            }
            // Fallback: PDF -> image(s) -> compress -> vision (agreed). No file upload.
            // If pdfjs/canvas not available, render PDF text as synthetic compressed JPEG(s).
            const pdfText = extractPdfText(raw);
            if (pdfText.trim().length > 20) {
              const { createPlaceholderImagesFromText } = await import("../run/images.js");
              const placeholders = await createPlaceholderImagesFromText(pdfText);
              if (placeholders.length) {
                const parts = [];
                let totalBytes = 0;
                for (const p of placeholders) {
                  assertUploadableSize(p.finalBytes);
                  totalBytes += p.finalBytes;
                  parts.push({
                    type: "image_url",
                    image_url: { url: `data:${p.mediaType};base64,${p.buffer.toString("base64")}` },
                  });
                }
                this.lastVisionUpload = {
                  originalBytes: raw.length,
                  finalBytes: totalBytes,
                  resized: true,
                  mediaType: "image/jpeg",
                };
                // Keep text in prompt as well - vision model sees both image + text
                const enrichedPrompt = `${(request as { userPrompt: string }).userPrompt}\n\n[PDF rendered locally as compressed image(s) - ${placeholders.length} page(s)]\n${pdfText.slice(0, 2000)}`;
                (request as { userPrompt: string }).userPrompt = enrichedPrompt;
                return parts;
              }
              // Last resort: text-only enrichment with tiny placeholder to keep image_url type
              this.lastVisionUpload = {
                originalBytes: raw.length,
                finalBytes: Buffer.byteLength(pdfText, "utf8"),
                resized: false,
                mediaType: "text/plain",
              };
              const enrichedPrompt = `${(request as { userPrompt: string }).userPrompt}\n\n[PDF text extracted - rendered as image fallback]\n${pdfText.slice(0, 6000)}`;
              (request as { userPrompt: string }).userPrompt = enrichedPrompt;
              // 1x1 white JPEG placeholder (avoids file $0.50, keeps vision image_url)
              const placeholder = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=";
              return [{ type: "image_url", image_url: { url: placeholder } }];
            }
          }
          // Fallback: PDF as file part when pdfjs/canvas not available and text extraction failed (e.g. scanned image PDF)
          const dataUrl = `data:${att.mediaType};base64,${raw.toString("base64")}`;
          return [{ type: "file", file: { filename: att.filename ?? "document.pdf", file_data: dataUrl } }];
        })()
      : null;
    const userContent = isVision
      ? [{ type: "text", text: (request as { userPrompt: string }).userPrompt }, ...(visionParts ?? [])]
      : (request as { userPrompt: string }).userPrompt;
    // For free-text chat/draft turns and execution summaries, disable structured output to avoid CPU GBNF grammar compilation
    // stalls and JSON string escaping overhead. Only structured tasks (code, vision) enforce JSON.
    const isFreeText = request.responseFormat === "chat-result" || request.responseFormat === "code-summary";
    const systemPrompt = isFreeText
      ? request.systemPrompt
      : (/json/i.test(request.systemPrompt)
        ? request.systemPrompt
        : `${request.systemPrompt} Respond with valid JSON.`);
    const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(model.baseUrl) || model.runtime === "ollama" || model.runtime === "mlx-lm" || model.runtime === "llama-server";

    // Map the internal ResponseFormat to a strict JSON schema if applicable.
    // For local model servers (LM Studio, mlx-lm, llama-server, Ollama), compiling complex
    // multi-property JSON schemas into GBNF grammars on the CPU blocks execution for 2-4 seconds
    // before GPU prefill begins. Using { type: "json_object" } eliminates this CPU grammar stall
    // completely while local instruct models adhere to the requested JSON shape in the prompt.
    let responseFormatPayload: any = undefined;
    if (isFreeText) {
      // Free text chat / drafting / execution summary: disable structured output completely.
      responseFormatPayload = undefined;
    } else if (isLocal && (request.responseFormat === "code-result" || request.responseFormat === "harness-step" || request.responseFormat === "vision-result" || request.responseFormat === "draft-result")) {
      responseFormatPayload = { type: "json_object" };
    } else if (request.responseFormat === "code-result") {
      responseFormatPayload = {
        type: "json_schema",
        json_schema: {
          name: "code_result",
          strict: false,
          schema: {
            type: "object",
            properties: {
              filename: { type: "string" },
              source: { type: "string" },
              expectedResult: { type: "string" },
              inputFiles: { type: "array", items: { type: "string" } },
              outputFiles: { type: "array", items: { type: "string" } },
              allowedImports: { type: "array", items: { type: "string", enum: ["csv", "datetime", "math"] } },
              outputMode: { type: "string", enum: ["chat", "artifact", "chat_and_artifact"] },
              artifactKind: { type: "string", enum: ["docx", "pdf", "xlsx", "csv", "txt", "json", "md", ""] },
              artifactFilename: { type: "string" },
              artifactRationale: { type: "string" }
            },
            required: ["filename", "source", "expectedResult", "inputFiles", "outputFiles", "allowedImports"]
          }
        }
      };
    } else if (request.responseFormat === "vision-result") {
      responseFormatPayload = {
        type: "json_schema",
        json_schema: {
          name: "vision_result",
          strict: false,
          schema: {
            type: "object",
            properties: {
              sourceText: { type: "string" },
              findings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    findingId: { type: "string" },
                    title: { type: "string" },
                    value: { type: "string" },
                    pageReferenceIds: { type: "array", items: { type: "string" } },
                    confidence: { type: "string", enum: ["high", "medium", "low"] },
                    evidence: { type: "string" }
                  },
                  required: ["findingId", "title", "value", "pageReferenceIds", "confidence", "evidence"]
                }
              },
              pageReferences: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    page: { type: "integer" },
                    text: { type: "string" },
                    location: { type: "string" }
                  },
                  required: ["id", "page", "text"]
                }
              }
            },
            required: ["findings", "pageReferences"]
          }
        }
      };
    } else if (request.responseFormat === "draft-result") {
      responseFormatPayload = {
        type: "json_schema",
        json_schema: {
          name: "draft_result",
          strict: false,
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string" },
              sections: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", enum: ["equipment-header", "findings-summary", "recommendation"] },
                    heading: { type: "string" },
                    body: { type: "string" }
                  },
                  required: ["id", "heading", "body"]
                }
              },
              missingInformation: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    field: { type: "string" },
                    note: { type: "string" }
                  },
                  required: ["field", "note"]
                }
              }
            },
            required: ["title", "body", "sections", "missingInformation"]
          }
        }
      };
    } else if (request.responseFormat === "harness-step") {
      responseFormatPayload = {
        type: "json_schema",
        json_schema: {
          name: "harness_step",
          strict: false,
          schema: {
            type: "object",
            properties: {
              thought: { type: "string" },
              action: { type: "string", enum: ["tool_call", "final_answer"] },
              tool: { type: "string", enum: ["list_dir", "read_file", "search", "write_file", "run_command"] },
              args: { type: "object" },
              text: { type: "string" }
            },
            required: ["thought", "action"]
          }
        }
      };
    } else if (request.responseFormat === "file-result") {
      responseFormatPayload = {
        type: "json_schema",
        json_schema: {
          name: "file_result",
          strict: false,
          schema: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string" }
            },
            required: ["filename", "content"]
          }
        }
      };
    }

    const messagesPayload: Array<{ role: string; content: any }> = [
      { role: "system", content: systemPrompt },
    ];
    if (request.history && request.history.length > 0) {
      for (const h of request.history) {
        messagesPayload.push({ role: h.role, content: h.content });
      }
    }
    messagesPayload.push({ role: "user", content: userContent });

    const maxTokens = request.maxTokens ?? model.maxOutputTokens ?? (isFreeText ? 1536 : 2048);
    const defaultTemperature = (isLocal && (request.taskType === "code" || request.taskType === "vision")) ? 0.0 : 0.2;
    const effectiveTemperature = request.temperature ?? defaultTemperature;
    const requestPayload: Record<string, any> = {
      model: model.model,
      messages: messagesPayload,
      temperature: effectiveTemperature,
      max_tokens: maxTokens,
    };
    if (responseFormatPayload !== undefined) {
      requestPayload.response_format = responseFormatPayload;
    }
    if (request.onChunk) {
      requestPayload.stream = true;
    }
    const body = JSON.stringify(requestPayload);
    const minTimeout = isLocal ? (request.taskType === "code" ? 300000 : 180000) : 0;
    const effectiveTimeout = Math.max(request.timeoutMs ?? 0, model.requestTimeoutMs ?? 0, minTimeout) || 60000;

    const outboundLog = {
      phase: "request" as const,
      taskType: request.taskType,
      modelId: request.modelId,
      devWorkload: isDev,
      providerModel: model.model,
      baseUrl: model.baseUrl,
      endpoint: `${model.baseUrl}/chat/completions`,
      maxTokens,
      temperature: request.temperature ?? 0.2,
      timeoutMs: effectiveTimeout,
      systemPromptChars: request.systemPrompt.length,
      systemPromptPreview: request.systemPrompt.slice(0, 800),
      userPromptChars: typeof userContent === "string" ? userContent.length : JSON.stringify(userContent).length,
      userPromptPreview: typeof userContent === "string" ? userContent.slice(0, 2000) : "[multipart vision]",
      visionUpload: this.lastVisionUpload ?? null,
      visionPartsCount: Array.isArray(visionParts) ? visionParts.length : 0,
      visionPartTypes: Array.isArray(visionParts) ? visionParts.map((p) => (p as { type: string }).type) : [],
    };
    logModelRequest({
      taskType: request.taskType,
      modelId: request.modelId,
      providerModel: model.model,
      requestId: request.requestId,
      maxTokens,
      temperature: request.temperature ?? 0.2,
      userPromptPreview: typeof userContent === "string" ? userContent : "[multipart vision]",
    });
    persistGatewayTrace(request.runId, request.requestId, { ...outboundLog, bodyPreview: body.slice(0, 4000), bodyChars: body.length });
    let rawText = "";
    let envelope: unknown = null;
    let extractedContent: unknown = null;
    let parsedJson: unknown = null;
    try {
      // The counter is for non-local egress evidence. Ollama and LAN model
      // servers remain local; configured cloud endpoints count as external.
      this.externalRequestCount += isLocal ? 0 : 1;
      const t0 = Date.now();
      let response: { status: number; text(): Promise<string> };
      if (request.onChunk && this.transport.streamRequest) {
        response = await this.transport.streamRequest(
          `${model.baseUrl}/chat/completions`,
          { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body },
          effectiveTimeout,
          request.onChunk,
        );
      } else {
        response = await this.transport.request(
          `${model.baseUrl}/chat/completions`,
          { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body },
          effectiveTimeout,
        );
      }
      let latencyMs = Date.now() - t0;
      try { rawText = await response.text(); } catch { rawText = "<unreadable body>"; }

      // If provider rejects response_format (e.g. LM Studio, Ollama, or local model server requiring 'text' or rejecting json_schema)
      if (response.status === 400 && /response_format|json_schema|json_object|type.*must be/i.test(rawText)) {
        logGatewayError(request, "provider rejected response_format, retrying with text type", rawText.slice(0, 200));
        const retryBody = JSON.stringify({
          model: model.model,
          messages: messagesPayload,
          response_format: { type: "text" },
          temperature: request.temperature ?? 0.2,
          max_tokens: maxTokens,
        });
        const retryResponse = await this.transport.request(`${model.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: retryBody }, effectiveTimeout);
        if (retryResponse.status >= 200 && retryResponse.status < 300) {
          response = retryResponse;
          try { rawText = await response.text(); } catch { rawText = "<unreadable body>"; }
        } else {
          // Try omitting response_format altogether
          const plainBody = JSON.stringify({
            model: model.model,
            messages: messagesPayload,
            temperature: request.temperature ?? 0.2,
            max_tokens: maxTokens,
          });
          const plainResponse = await this.transport.request(`${model.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: plainBody }, effectiveTimeout);
          if (plainResponse.status >= 200 && plainResponse.status < 300) {
            response = plainResponse;
            try { rawText = await response.text(); } catch { rawText = "<unreadable body>"; }
          }
        }
      }

      logModelResponse({
        taskType: request.taskType,
        requestId: request.requestId,
        status: response.status,
        latencyMs,
        chars: rawText.length,
      });
      persistGatewayTrace(request.runId, request.requestId, { phase: "http_response", taskType: request.taskType, status: response.status, latencyMs, rawTextChars: rawText.length, rawText, bodyChars: body.length });

      if (response.status < 200 || response.status >= 300) {
        const detail = rawText.slice(0, 2000);
        persistGatewayTrace(request.runId, request.requestId, { phase: "provider_error", taskType: request.taskType, status: response.status, detail, rawText });
        if (response.status === 402) throw new Error(`insufficient OpenRouter credits for model ${model.model} (max_tokens ${maxTokens} requested): ${detail}`);
        throw new Error(`provider rejected request (status ${response.status}, model ${model.model}, endpoint ${model.baseUrl}/chat/completions): ${detail}`);
      }
      try {
        envelope = JSON.parse(rawText) as unknown as { choices?: Array<{ message?: { content?: unknown; finish_reason?: string }; finish_reason?: string }>; usage?: unknown; id?: string; model?: string };
      } catch (e) {
        logGatewayError(request, "failed to parse envelope JSON", rawText.slice(0, 500));
        persistGatewayTrace(request.runId, request.requestId, { phase: "envelope_parse_error", taskType: request.taskType, error: e instanceof Error ? e.message : String(e), rawText });
        throw new Error(`provider returned non-JSON envelope: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)} — raw: ${rawText.slice(0, 1000)}`);
      }
      const envTyped = envelope as {
        choices?: Array<{
          message?: {
            content?: unknown;
            reasoning?: unknown;
            reasoning_content?: unknown;
            finish_reason?: string;
          };
          finish_reason?: string;
        }>;
        usage?: unknown;
      };
      const choiceMsg = envTyped.choices?.[0]?.message;
      extractedContent = choiceMsg?.content;
      const reasoning = choiceMsg?.reasoning ?? choiceMsg?.reasoning_content;
      const finishReason = (envTyped.choices?.[0] as { finish_reason?: string })?.finish_reason ?? choiceMsg?.finish_reason;
      const usage = envTyped["usage" as keyof typeof envTyped];
      persistGatewayTrace(request.runId, request.requestId, {
        phase: "envelope",
        taskType: request.taskType,
        envelope,
        finishReason,
        usage,
        extractedContent,
        reasoning,
        extractedContentChars: typeof extractedContent === "string" ? extractedContent.length : 0,
      });

      persistGatewayTrace(request.runId, request.requestId, { phase: "provider_content_raw", taskType: request.taskType, extractedContent, reasoning });

      if (request.responseFormat === "chat-result" || request.responseFormat === "code-summary") {
        if (typeof extractedContent === "string" && extractedContent.trim().length > 0) {
          const trimmed = extractedContent.trim();
          if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              parsedJson = JSON.parse(trimmed);
            } catch {
              parsedJson = request.responseFormat === "code-summary"
                ? { summary: trimmed, verified: true }
                : { text: trimmed };
            }
          } else {
            parsedJson = request.responseFormat === "code-summary"
              ? { summary: trimmed, verified: true }
              : { text: trimmed };
          }
        } else {
          parsedJson = request.responseFormat === "code-summary"
            ? { summary: String(extractedContent ?? ""), verified: true }
            : { text: String(extractedContent ?? "") };
        }
      } else {
        try {
          parsedJson = parseProviderContent(extractedContent, reasoning);
        } catch (e) {
          logGatewayError(request, "parseProviderContent failed (empty/invalid JSON)", e instanceof Error ? e.message : String(e));
          persistGatewayTrace(request.runId, request.requestId, { phase: "parse_error", taskType: request.taskType, error: e instanceof Error ? e.message : String(e), extractedContent, reasoning, rawText, envelope });
          throw e;
        }
      }
      persistGatewayTrace(request.runId, request.requestId, { phase: "parsed_json", taskType: request.taskType, parsedJson });

      if (request.onChunk && !this.transport.streamRequest) {
        const finalText = typeof parsedJson === "object" && parsedJson && "text" in parsedJson ? String((parsedJson as any).text) : String(extractedContent ?? "");
        if (finalText) {
          request.onChunk(finalText);
        }
      }

      let normalized: ModelResponse;
      try {
        normalized = normalizeResponse(parsedJson, request);
      } catch (e) {
        logGatewayError(request, "normalizeResponse failed", e instanceof Error ? e.message : String(e));
        persistGatewayTrace(request.runId, request.requestId, { phase: "normalize_error", taskType: request.taskType, error: e instanceof Error ? e.message : String(e), parsedJson, extractedContent, rawText, envelope });
        throw e;
      }

      if (parsedJson && typeof parsedJson === "object") {
        const pj = parsedJson as Record<string, unknown>;
        if (typeof pj["source"] === "string" && typeof pj["filename"] === "string") {
          logGeneratedCode({
            filename: String(pj["filename"]),
            source: String(pj["source"]),
            outputMode: typeof pj["outputMode"] === "string" ? pj["outputMode"] : undefined,
            artifactKind: typeof pj["artifactKind"] === "string" ? pj["artifactKind"] : undefined,
            artifactFilename: typeof pj["artifactFilename"] === "string" ? pj["artifactFilename"] : undefined,
            expectedResult: typeof pj["expectedResult"] === "string" ? pj["expectedResult"] : undefined,
          });
        } else if (typeof pj["summary"] === "string" || typeof pj["text"] === "string") {
          logModelSummary((pj["summary"] as string) || (pj["text"] as string), typeof pj["verified"] === "boolean" ? pj["verified"] : undefined);
        } else if (Array.isArray(pj["findings"])) {
          logVisionFindings(pj["findings"] as Array<{ title: string; value?: string; confidence?: string }>);
        }
      }

      persistGatewayTrace(request.runId, request.requestId, { phase: "normalized", taskType: request.taskType, latencyMs, finishReason, usage, result: normalized.result, resultChars: JSON.stringify(normalized.result).length, envelope, rawText, extractedContent, parsedJson });
      return { ok: true, value: normalized };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logGatewayError(request, `gateway failed: ${msg}`);
      persistGatewayTrace(request.runId, request.requestId, { phase: "gateway_error", taskType: request.taskType, error: msg, stack: error instanceof Error ? error.stack?.slice(0, 3000) : undefined, rawText, envelope, extractedContent, parsedJson });
      return { ok: false, error: providerError(error, request) };
    }
  }
  async health(): Promise<ModelHealth[]>;
  async health(modelId: ModelId): Promise<ModelHealth>;
  async health(modelId?: ModelId): Promise<ModelHealth[] | ModelHealth> {
    if (modelId !== undefined) return this.healthOne(modelId);
    return Promise.all(Array.from(this.registry.values()).map((model) => this.healthOne(model.id)));
  }

  /**
   * Probe health by distinct port/endpoint to ensure duplicates don't appear.
   * Keeps PORT as index to eliminate duplicate probes, and model name as display.
   */
  async healthDistinct(): Promise<ModelHealth[]> {
    if (this.isDevRoutingActive()) {
      const all = await this.health();
      return all.slice(0, 1).map((h) => ({
        ...h,
        modelId: this.registry.get(h.modelId)?.model || h.modelId,
      }));
    }

    const distinctByEndpoint = new Map<string, { port: number; model: ModelRegistryEntry }>();
    const entriesToProbe: ModelRegistryEntry[] = [];
    for (const pool of this.endpointPool.values()) {
      for (const m of pool) {
        entriesToProbe.push(m);
      }
    }
    if (entriesToProbe.length === 0) {
      entriesToProbe.push(...this.registry.values());
    }

    for (const model of entriesToProbe) {
      if (!model.enabled) continue;
      try {
        const u = new URL(model.baseUrl);
        const port = u.port ? parseInt(u.port, 10) : (u.protocol === "https:" ? 443 : 80);
        const key = `${u.hostname}:${port}`;
        if (!distinctByEndpoint.has(key)) {
          distinctByEndpoint.set(key, {
            port,
            model,
          });
        }
      } catch {}
    }

    if (distinctByEndpoint.size === 0) {
      return this.health();
    }

    return Promise.all(
      Array.from(distinctByEndpoint.values()).map(async ({ model, port }) => {
        const started = Date.now();
        try {
          const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
          const response = await this.transport.request(
            `${model.baseUrl}${model.healthPath}`,
            { method: "GET", headers: { ...(key ? { authorization: `Bearer ${key}` } : {}) } },
            Math.min(model.requestTimeoutMs || 5000, 4000),
          );
          return {
            modelId: model.model as any,
            port,
            available: response.status >= 200 && response.status < 300,
            checkedAt: new Date().toISOString(),
            latencyMs: Date.now() - started,
          };
        } catch (error) {
          return {
            modelId: model.model as any,
            port,
            available: false,
            checkedAt: new Date().toISOString(),
            latencyMs: Date.now() - started,
            message: error instanceof Error ? error.message : "health check failed",
          };
        }
      }),
    );
  }

  /** Per-model health probe backing the `ModelClient` surface. */
  async healthOne(modelId: ModelId): Promise<ModelHealth> {
    const model = this.registry.get(modelId);
    if (!model || !model.enabled) {
      return { modelId, available: false, checkedAt: new Date().toISOString(), message: "model unavailable" };
    }
    const started = Date.now();
    try {
      const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
      const response = await this.transport.request(
        `${model.baseUrl}${model.healthPath}`,
        { method: "GET", headers: { ...(key ? { authorization: `Bearer ${key}` } : {}) } },
        model.requestTimeoutMs,
      );
      return { modelId, available: response.status >= 200 && response.status < 300, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started };
    } catch (error) {
      return { modelId, available: false, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, message: error instanceof Error ? error.message : "health check failed" };
    }
  }

  // Capability cache: remembers whether a provider endpoint rejected the native `tools` param
  private readonly toolParamCapabilities = new Map<string, boolean>();

  /**
   * Sovereign Workbench v2 Unified Agent Loop native function calling interface.
   * Dispatches conversation turns with native `tools` and `tool_choice: "auto"`.
   * Automatically falls back to prompt-injected schema if provider rejects `tools`.
   */
  async chatWithTools(
    modelId: ModelId,
    messages: Array<{ role: string; content: any; tool_calls?: any[]; tool_call_id?: string; [key: string]: any }>,
    tools: AgentToolDefinition[],
    options?: {
      runId?: string;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      onChunk?: (delta: string) => void;
      devWorkload?: boolean;
    },
  ): Promise<AIResult<AgentTurnResponse>> {
    const isDev = this.isDevRoutingActive(options?.devWorkload !== undefined ? ({ devWorkload: options.devWorkload } as any) : undefined);
    const model = this.resolveNextEndpoint(modelId, isDev);
    if (!model) {
      return {
        ok: false,
        error: {
          kind: "ai-error",
          code: "model_unavailable",
          message: `Model ${modelId} not found in active registry`,
          retryable: false,
          modelId,
        },
      };
    }

    const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
    if (model.runtime === "openrouter" && !key) {
      return {
        ok: false,
        error: {
          kind: "ai-error",
          code: "model_rejected_request",
          message: `Missing environment credential ${model.apiKeyEnv}`,
          retryable: false,
          modelId,
        },
      };
    }

    const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(model.baseUrl) ||
      model.runtime === "ollama" ||
      model.runtime === "mlx-lm" ||
      model.runtime === "llama-server";

    const endpointKey = `${model.baseUrl}:${model.model}`;
    const knownSupportsTools = this.toolParamCapabilities.get(endpointKey) ?? true;
    const effectiveTimeout = Math.max(options?.timeoutMs ?? 0, model.requestTimeoutMs ?? 0, 60000);
    const requestedMaxTokens = options?.maxTokens ?? model.maxOutputTokens ?? 4096;
    const effectiveMaxTokens = isLocal ? Math.min(requestedMaxTokens, 2048) : requestedMaxTokens;
    const effectiveTemperature = options?.temperature ?? 0.2;

    const runId = options?.runId ?? "run-agent-loop";
    const requestId = randomUUID();

    // 1. If provider hasn't rejected tools previously (or tools array is empty):
    if (knownSupportsTools || tools.length === 0) {
      const nativeMessages = formatMessagesForNativeTools(messages);
      const payload: Record<string, any> = {
        model: model.model,
        messages: nativeMessages,
        temperature: effectiveTemperature,
        max_tokens: effectiveMaxTokens,
      };
      if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
      }
      if (options?.onChunk && this.transport.streamRequest) {
        payload.stream = true;
      }

      try {
        const body = JSON.stringify(payload);
        const t0 = Date.now();
        let response: { status: number; text(): Promise<string> };

        if (options?.onChunk && this.transport.streamRequest) {
          response = await this.transport.streamRequest(
            `${model.baseUrl}/chat/completions`,
            {
              method: "POST",
              headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
              body,
            },
            effectiveTimeout,
            options.onChunk,
          );
        } else {
          response = await this.transport.request(
            `${model.baseUrl}/chat/completions`,
            {
              method: "POST",
              headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
              body,
            },
            effectiveTimeout,
          );
        }

        if (options?.runId) {
          persistGatewayTrace(options.runId, requestId, {
            phase: "chat_turn_request",
            modelId,
            providerModel: model.model,
            mode: "native_tools",
            messagesCount: messages.length,
            toolsCount: tools.length,
            bodyPreview: body.slice(0, 4000),
            bodyChars: body.length,
          });
        }

        const rawText = await response.text();
        const durationMs = Date.now() - t0;

        // Check if provider returned 400 specifically rejecting `tools` parameter
        if (response.status === 400 && /tools|tool_choice|unsupported parameter/i.test(rawText)) {
          this.toolParamCapabilities.set(endpointKey, false);
          // Downgrade and fall through to fallback prompt injection
        } else if (response.status >= 200 && response.status < 300) {
          const envelope = JSON.parse(rawText);
          const choice = envelope.choices?.[0];
          const msg = choice?.message;
          const rawToolCalls = msg?.tool_calls;
          const parsedCalls: AgentToolCall[] = [];

          if (Array.isArray(rawToolCalls)) {
            for (const call of rawToolCalls) {
              const callName = call.function?.name || call.name;
              if (callName) {
                const parsedArgs = parseToolCallArguments(call.function?.arguments ?? call.arguments);
                parsedCalls.push({
                  id: call.id || randomUUID(),
                  name: callName,
                  arguments: parsedArgs,
                });
              }
            }
          }

          let content = msg?.content ? String(msg.content) : null;
          if (parsedCalls.length === 0 && content) {
            const embedded = extractEmbeddedToolCalls(content);
            if (embedded.toolCalls.length > 0) {
              parsedCalls.push(...embedded.toolCalls);
              content = embedded.cleanedContent;
            }
          }

          if (options?.runId) {
            persistGatewayTrace(options.runId, requestId, {
              phase: "chat_turn_response",
              modelId,
              mode: "native_tools",
              status: response.status,
              latencyMs: durationMs,
              content,
              toolCalls: parsedCalls,
              rawTextChars: rawText.length,
              rawText: rawText.slice(0, 4000),
            });
          }

          return {
            ok: true,
            value: {
              content,
              tool_calls: parsedCalls.length > 0 ? parsedCalls : null,
              usage: {
                inputTokens: envelope.usage?.prompt_tokens,
                outputTokens: envelope.usage?.completion_tokens,
                durationMs,
              },
            },
          };
        } else {
          return {
            ok: false,
            error: {
              kind: "ai-error",
              code: "model_rejected_request",
              message: `Provider status ${response.status}: ${rawText.slice(0, 500)}`,
              retryable: response.status >= 500,
              modelId,
              requestId,
              runId,
            },
          };
        }
      } catch (err: any) {
        if (!/tools/i.test(err?.message ?? "")) {
          return {
            ok: false,
            error: {
              kind: "ai-error",
              code: "model_timeout",
              message: err instanceof Error ? err.message : String(err),
              retryable: true,
              modelId,
              requestId,
              runId,
            },
          };
        }
      }
    }

    // 2. Fallback Path: JSON-in-Prompt Emulation when native tools parameter is unsupported
    const toolDescriptions = tools
      .map((t) => `- ${t.function.name}: ${t.function.description}\n  Arguments schema: ${JSON.stringify(t.function.parameters)}`)
      .join("\n\n");

    const fallbackSystemPromptAddition = `\n\nAVAILABLE TOOLS:\n${toolDescriptions}\n\nTo use a tool, respond with JSON matching:\n{"content": "reasoning or response", "tool_calls": [{"name": "tool_name", "arguments": { ... }}]}\nIf no tool is needed, respond with:\n{"content": "your response", "tool_calls": null}`;

    const fallbackMessages = formatMessagesForFallback(messages, fallbackSystemPromptAddition);

    try {
      const fallbackBody = JSON.stringify({
        model: model.model,
        messages: fallbackMessages,
        temperature: effectiveTemperature,
        max_tokens: effectiveMaxTokens,
        response_format: isLocal ? { type: "json_object" } : undefined,
      });

      if (options?.runId) {
        persistGatewayTrace(options.runId, requestId, {
          phase: "chat_turn_request",
          modelId,
          providerModel: model.model,
          mode: "fallback_prompt_injection",
          messagesCount: fallbackMessages.length,
          toolsCount: tools.length,
          bodyPreview: fallbackBody.slice(0, 4000),
          bodyChars: fallbackBody.length,
        });
      }

      const t0 = Date.now();
      const response = await this.transport.request(
        `${model.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: fallbackBody,
        },
        effectiveTimeout,
      );

      const rawText = await response.text();
      const durationMs = Date.now() - t0;

      if (response.status >= 200 && response.status < 300) {
        const envelope = JSON.parse(rawText);
        const choice = envelope.choices?.[0];
        const rawContent = choice?.message?.content;
        let parsedJson: any = null;

        if (typeof rawContent === "string") {
          try {
            const stripped = rawContent.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
            parsedJson = JSON.parse(stripped);
          } catch {
            parsedJson = { content: rawContent, tool_calls: null };
          }
        }

        const toolCalls: AgentToolCall[] = [];
        if (Array.isArray(parsedJson?.tool_calls)) {
          for (const tc of parsedJson.tool_calls) {
            const callName = tc.name || tc.function?.name;
            if (callName) {
              toolCalls.push({
                id: tc.id || randomUUID(),
                name: callName,
                arguments: parseToolCallArguments(tc.arguments ?? tc.parameters ?? {}),
              });
            }
          }
        }

        let finalContent = parsedJson?.content ? String(parsedJson.content) : (typeof rawContent === "string" ? rawContent : null);
        if (toolCalls.length === 0 && finalContent) {
          const embedded = extractEmbeddedToolCalls(finalContent);
          if (embedded.toolCalls.length > 0) {
            toolCalls.push(...embedded.toolCalls);
            finalContent = embedded.cleanedContent;
          }
        }

        if (options?.runId) {
          persistGatewayTrace(options.runId, requestId, {
            phase: "chat_turn_response",
            modelId,
            mode: "fallback_prompt_injection",
            status: response.status,
            latencyMs: durationMs,
            content: finalContent,
            toolCalls,
            rawTextChars: rawText.length,
            rawText: rawText.slice(0, 4000),
          });
        }

        return {
          ok: true,
          value: {
            content: finalContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : null,
            usage: {
              inputTokens: envelope.usage?.prompt_tokens,
              outputTokens: envelope.usage?.completion_tokens,
              durationMs,
            },
          },
        };
      }

      return {
        ok: false,
        error: {
          kind: "ai-error",
          code: "model_rejected_request",
          message: `Fallback status ${response.status}: ${rawText.slice(0, 500)}`,
          retryable: response.status >= 500,
          modelId,
          requestId,
          runId,
        },
      };
    } catch (err: any) {
      return {
        ok: false,
        error: {
          kind: "ai-error",
          code: "model_unavailable",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
          modelId,
          requestId,
          runId,
        },
      };
    }
  }
}
export function requestBase(
  runId: string,
  taskType: ModelRequest["taskType"],
  modelId: ModelRequest["modelId"],
  responseFormat: ModelRequest["responseFormat"],
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number,
  maxTokens?: number,
  temperature?: number,
  history?: ModelRequest["history"],
): Pick<
  ModelRequest,
  | "requestId"
  | "runId"
  | "taskType"
  | "modelId"
  | "responseFormat"
  | "systemPrompt"
  | "userPrompt"
  | "timeoutMs"
  | "maxTokens"
  | "temperature"
  | "history"
> {
  return {
    requestId: randomUUID(),
    runId,
    taskType,
    modelId,
    responseFormat,
    systemPrompt,
    userPrompt,
    timeoutMs,
    maxTokens,
    temperature,
    history,
  };
}
