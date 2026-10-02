import type { ProviderConfig } from "../config.js";
import { redact } from "../helpers/redact.js";
import { pause, throwIfInterrupted } from "../helpers/cancellation.js";

export interface ProviderEvent { timestamp: string; provider: string; model: string; kind: "request" | "fallback" | "retry" | "result"; reason?: string; usage?: unknown; rateLimits?: Record<string, string>; }
export class EffortProvider {
  readonly events: ProviderEvent[] = [];
  calls = 0;
  private local = false;
  constructor(private primary: ProviderConfig | undefined, private fallback: ProviderConfig | undefined, private limit: number, private onEvent: (e: ProviderEvent) => void = () => {}, private signal?: AbortSignal) {}
  get active(): ProviderConfig | undefined { return this.local ? this.fallback : this.primary; }
  get remainingCalls(): number { return Math.max(0, this.limit - this.calls); }
  private event(kind: ProviderEvent["kind"], config: ProviderConfig, reason?: string, usage?: unknown): void {
    const event = { timestamp: new Date().toISOString(), provider: config.name, model: config.model, kind, reason: reason ? redact(reason) : undefined, usage };
    this.events.push(event); this.onEvent(event);
  }
  private switchLocal(reason: string): void {
    if (this.local || !this.fallback) throw new Error(`Provider unavailable and no usable local fallback: ${redact(reason)}`);
    this.local = true; this.event("fallback", this.fallback, reason);
  }
  async complete(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, deadlineMs = Infinity): Promise<string> {
    if (!this.active) this.switchLocal("Primary provider not configured");
    const started = Date.now();
    let retries = 0;
    while (true) {
      throwIfInterrupted(this.signal);
      const config = this.active;
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) throw new Error("Provider campaign deadline exceeded");
      if (!config) throw new Error("Provider not configured");
      const key = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
      if (config.apiKeyEnv && !key) { this.switchLocal("Primary credentials unavailable"); continue; }
      if (this.calls >= this.limit) throw new Error("Provider request effort exhausted");
      this.calls++; this.event("request", config);
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(config.timeoutMs, remaining))));
        response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model: config.model, messages, temperature: config.temperature, max_tokens: config.maxTokens, stream: false }), signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout, redirect: "error" });
      } catch {
        throwIfInterrupted(this.signal);
        if (this.local) throw new Error("Local fallback transport unavailable");
        this.switchLocal("Primary transport unavailable"); continue;
      }
      const body = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: unknown; error?: { code?: number; metadata?: { limit_source?: string }; message?: string } };
      const rateLimits = Object.fromEntries(["x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"].flatMap((header) => response.headers.has(header) ? [[header, response.headers.get(header)!]] : []));
      this.events.at(-1)!.rateLimits = rateLimits;
      if (response.ok && !body.error) {
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim() || body.choices?.[0]?.finish_reason === "error") {
          if (!this.local) { this.switchLocal("Invalid primary response"); continue; }
          throw new Error("Invalid local response");
        }
        this.event("result", config, undefined, body.usage); return content;
      }
      const status = typeof body.error?.code === "number" ? body.error.code : response.status;
      const transient = status === 429 || status >= 500 || (status === 402 && body.error?.metadata?.limit_source === "openrouter_in_flight_budget");
      const retry = response.headers.get("retry-after");
      const delay = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 1000 * 2 ** retries;
      if (transient && retries < 2 && Number.isFinite(delay) && Date.now() - started + delay <= 30000 && Date.now() + delay < deadlineMs) {
        retries++; this.event("retry", config, `HTTP ${status}; wait ${delay}ms`);
        await pause(delay, this.signal); continue;
      }
      if (this.local) throw new Error(`Local fallback HTTP ${status}`);
      this.switchLocal(`Primary HTTP ${status}`); retries = 0;
    }
  }
}
