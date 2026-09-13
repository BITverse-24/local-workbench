import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AIResult, ModelHealth, ModelId, ModelRequest, ModelResponse, ModelRegistryEntry } from "../../shared/contracts.js";
import type { ModelClient } from "../models/ports.js";
import {
  defaultLocalRegistry,
  isDevOpenRouterActive,
  loadDevOpenRouterRegistry,
  loadProductionRegistryFromDb,
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

export interface GatewayTransport { request(url: string, init: { method: string; headers: Record<string, string>; body?: string }, timeoutMs: number): Promise<{ status: number; text(): Promise<string> }>; }
const nativeTransport: GatewayTransport = { async request(url, init, timeoutMs) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { return await fetch(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); } } };
export interface VisionUploadInfo { originalBytes: number; finalBytes: number; resized: boolean; mediaType: string; }
export class ModelGateway implements ModelClient {
  readonly dbRegistry: Map<string, ModelRegistryEntry>;
  readonly devRegistry: Map<string, ModelRegistryEntry>;
  private devModeOverride: boolean | null = null;
  externalRequestCount = 0;
  lastVisionUpload?: VisionUploadInfo;

  constructor(
    private readonly transport: GatewayTransport = nativeTransport,
    initialRegistry?: Map<string, ModelRegistryEntry>,
    devRegistry?: Map<string, ModelRegistryEntry>,
  ) {
    this.dbRegistry = initialRegistry ?? (loadProductionRegistryFromDb() as Map<string, ModelRegistryEntry>);
    try {
      this.devRegistry = devRegistry ?? (loadDevOpenRouterRegistry() as Map<string, ModelRegistryEntry>);
    } catch {
      this.devRegistry = new Map();
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
    const map = Array.isArray(entries) ? new Map(entries.map((m) => [m.id, m])) : entries;
    for (const [k, v] of map) {
      this.dbRegistry.set(k, v);
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
    const activeRegistry = isDev && this.devRegistry.size > 0 ? this.devRegistry : this.dbRegistry;
    let model: ModelRegistryEntry;
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
    // Providers with OpenAI semantics reject `response_format: json_object`
    // unless the messages mention JSON. Backstop every caller here.
    const systemPrompt = /json/i.test(request.systemPrompt)
      ? request.systemPrompt
      : `${request.systemPrompt} Respond with valid JSON.`;
    // OpenRouter pre-checks affordability against (prompt + max_tokens): omitting
    // max_tokens defaults it to the model's full window (e.g. 32768) and yields
    // 402 on low-credit keys even for tiny replies. Always cap explicitly.
    // Map the internal ResponseFormat to a strict JSON schema if applicable
    let responseFormatPayload: any = { type: "json_object" };
    if (request.responseFormat === "chat-result") {
      responseFormatPayload = {
        type: "json_schema",
        json_schema: {
          name: "chat_result",
          strict: false,
          schema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false
          }
        }
      };
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
    } else if (request.responseFormat === "code-summary") {
      responseFormatPayload = {
        type: "json_schema",
        json_schema: {
          name: "code_summary",
          strict: false,
          schema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              verified: { type: "boolean" }
            },
            required: ["summary", "verified"]
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

    const maxTokens = request.maxTokens ?? model.maxOutputTokens ?? 2048;
    const body = JSON.stringify({
      model: model.model,
      messages: messagesPayload,
      response_format: responseFormatPayload,
      temperature: request.temperature ?? 0.2,
      max_tokens: maxTokens,
    });
    // Log outgoing request (without leaking key, with vision metadata instead of full base64)
    const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(model.baseUrl) || model.runtime === "ollama" || model.runtime === "mlx-lm" || model.runtime === "llama-server";
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
      let response = await this.transport.request(`${model.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body }, effectiveTimeout);
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

      try {
        parsedJson = parseProviderContent(extractedContent, reasoning);
      } catch (e) {
        logGatewayError(request, "parseProviderContent failed (empty/invalid JSON)", e instanceof Error ? e.message : String(e));
        persistGatewayTrace(request.runId, request.requestId, { phase: "parse_error", taskType: request.taskType, error: e instanceof Error ? e.message : String(e), extractedContent, reasoning, rawText, envelope });
        throw e;
      }
      persistGatewayTrace(request.runId, request.requestId, { phase: "parsed_json", taskType: request.taskType, parsedJson });

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
