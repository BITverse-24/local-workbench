import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AIResult, ModelRequest, ModelResponse, ModelRegistryEntry } from "../../shared/contracts.js";
import { loadRegistry, resolveModel } from "./registry.js";
import { normalizeResponse, parseProviderContent, providerError } from "./normalizer.js";
import { absoluteDataPath } from "../run/filesystem.js";

export interface GatewayTransport { request(url: string, init: { method: string; headers: Record<string, string>; body?: string }, timeoutMs: number): Promise<{ status: number; text(): Promise<string> }>; }
const nativeTransport: GatewayTransport = { async request(url, init, timeoutMs) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { return await fetch(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); } } };
export class ModelGateway {
  readonly registry: Map<string, ModelRegistryEntry>; externalRequestCount = 0;
  constructor(private readonly transport: GatewayTransport = nativeTransport, registry = loadRegistry()) { this.registry = registry; }
  async execute(request: ModelRequest): Promise<AIResult<ModelResponse>> {
    let model: ModelRegistryEntry;
    try { model = resolveModel(this.registry as Map<any, ModelRegistryEntry>, request.modelId, request.taskType); } catch { return { ok: false, error: { kind: "ai-error", code: "model_unavailable", message: "configured model is unavailable", retryable: false, requestId: request.requestId, runId: request.runId, taskType: request.taskType, modelId: request.modelId } }; }
    const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
    if (model.runtime === "openrouter" && !key) return { ok: false, error: { kind: "ai-error", code: "model_rejected_request", message: `missing environment credential ${model.apiKeyEnv}`, retryable: false, requestId: request.requestId, runId: request.runId, taskType: request.taskType, modelId: request.modelId } };
    const maybeVision = request as unknown as { taskType: string; attachment?: { mediaType: string; relativePath: string } };
    const isVision = maybeVision.taskType === "vision" && !!maybeVision.attachment;
    const userContent = isVision
      ? [
          { type: "text", text: (request as { userPrompt: string }).userPrompt },
          {
            type: "image_url",
            image_url: {
              url: `data:${maybeVision.attachment!.mediaType};base64,${readFileSync(absoluteDataPath(maybeVision.attachment!.relativePath)).toString("base64")}`,
            },
          },
        ]
      : (request as { userPrompt: string }).userPrompt;
    const body = JSON.stringify({ model: model.model, messages: [{ role: "system", content: request.systemPrompt }, { role: "user", content: userContent }], response_format: { type: "json_object" }, temperature: request.temperature ?? 0.2 });
    try {
      this.externalRequestCount += model.runtime === "openrouter" ? 1 : 0;
      const response = await this.transport.request(`${model.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body }, Math.min(request.timeoutMs, model.requestTimeoutMs));
      if (response.status < 200 || response.status >= 300) throw new Error(`provider rejected request (${response.status})`);
      const envelope = JSON.parse(await response.text()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = envelope.choices?.[0]?.message?.content;
      return { ok: true, value: normalizeResponse(parseProviderContent(content), request) };
    } catch (error) { return { ok: false, error: providerError(error, request) }; }
  }
  async health(): Promise<Array<{ modelId: string; available: boolean; checkedAt: string; latencyMs?: number; message?: string }>> {
    const results: Array<{ modelId: string; available: boolean; checkedAt: string; latencyMs?: number; message?: string }> = []; for (const model of this.registry.values()) { const started = Date.now(); try { const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined; const response = await this.transport.request(`${model.baseUrl}${model.healthPath}`, { method: "GET", headers: { ...(key ? { authorization: `Bearer ${key}` } : {}) } }, model.requestTimeoutMs); results.push({ modelId: model.id, available: response.status >= 200 && response.status < 300, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started }); } catch (error) { results.push({ modelId: model.id, available: false, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, message: error instanceof Error ? error.message : "health check failed" }); } } return results;
  }
}
export function requestBase(runId: string, taskType: ModelRequest["taskType"], modelId: ModelRequest["modelId"], responseFormat: ModelRequest["responseFormat"], systemPrompt: string, userPrompt: string, timeoutMs: number): Pick<ModelRequest, "requestId" | "runId" | "taskType" | "modelId" | "responseFormat" | "systemPrompt" | "userPrompt" | "timeoutMs"> { return { requestId: randomUUID(), runId, taskType, modelId, responseFormat, systemPrompt, userPrompt, timeoutMs }; }
