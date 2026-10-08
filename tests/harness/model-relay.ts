import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import type { Profile } from "../config.js";
import type { TrafficRecord } from "../recorder.js";
import { sha256 } from "../helpers/files.js";
import { pause } from "../helpers/cancellation.js";

export type MockHandler = (route: string, body: Record<string, unknown>, index: number) => { status?: number; body?: unknown; raw?: string; chunks?: string[]; delayMs?: number; contentType?: string };
export function canonicalRequest(value: unknown, identities: Record<string, string> = {}, toolTelemetry: Record<string, string> = {}): unknown {
  if (typeof value === "string") {
    // Only supervisor-observed generated identities may vary. Source UUIDs,
    // dates, measurements, tool arguments and model settings remain exact.
    let result = value;
    for (const [generated, alias] of Object.entries(identities).sort(([a], [b]) => b.length - a.length)) result = result.split(generated).join(alias);
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalRequest(item, identities, toolTelemetry));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonicalRequest(object.role === "tool" && key === "content" && typeof v === "string" ? toolTelemetry[v] ?? v : v, identities, toolTelemetry)]));
  }
  return value;
}
export class ModelRelay {
  readonly records: TrafficRecord[] = [];
  readonly errors: string[] = [];
  private server: Server;
  private replayIndex = 0;
  private controllers = new Set<AbortController>();
  private pending = new Set<Promise<void>>();
  origin = "";
  constructor(private profile: Profile, private mode: "real" | "replay" | "mock", private record: (r: TrafficRecord) => void, private mock?: MockHandler, private replay: TrafficRecord[] = [], private identities: () => Record<string, string> = () => ({}), private toolTelemetry: () => Record<string, string> = () => ({})) {
    this.server = createServer((req, res) => {
      const controller = new AbortController();
      this.controllers.add(controller);
      res.once("close", () => controller.abort());
      const task = (async () => {
      const match = /^\/(target\/([^/]+)|embedding)\/v1\/(models|chat\/completions|embeddings)$/.exec(req.url ?? "");
      if (!match) { res.writeHead(403); res.end("Unknown relay route"); return; }
      const model = match[2] ? profile.target.registry.find((m) => m.id === match[2]) : profile.target.embedding;
      if (!model) { res.writeHead(403); res.end("Unconfigured model"); return; }
      const route = `${match[1]}/${match[3]}`;
      if (req.method !== "POST" && !(req.method === "GET" && match[3] === "models")) { res.writeHead(405); res.end(); return; }
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 32 * 1024 ** 2) throw new Error("Model request exceeds evidence limit"); }
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      if (req.method === "POST" && body.model !== model.model) { res.writeHead(403); res.end("Model selection does not match fixed profile"); return; }
      const entry: TrafficRecord = { route, method: req.method!, request: body, canonicalRequest: canonicalRequest(body, this.identities(), this.toolTelemetry()), status: 0, chunks: [], headers: {} };
      this.records.push(entry);
      const index = this.records.length - 1;
      let last = performance.now();
      const emit = (bytes: Buffer) => { const now = performance.now(); entry.chunks.push({ delayMs: now - last, base64: bytes.toString("base64") }); last = now; res.write(bytes); };
      try {
        if (this.mode === "replay") {
          const recorded = this.replay[this.replayIndex++];
          if (!recorded || recorded.route !== route || recorded.method !== req.method || sha256(JSON.stringify(recorded.canonicalRequest ?? canonicalRequest(recorded.request))) !== sha256(JSON.stringify(entry.canonicalRequest))) throw new Error(`replay_divergence at request ${this.replayIndex}`);
          entry.status = recorded.status; entry.headers = recorded.headers;
          res.writeHead(recorded.status, recorded.headers);
          for (const chunk of recorded.chunks) { await pause(chunk.delayMs, controller.signal); emit(Buffer.from(chunk.base64, "base64")); }
        } else if (this.mode === "mock") {
          if (!this.mock) throw new Error("Mock mode requires an explicit scripted model fixture");
          const response = this.mock(route, body, index);
          entry.status = response.status ?? 200; entry.headers = { "content-type": response.contentType ?? "application/json" };
          res.writeHead(entry.status, entry.headers);
          for (const chunk of response.chunks ?? [response.raw ?? JSON.stringify(response.body)]) { if (response.delayMs) await pause(response.delayMs, controller.signal); emit(Buffer.from(chunk)); }
        } else {
          const timeout = (model as { requestTimeoutMs?: number }).requestTimeoutMs ?? 20000;
          const upstream = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/${match[3]}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? raw : undefined, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]), redirect: "error" });
          entry.status = upstream.status;
          for (const key of ["content-type", "retry-after", "x-request-id"]) { const value = upstream.headers.get(key); if (value) entry.headers[key] = value; }
          res.writeHead(entry.status, entry.headers);
          if (upstream.body) {
            const reader = upstream.body.getReader();
            let bytes = 0;
            while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 128 * 1024 ** 2) throw new Error("Model response exceeds evidence limit"); emit(Buffer.from(chunk.value)); }
          }
        }
        res.end();
      } catch (error) {
        entry.error = String(error); this.errors.push(entry.error);
        if (!res.headersSent) { entry.status = 502; res.writeHead(502); res.end(JSON.stringify({ error: entry.error })); } else res.destroy();
      } finally { this.record(entry); }
      })().catch((error) => { this.errors.push(String(error)); if (!res.headersSent) res.writeHead(500); res.end("Relay failure"); }).finally(() => { this.controllers.delete(controller); });
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    });
  }
  async start(): Promise<string> { await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); }); const address = this.server.address(); if (!address || typeof address === "string") throw new Error("Relay address unavailable"); this.origin = `http://127.0.0.1:${address.port}`; return this.origin; }
  assertReplayComplete(): void { if (this.mode === "replay" && this.replayIndex !== this.replay.length) throw new Error("replay_divergence: unused recorded requests"); }
  async close(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    this.server.closeAllConnections();
    await Promise.all([new Promise<void>((r) => this.server.close(() => r())), ...this.pending]);
  }
}
