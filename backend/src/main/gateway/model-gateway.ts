import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AIResult, ModelHealth, ModelId, ModelRequest, ModelResponse, ModelRegistryEntry } from "../../shared/contracts.js";
import type { ModelClient } from "../models/ports.js";
import { loadRegistry, resolveModel } from "./registry.js";
import { normalizeResponse, parseProviderContent, providerError } from "./normalizer.js";
import { absoluteDataPath, createRunDirectories, runRoot } from "../run/filesystem.js";
import { assertUploadableSize, extractPdfText, prepareImage, renderPdfToImages } from "../run/images.js";

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
  readonly registry: Map<string, ModelRegistryEntry>; externalRequestCount = 0; lastVisionUpload?: VisionUploadInfo;
  constructor(private readonly transport: GatewayTransport = nativeTransport, registry = loadRegistry()) { this.registry = registry; }
  /** `ModelClient` surface: delegates to `execute`. */
  async complete(request: ModelRequest): Promise<AIResult<ModelResponse>> {
    return this.execute(request);
  }
  async execute(request: ModelRequest): Promise<AIResult<ModelResponse>> {
    let model: ModelRegistryEntry;
    try { model = resolveModel(this.registry as Map<any, ModelRegistryEntry>, request.modelId, request.taskType); } catch { return { ok: false, error: { kind: "ai-error", code: "model_unavailable", message: "configured model is unavailable", retryable: false, requestId: request.requestId, runId: request.runId, taskType: request.taskType, modelId: request.modelId } }; }
    const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
    if (model.runtime === "openrouter" && !key) return { ok: false, error: { kind: "ai-error", code: "model_rejected_request", message: `missing environment credential ${model.apiKeyEnv}`, retryable: false, requestId: request.requestId, runId: request.runId, taskType: request.taskType, modelId: request.modelId } };
    const maybeVision = request as unknown as { taskType: string; attachment?: { mediaType: string; relativePath: string; filename?: string } };
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
          const raw = readFileSync(absoluteDataPath(att.relativePath));
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
            const pdfImages = await renderPdfToImages(raw);
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
    const maxTokens = request.maxTokens ?? model.maxOutputTokens ?? 2048;
    const body = JSON.stringify({ model: model.model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }], response_format: { type: "json_object" }, temperature: request.temperature ?? 0.2, max_tokens: maxTokens });
    // Log outgoing request (without leaking key, with vision metadata instead of full base64)
    const outboundLog = {
      phase: "request" as const,
      taskType: request.taskType,
      modelId: request.modelId,
      providerModel: model.model,
      baseUrl: model.baseUrl,
      endpoint: `${model.baseUrl}/chat/completions`,
      maxTokens,
      temperature: request.temperature ?? 0.2,
      timeoutMs: Math.min(request.timeoutMs, model.requestTimeoutMs),
      systemPromptChars: request.systemPrompt.length,
      systemPromptPreview: request.systemPrompt.slice(0, 800),
      userPromptChars: typeof userContent === "string" ? userContent.length : JSON.stringify(userContent).length,
      userPromptPreview: typeof userContent === "string" ? userContent.slice(0, 2000) : "[multipart vision]",
      visionUpload: this.lastVisionUpload ?? null,
      visionPartsCount: Array.isArray(visionParts) ? visionParts.length : 0,
      visionPartTypes: Array.isArray(visionParts) ? visionParts.map((p) => (p as { type: string }).type) : [],
    };
    gatewayConsole("log", request, `→ ${request.taskType} ${model.model} max_tokens=${maxTokens}`, outboundLog);
    persistGatewayTrace(request.runId, request.requestId, { ...outboundLog, bodyPreview: body.slice(0, 4000), bodyChars: body.length });
    let rawText = "";
    let envelope: unknown = null;
    let extractedContent: unknown = null;
    let parsedJson: unknown = null;
    try {
      // The counter is for non-local egress evidence. Ollama and LAN model
      // servers remain local; configured cloud endpoints count as external.
      this.externalRequestCount += /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(model.baseUrl) || model.runtime === "ollama" || model.runtime === "mlx-lm" || model.runtime === "llama-server" ? 0 : 1;
      const t0 = Date.now();
      const response = await this.transport.request(`${model.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body }, Math.min(request.timeoutMs, model.requestTimeoutMs));
      const latencyMs = Date.now() - t0;
      try { rawText = await response.text(); } catch { rawText = "<unreadable body>"; }
      gatewayConsole(response.status < 200 || response.status >= 300 ? "error" : "log", request, `← HTTP ${response.status} in ${latencyMs}ms, ${rawText.length} chars`, rawText.slice(0, 4000));
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
        gatewayConsole("error", request, "failed to parse envelope JSON", rawText.slice(0, 2000));
        persistGatewayTrace(request.runId, request.requestId, { phase: "envelope_parse_error", taskType: request.taskType, error: e instanceof Error ? e.message : String(e), rawText });
        throw new Error(`provider returned non-JSON envelope: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)} — raw: ${rawText.slice(0, 1000)}`);
      }
      const envTyped = envelope as { choices?: Array<{ message?: { content?: unknown; finish_reason?: string }; finish_reason?: string }>; usage?: unknown };
      extractedContent = envTyped.choices?.[0]?.message?.content;
      const finishReason = (envTyped.choices?.[0] as { finish_reason?: string })?.finish_reason ?? (envTyped.choices?.[0]?.message as { finish_reason?: string } | undefined)?.finish_reason;
      const usage = envTyped["usage" as keyof typeof envTyped];
      gatewayConsole("log", request, `envelope parsed: finish_reason=${finishReason ?? "n/a"} contentType=${typeof extractedContent} contentChars=${typeof extractedContent === "string" ? extractedContent.length : JSON.stringify(extractedContent ?? "").length}`, { finishReason, usage, envelopePreview: JSON.stringify(envelope).slice(0, 4000) });
      persistGatewayTrace(request.runId, request.requestId, { phase: "envelope", taskType: request.taskType, envelope, finishReason, usage, extractedContent, extractedContentChars: typeof extractedContent === "string" ? extractedContent.length : 0 });

      // Log raw content string exactly as model returned it (with truncation preview for console, full in file)
      if (typeof extractedContent === "string") {
        gatewayConsole("log", request, `model content raw (${extractedContent.length} chars)`, extractedContent.slice(0, 4000));
      } else {
        gatewayConsole("warn", request, "model content is not a string (unexpected)", extractedContent);
      }
      persistGatewayTrace(request.runId, request.requestId, { phase: "provider_content_raw", taskType: request.taskType, extractedContent });

      try {
        parsedJson = parseProviderContent(extractedContent);
      } catch (e) {
        gatewayConsole("error", request, "parseProviderContent failed (empty/invalid JSON)", { error: e instanceof Error ? e.message : String(e), extractedContentPreview: typeof extractedContent === "string" ? (extractedContent as string).slice(0, 4000) : String(extractedContent).slice(0, 4000) });
        persistGatewayTrace(request.runId, request.requestId, { phase: "parse_error", taskType: request.taskType, error: e instanceof Error ? e.message : String(e), extractedContent, rawText, envelope });
        throw e;
      }
      gatewayConsole("log", request, `parsed JSON keys=${parsedJson && typeof parsedJson === "object" ? Object.keys(parsedJson as object).join(",") : typeof parsedJson}`, JSON.stringify(parsedJson).slice(0, 6000));
      persistGatewayTrace(request.runId, request.requestId, { phase: "parsed_json", taskType: request.taskType, parsedJson });

      let normalized: ModelResponse;
      try {
        normalized = normalizeResponse(parsedJson, request);
      } catch (e) {
        gatewayConsole("error", request, "normalizeResponse failed", { error: e instanceof Error ? e.message : String(e), parsedJsonPreview: JSON.stringify(parsedJson).slice(0, 4000) });
        persistGatewayTrace(request.runId, request.requestId, { phase: "normalize_error", taskType: request.taskType, error: e instanceof Error ? e.message : String(e), parsedJson, extractedContent, rawText, envelope });
        throw e;
      }
      gatewayConsole("log", request, `normalized OK result keys=${normalized.result && typeof normalized.result === "object" ? Object.keys(normalized.result as object).join(",") : typeof normalized.result}`, JSON.stringify(normalized.result).slice(0, 6000));
      persistGatewayTrace(request.runId, request.requestId, { phase: "normalized", taskType: request.taskType, latencyMs, finishReason, usage, result: normalized.result, resultChars: JSON.stringify(normalized.result).length, envelope, rawText, extractedContent, parsedJson });
      return { ok: true, value: normalized };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      gatewayConsole("error", request, `gateway failed: ${msg}`, { rawTextPreview: rawText.slice(0, 2000), extractedContentPreview: typeof extractedContent === "string" ? (extractedContent as string).slice(0, 2000) : extractedContent, parsedJsonPreview: parsedJson ? JSON.stringify(parsedJson).slice(0, 2000) : null });
      persistGatewayTrace(request.runId, request.requestId, { phase: "gateway_error", taskType: request.taskType, error: msg, stack: error instanceof Error ? error.stack?.slice(0, 3000) : undefined, rawText, envelope, extractedContent, parsedJson });
      return { ok: false, error: providerError(error, request) };
    }
  }
  async health(): Promise<ModelHealth[]>;
  async health(modelId: ModelId): Promise<ModelHealth>;
  async health(modelId?: ModelId): Promise<ModelHealth[] | ModelHealth> {
    if (modelId !== undefined) return this.healthOne(modelId);
    const results: ModelHealth[] = []; for (const model of this.registry.values()) { const started = Date.now(); try { const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined; const response = await this.transport.request(`${model.baseUrl}${model.healthPath}`, { method: "GET", headers: { ...(key ? { authorization: `Bearer ${key}` } : {}) } }, model.requestTimeoutMs); results.push({ modelId: model.id, available: response.status >= 200 && response.status < 300, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started }); } catch (error) { results.push({ modelId: model.id, available: false, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, message: error instanceof Error ? error.message : "health check failed" }); } } return results;
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
export function requestBase(runId: string, taskType: ModelRequest["taskType"], modelId: ModelRequest["modelId"], responseFormat: ModelRequest["responseFormat"], systemPrompt: string, userPrompt: string, timeoutMs: number, maxTokens?: number): Pick<ModelRequest, "requestId" | "runId" | "taskType" | "modelId" | "responseFormat" | "systemPrompt" | "userPrompt" | "timeoutMs" | "maxTokens"> { return { requestId: randomUUID(), runId, taskType, modelId, responseFormat, systemPrompt, userPrompt, timeoutMs, maxTokens }; }
